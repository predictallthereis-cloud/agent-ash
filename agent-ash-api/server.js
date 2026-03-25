const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

const ASSET_URL = 'https://courtyard.io/asset/8c99487dc8046491286671308b38df7a8e7da26a64cf5f4ae2f6d6c71ec71a52';
const SIX_HOURS = 6 * 60 * 60 * 1000;

// In-memory cache
let cachedPrice = {
  price: 374.00,
  source: 'fallback',
  updated: new Date().toISOString(),
};

app.use(cors());

// ── SCRAPER ──
async function scrapePrice() {
  console.log('[scraper] Starting browser...');
  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--disable-software-rasterizer',
      ],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    console.log('[scraper] Loading:', ASSET_URL);
    await page.goto(ASSET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    await page.waitForFunction(
      () => document.body.innerText.includes('$'),
      { timeout: 30000 }
    );

    // Extra wait for dynamic content
    await new Promise(r => setTimeout(r, 3000));

    const price = await page.evaluate(() => {
      // Strategy 1: Find the element containing "Market Value" and get the price next to it
      const allEls = [...document.querySelectorAll('*')];
      for (const el of allEls) {
        const text = el.textContent.trim();
        // Match elements whose own text (not children) contains "Market Value"
        const ownText = [...el.childNodes]
          .filter(n => n.nodeType === 3)
          .map(n => n.textContent).join('');
        if (/market\s*value/i.test(ownText) || (el.children.length === 0 && /market\s*value/i.test(text))) {
          // Look for a dollar amount in the parent or next sibling
          const parent = el.closest('div, section, li') || el.parentElement;
          if (parent) {
            const parentText = parent.textContent;
            const m = parentText.match(/Market\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
            if (m) return parseFloat(m[1].replace(/,/g, ''));
            // Also try: sibling or nearby dollar amount
            const dollarMatch = parentText.match(/\$([0-9,]+\.\d{2})/);
            if (dollarMatch) return parseFloat(dollarMatch[1].replace(/,/g, ''));
          }
        }
      }

      // Strategy 2: Regex on full page text for "Market Value" followed by price
      const bodyText = document.body.innerText;
      const mvMatch = bodyText.match(/Market\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
      if (mvMatch) return parseFloat(mvMatch[1].replace(/,/g, ''));

      // Strategy 3: "Market Value" on one line, price on the next
      const lines = bodyText.split('\n').map(l => l.trim());
      for (let i = 0; i < lines.length - 1; i++) {
        if (/market\s*value/i.test(lines[i])) {
          const nextPrice = lines[i+1].match(/\$([0-9,]+(?:\.\d{2})?)/);
          if (nextPrice) return parseFloat(nextPrice[1].replace(/,/g, ''));
        }
      }

      // Strategy 4: Last resort — "Estimated Value" or generic "Price"
      const evMatch = bodyText.match(/Est(?:imated)?\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
      if (evMatch) return parseFloat(evMatch[1].replace(/,/g, ''));

      return null;
    });

    if (price && price > 0) {
      cachedPrice = {
        price,
        source: 'Courtyard Market Value',
        updated: new Date().toISOString(),
      };
      console.log('[scraper] Success:', JSON.stringify(cachedPrice));
    } else {
      console.error('[scraper] Could not find price on page');
    }
  } catch (err) {
    console.error('[scraper] Error:', err.message);
  } finally {
    if (browser) await browser.close();
  }
}

// ── COURTYARD NFT HELPERS ──
const NFT_WALLET = '0x028Edd38341280e3e322D75C09b90E420572d21f';
const FETCH_TIMEOUT = 10000;
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

const POLYGONSCAN_URL = 'https://api.etherscan.io/v2/api'
  + '?chainid=137'
  + '&module=account&action=tokennfttx'
  + `&address=${NFT_WALLET}`
  + '&page=1&offset=200&sort=desc'
  + `&apikey=${process.env.POLYGONSCAN_API_KEY || ''}`;

// In-memory cards cache
let cachedCards = { count: 0, cards: [], source: 'none', updated: null };

function fetchWithTimeout(url, opts = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

async function fetchCourtyardCards() {
  // Get NFT transfer history from PolygonScan
  console.log('[courtyard] Fetching NFT transfers from PolygonScan...');
  const txRes = await fetchWithTimeout(POLYGONSCAN_URL);
  const txData = await txRes.json();

  if (txData.status !== '1' || !Array.isArray(txData.result)) {
    console.error('[courtyard] PolygonScan error:', txData.message || txData.result);
    throw new Error(`PolygonScan: ${txData.message || 'no results'}`);
  }

  console.log(`[courtyard] Got ${txData.result.length} total NFT transfers`);

  // Filter for Courtyard NFTs only
  const courtyardTxs = txData.result.filter(tx =>
    (tx.tokenName || '').toLowerCase().includes('courtyard')
  );
  console.log(`[courtyard] ${courtyardTxs.length} Courtyard transfers`);

  // Determine which tokenIDs are currently held (received - sent)
  const wallet = NFT_WALLET.toLowerCase();
  const held = new Map();

  // Process oldest-first to track current state
  const transfers = courtyardTxs.reverse();
  for (const tx of transfers) {
    const tokenId = tx.tokenID;
    if (tx.to.toLowerCase() === wallet) {
      held.set(tokenId, {
        tokenId,
        tokenName: tx.tokenName,
        contractAddress: tx.contractAddress,
      });
    } else if (tx.from.toLowerCase() === wallet) {
      held.delete(tokenId);
    }
  }

  const ownedTokens = [...held.values()];
  console.log(`[courtyard] Currently holds ${ownedTokens.length} NFTs:`, ownedTokens.map(t => t.tokenId));

  if (ownedTokens.length === 0) return [];

  // Try to fetch metadata for each token
  console.log(`[courtyard] Fetching metadata for ${ownedTokens.length} tokens...`);
  const cards = [];

  const META_URLS = [
    id => `https://api.courtyard.io/assets/${id}`,
    id => `https://courtyard.io/api/assets/${id}`,
  ];

  for (let i = 0; i < ownedTokens.length; i++) {
    const token = ownedTokens[i];
    let gotMeta = false;

    for (const urlFn of META_URLS) {
      try {
        const metaUrl = urlFn(token.tokenId);
        console.log(`[courtyard] Trying metadata: ${metaUrl}`);
        const metaRes = await fetchWithTimeout(metaUrl, {}, 5000);

        // Log details for the first token to debug response format
        if (i === 0) {
          const bodyText = await metaRes.clone().text();
          console.log(`[courtyard] DEBUG first token — status: ${metaRes.status}, body (200 chars): ${bodyText.slice(0, 200)}`);
        }

        if (metaRes.ok) {
          const meta = await metaRes.json();
          cards.push({
            tokenId: token.tokenId,
            name: meta.name || meta.title || token.tokenName || `Token #${token.tokenId}`,
            image: meta.image || meta.image_url || meta.imageUrl || null,
            grade: meta.grade || meta.psa_grade || meta.psaGrade
              || meta.attributes?.find(a => /grade|psa/i.test(a.trait_type || a.key || ''))?.value
              || meta.traits?.find(t => /grade|psa/i.test(t.trait_type || t.key || ''))?.value
              || null,
            attributes: meta.attributes || meta.traits || [],
          });
          console.log(`[courtyard] Got card: ${cards[cards.length - 1].name} | image: ${cards[cards.length - 1].image ? 'yes' : 'null'} | grade: ${cards[cards.length - 1].grade || 'null'}`);
          gotMeta = true;
          break;
        } else {
          console.log(`[courtyard] ${metaUrl} returned ${metaRes.status}`);
        }
      } catch (err) {
        console.error(`[courtyard] ${urlFn(token.tokenId)} failed:`, err.message);
      }
    }

    if (!gotMeta) {
      cards.push({
        tokenId: token.tokenId,
        name: token.tokenName || `Token #${token.tokenId}`,
        image: null, grade: null, attributes: [],
      });
    }
  }

  return cards;
}

async function refreshCards() {
  console.log('[courtyard] Refreshing cards cache...');
  try {
    const cards = await fetchCourtyardCards();
    cachedCards = {
      count: cards.length,
      cards,
      source: 'polygonscan',
      updated: new Date().toISOString(),
    };
    console.log(`[courtyard] Cache updated: ${cachedCards.count} cards`);
  } catch (err) {
    console.error('[courtyard] Refresh failed:', err.message, err.stack);
  }
}

// ── ROUTES ──
app.get('/price', (req, res) => {
  res.json(cachedPrice);
});

app.get('/courtyard-cards', (req, res) => {
  res.json(cachedCards);
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastUpdate: cachedPrice.updated });
});

// ── START ──
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);

  // Scrape price on startup + every 6 hours
  scrapePrice();
  setInterval(scrapePrice, SIX_HOURS);

  // Fetch NFT cards on startup + every 12 hours
  refreshCards();
  setInterval(refreshCards, TWELVE_HOURS);
});

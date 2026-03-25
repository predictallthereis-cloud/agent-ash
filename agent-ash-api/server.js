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

  // Fetch tokenURI + metadata for each token via Etherscan eth_call
  console.log(`[courtyard] Fetching metadata for ${ownedTokens.length} tokens...`);
  const apiKey = process.env.POLYGONSCAN_API_KEY || '';
  const cards = [];

  for (let i = 0; i < ownedTokens.length; i++) {
    const token = ownedTokens[i];
    const fallbackName = token.tokenName || `Token #${token.tokenId}`;

    try {
      // Call tokenURI(uint256) via Etherscan proxy
      const paddedId = BigInt(token.tokenId).toString(16).padStart(64, '0');
      const ethCallUrl = `https://api.etherscan.io/v2/api?chainid=137&module=proxy&action=eth_call&to=${token.contractAddress}&data=0xc87b56dd${paddedId}&tag=latest&apikey=${apiKey}`;
      console.log(`[courtyard] tokenURI eth_call for token ${token.tokenId}...`);
      const ethRes = await fetchWithTimeout(ethCallUrl, {}, 8000);
      const ethJson = await ethRes.json();

      if (!ethJson.result || ethJson.result === '0x' || ethJson.error) {
        console.log(`[courtyard] tokenURI call failed for ${token.tokenId}:`, ethJson.error || ethJson.result);
        throw new Error('empty result');
      }

      // Decode ABI-encoded string
      const hex = ethJson.result.replace('0x', '');
      const offset = parseInt(hex.slice(0, 64), 16) * 2;
      const length = parseInt(hex.slice(offset, offset + 64), 16);
      const tokenUri = Buffer.from(hex.slice(offset + 64, offset + 64 + length * 2), 'hex').toString('utf8');

      if (i === 0) console.log(`[courtyard] DEBUG first tokenURI: ${tokenUri}`);

      // Fetch metadata JSON from tokenURI
      console.log(`[courtyard] Fetching metadata for token ${token.tokenId}...`);
      const metaRes = await fetchWithTimeout(tokenUri, {}, 5000);
      if (!metaRes.ok) throw new Error(`metadata HTTP ${metaRes.status}`);
      const meta = await metaRes.json();

      const name = meta.name || fallbackName;
      const gradeMatch = name.match(/\((PSA|CGC|BGS|SGC)\s+(\d+(?:\.\d+)?)\s+([^)]+)\)/i);
      const grade = meta.grade || meta.psa_grade
        || meta.attributes?.find(a => /grade|psa/i.test(a.trait_type || ''))?.value
        || (gradeMatch ? `${gradeMatch[1]} ${gradeMatch[2]} ${gradeMatch[3]}`.trim() : null);

      cards.push({
        tokenId: token.tokenId,
        name,
        image: meta.image || meta.image_url || null,
        grade,
        contractAddress: token.contractAddress,
        attributes: meta.attributes || [],
      });
      console.log(`[courtyard] Got: ${name} | image: ${cards[cards.length - 1].image ? 'yes' : 'null'} | grade: ${grade || 'null'}`);
    } catch (err) {
      console.error(`[courtyard] Error for token ${token.tokenId}:`, err.message);
      const gradeMatch = fallbackName.match(/\((PSA|CGC|BGS|SGC)\s+(\d+(?:\.\d+)?)\s+([^)]+)\)/i);
      cards.push({
        tokenId: token.tokenId,
        name: fallbackName,
        image: null,
        grade: gradeMatch ? `${gradeMatch[1]} ${gradeMatch[2]} ${gradeMatch[3]}`.trim() : null,
        contractAddress: token.contractAddress,
        attributes: [],
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

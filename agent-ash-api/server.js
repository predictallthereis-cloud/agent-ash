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
const COURTYARD_CONTRACT = '0x581425c638882bd8169dae6f2995878927c9fe70';
const NFT_WALLET = '0x028Edd38341280e3e322D75C09b90E420572d21f';
const FETCH_TIMEOUT = 10000;
const TWELVE_HOURS = 12 * 60 * 60 * 1000;

// In-memory cards cache
let cachedCards = { count: 0, cards: [], source: 'none', updated: null };

function fetchWithTimeout(url, opts = {}, timeout = FETCH_TIMEOUT) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  return fetch(url, { ...opts, signal: controller.signal })
    .finally(() => clearTimeout(timer));
}

function parseOpenSeaNFTs(data) {
  if (!data.nfts || !Array.isArray(data.nfts)) return [];
  return data.nfts.map(nft => ({
    tokenId: nft.identifier || nft.token_id,
    name: nft.name || nft.title || `Token #${nft.identifier || nft.token_id}`,
    image: nft.image_url || nft.display_image_url || nft.metadata?.image || null,
    grade: nft.traits?.find(t => /grade|psa/i.test(t.trait_type || ''))?.value
      || nft.metadata?.attributes?.find(a => /grade|psa/i.test(a.trait_type || ''))?.value
      || null,
    attributes: nft.traits || nft.metadata?.attributes || [],
  }));
}

function parseAlchemyNFTs(data) {
  if (!data.ownedNfts || !Array.isArray(data.ownedNfts)) return [];
  return data.ownedNfts.map(nft => ({
    tokenId: nft.tokenId,
    name: nft.name || nft.title || nft.raw?.metadata?.name || `Token #${nft.tokenId}`,
    image: nft.image?.cachedUrl || nft.image?.originalUrl || nft.raw?.metadata?.image || null,
    grade: nft.raw?.metadata?.attributes?.find(a => /grade|psa/i.test(a.trait_type || ''))?.value || null,
    attributes: nft.raw?.metadata?.attributes || [],
  }));
}

async function fetchCourtyardCards() {
  // Strategy 1: OpenSea API (no key required)
  try {
    const openSeaUrl = `https://api.opensea.io/api/v2/chain/matic/account/${NFT_WALLET}/nfts?collection=courtyard-io&limit=50`;
    console.log('[courtyard] Trying OpenSea API...');
    const res = await fetchWithTimeout(openSeaUrl, {
      headers: { 'accept': 'application/json' },
    });
    if (res.ok) {
      const data = await res.json();
      const cards = parseOpenSeaNFTs(data);
      console.log(`[courtyard] OpenSea returned ${cards.length} NFTs`);
      if (cards.length > 0) return { source: 'opensea', cards };
    } else {
      console.log(`[courtyard] OpenSea returned ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.error('[courtyard] OpenSea failed:', err.message);
  }

  // Strategy 2: Alchemy free NFT API
  try {
    const alchemyUrl = `https://polygon-mainnet.g.alchemy.com/nft/v3/demo/getNFTsForOwner`
      + `?owner=${NFT_WALLET}`
      + `&contractAddresses[]=${COURTYARD_CONTRACT}`
      + `&withMetadata=true`;
    console.log('[courtyard] Trying Alchemy API...');
    const res = await fetchWithTimeout(alchemyUrl);
    if (res.ok) {
      const data = await res.json();
      const cards = parseAlchemyNFTs(data);
      console.log(`[courtyard] Alchemy returned ${cards.length} NFTs`);
      if (cards.length > 0) return { source: 'alchemy', cards };
    } else {
      console.log(`[courtyard] Alchemy returned ${res.status}: ${await res.text().catch(() => '')}`);
    }
  } catch (err) {
    console.error('[courtyard] Alchemy failed:', err.message);
  }

  throw new Error('All NFT API sources failed (OpenSea, Alchemy)');
}

async function refreshCards() {
  console.log('[courtyard] Refreshing cards cache...');
  try {
    const result = await fetchCourtyardCards();
    cachedCards = {
      count: result.cards.length,
      cards: result.cards,
      source: result.source,
      updated: new Date().toISOString(),
    };
    console.log(`[courtyard] Cache updated: ${cachedCards.count} cards from ${cachedCards.source}`);
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

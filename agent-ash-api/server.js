const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');

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

// ── POLYGON RPC HELPERS ──
const POLYGON_RPC = 'https://polygon-rpc.com';
const COURTYARD_CONTRACT = '0x581425c638882bd8169dae6f2995878927c9fe70';
const NFT_WALLET = '0x028Edd38341280e3e322D75C09b90E420572d21f';

async function polygonCall(data) {
  const res = await fetch(POLYGON_RPC, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'eth_call', params: [data, 'latest'] }),
  });
  const json = await res.json();
  if (json.error) throw new Error(json.error.message);
  return json.result;
}

function padAddress(addr) {
  return addr.toLowerCase().replace('0x', '').padStart(64, '0');
}

function padUint256(n) {
  return n.toString(16).padStart(64, '0');
}

async function fetchCourtyardCards() {
  const wallet = padAddress(NFT_WALLET);

  // 1. balanceOf(address) — 0x70a08231
  const balanceHex = await polygonCall({
    to: COURTYARD_CONTRACT,
    data: '0x70a08231' + wallet,
  });
  const balance = parseInt(balanceHex, 16);
  console.log(`[courtyard] Wallet holds ${balance} NFTs`);

  if (balance === 0) return [];

  // 2. tokenOfOwnerByIndex(address, index) — 0x2f745c59
  const tokenIds = [];
  for (let i = 0; i < balance; i++) {
    const result = await polygonCall({
      to: COURTYARD_CONTRACT,
      data: '0x2f745c59' + wallet + padUint256(i),
    });
    tokenIds.push(BigInt(result).toString());
  }
  console.log(`[courtyard] Token IDs:`, tokenIds);

  // 3. tokenURI(uint256) — 0xc87b56dd for each token
  const cards = [];
  for (const tokenId of tokenIds) {
    try {
      const uriHex = await polygonCall({
        to: COURTYARD_CONTRACT,
        data: '0xc87b56dd' + padUint256(Number(tokenId)),
      });

      // Decode ABI-encoded string: offset (32 bytes) + length (32 bytes) + data
      const stripped = uriHex.replace('0x', '');
      const offset = parseInt(stripped.slice(0, 64), 16) * 2;
      const length = parseInt(stripped.slice(offset, offset + 64), 16);
      const hexStr = stripped.slice(offset + 64, offset + 64 + length * 2);
      const uri = Buffer.from(hexStr, 'hex').toString('utf8');

      // Fetch metadata JSON
      const metaRes = await fetch(uri);
      const meta = await metaRes.json();

      cards.push({
        tokenId,
        name: meta.name || `Token #${tokenId}`,
        image: meta.image || null,
        grade: meta.attributes?.find(a => /grade|psa/i.test(a.trait_type))?.value || null,
        attributes: meta.attributes || [],
      });
    } catch (err) {
      console.error(`[courtyard] Error fetching token ${tokenId}:`, err.message);
      cards.push({ tokenId, name: `Token #${tokenId}`, image: null, grade: null, attributes: [] });
    }
  }

  return cards;
}

// ── ROUTES ──
app.get('/price', (req, res) => {
  res.json(cachedPrice);
});

app.get('/courtyard-cards', async (req, res) => {
  try {
    const cards = await fetchCourtyardCards();
    res.json({ count: cards.length, cards });
  } catch (err) {
    console.error('[courtyard] Endpoint error:', err.message);
    res.status(500).json({ error: err.message });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastUpdate: cachedPrice.updated });
});

// ── START ──
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);

  // Scrape on startup
  scrapePrice();

  // Re-scrape every 6 hours
  setInterval(scrapePrice, SIX_HOURS);
});

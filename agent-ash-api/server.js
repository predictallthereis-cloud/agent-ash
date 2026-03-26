const express = require('express');
const cors = require('cors');
const puppeteer = require('puppeteer');
const fetch = require('node-fetch');

const app = express();
const PORT = process.env.PORT || 3001;

const ASSET_URL = 'https://courtyard.io/asset/8c99487dc8046491286671308b38df7a8e7da26a64cf5f4ae2f6d6c71ec71a52';
const SIX_HOURS = 6 * 60 * 60 * 1000;

// In-memory caches
let cachedPrice = {
  price: 374.00,
  source: 'fallback',
  updated: new Date().toISOString(),
};

let cachedPrices = {
  prices: {},
  total: 0,
  updated: null,
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

// ── SCRAPE ALL CARD PRICES ──
async function scrapePriceFromPage(page, url) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 90000 });
  await page.waitForFunction(
    () => document.body.innerText.includes('$'),
    { timeout: 30000 }
  ).catch(() => {});
  await new Promise(r => setTimeout(r, 3000));

  return page.evaluate(() => {
    // Strategy 1: DOM traversal for "Market Value"
    const allEls = [...document.querySelectorAll('*')];
    for (const el of allEls) {
      const text = el.textContent.trim();
      const ownText = [...el.childNodes]
        .filter(n => n.nodeType === 3)
        .map(n => n.textContent).join('');
      if (/market\s*value/i.test(ownText) || (el.children.length === 0 && /market\s*value/i.test(text))) {
        const parent = el.closest('div, section, li') || el.parentElement;
        if (parent) {
          const m = parent.textContent.match(/Market\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
          if (m) return parseFloat(m[1].replace(/,/g, ''));
          const d = parent.textContent.match(/\$([0-9,]+\.\d{2})/);
          if (d) return parseFloat(d[1].replace(/,/g, ''));
        }
      }
    }
    // Strategy 2: Full text regex
    const bodyText = document.body.innerText;
    const mv = bodyText.match(/Market\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
    if (mv) return parseFloat(mv[1].replace(/,/g, ''));
    // Strategy 3: Next line
    const lines = bodyText.split('\n').map(l => l.trim());
    for (let i = 0; i < lines.length - 1; i++) {
      if (/market\s*value/i.test(lines[i])) {
        const np = lines[i+1].match(/\$([0-9,]+(?:\.\d{2})?)/);
        if (np) return parseFloat(np[1].replace(/,/g, ''));
      }
    }
    // Strategy 4: Estimated Value
    const ev = bodyText.match(/Est(?:imated)?\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
    if (ev) return parseFloat(ev[1].replace(/,/g, ''));
    return null;
  });
}

async function scrapeAllPrices() {
  // Use the cached cards list
  const cards = cachedCards.cards || [];
  if (cards.length === 0) {
    console.log('[prices] No cards in cache, skipping price scrape');
    return;
  }

  const cardsWithUrl = cards.filter(c => c.external_url);
  console.log(`[prices] Scraping prices for ${cardsWithUrl.length}/${cards.length} cards with external_url...`);

  let browser;
  try {
    browser = await puppeteer.launch({
      headless: true,
      args: ['--no-sandbox', '--disable-setuid-sandbox', '--disable-dev-shm-usage', '--disable-gpu', '--disable-software-rasterizer'],
    });

    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    const prices = {};
    let total = 0;
    let success = 0;

    for (let i = 0; i < cardsWithUrl.length; i++) {
      const card = cardsWithUrl[i];
      // Delay between scrapes to not hammer Courtyard
      if (i > 0) await new Promise(r => setTimeout(r, 3000));

      let price = null;
      for (let attempt = 1; attempt <= 2; attempt++) {
        try {
          console.log(`[prices] (${i + 1}/${cardsWithUrl.length}) attempt ${attempt} — ${card.name.slice(0, 50)}...`);
          price = await scrapePriceFromPage(page, card.external_url);
          if (price && price > 0) {
            console.log(`[prices] OK: $${price.toFixed(2)}`);
            break;
          }
          console.log(`[prices] No price found on page`);
        } catch (err) {
          console.error(`[prices] attempt ${attempt} FAIL: ${err.message}`);
          if (attempt < 2) {
            console.log(`[prices] Retrying in 5s...`);
            await new Promise(r => setTimeout(r, 5000));
          }
        }
      }

      if (price && price > 0) {
        prices[card.tokenId] = { price, name: card.name };
        total += price;
        success++;
      } else {
        prices[card.tokenId] = { price: null, name: card.name };
      }
    }

    // Also include cards without external_url as null
    for (const card of cards) {
      if (!prices[card.tokenId]) {
        prices[card.tokenId] = { price: null, name: card.name };
      }
    }

    cachedPrices = {
      prices,
      total,
      count: cards.length,
      scraped: success,
      updated: new Date().toISOString(),
    };

    // Also update the legacy single-price cache with the Pikachu price if found
    for (const [tokenId, info] of Object.entries(prices)) {
      if (info.price && /pikachu/i.test(info.name) && /dream league/i.test(info.name)) {
        cachedPrice = { price: info.price, source: 'Courtyard Market Value', updated: new Date().toISOString() };
        break;
      }
    }

    console.log(`[prices] Done: ${success}/${cardsWithUrl.length} scraped, total $${total.toFixed(2)}`);
  } catch (err) {
    console.error('[prices] Browser error:', err.message);
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

  async function fetchTokenMetadata(token) {
    const paddedId = BigInt(token.tokenId).toString(16).padStart(64, '0');
    const ethCallUrl = `https://api.etherscan.io/v2/api?chainid=137&module=proxy&action=eth_call&to=${token.contractAddress}&data=0xc87b56dd${paddedId}&tag=latest&apikey=${apiKey}`;
    const ethRes = await fetchWithTimeout(ethCallUrl, {}, 8000);
    const ethJson = await ethRes.json();

    if (!ethJson.result || ethJson.result === '0x' || ethJson.error) {
      throw new Error(`eth_call: ${ethJson.error?.message || ethJson.result || 'empty'}`);
    }

    // Decode ABI-encoded string
    const hex = ethJson.result.replace('0x', '');
    const offset = parseInt(hex.slice(0, 64), 16) * 2;
    const length = parseInt(hex.slice(offset, offset + 64), 16);
    const tokenUri = Buffer.from(hex.slice(offset + 64, offset + 64 + length * 2), 'hex').toString('utf8');

    // Fetch metadata JSON from tokenURI
    const metaRes = await fetchWithTimeout(tokenUri, {}, 5000);
    if (!metaRes.ok) throw new Error(`metadata HTTP ${metaRes.status}`);
    const meta = await metaRes.json();

    const name = meta.name || token.tokenName || `Token #${token.tokenId}`;
    const gradeMatch = name.match(/\((PSA|CGC|BGS|SGC)\s+(\d+(?:\.\d+)?)\s+([^)]+)\)/i);
    const grade = meta.grade || meta.psa_grade
      || meta.attributes?.find(a => /grade|psa/i.test(a.trait_type || ''))?.value
      || (gradeMatch ? `${gradeMatch[1]} ${gradeMatch[2]} ${gradeMatch[3]}`.trim() : null);

    return {
      tokenId: token.tokenId,
      name,
      image: meta.image || meta.image_url || null,
      grade,
      contractAddress: token.contractAddress,
      attributes: meta.attributes || [],
      external_url: meta.external_url || null,
    };
  }

  function isIncomplete(card) {
    return card.name === 'Courtyard' || card.name.startsWith('Token #') || (!card.image && !card.grade);
  }

  // First pass: 200ms delay between calls to respect rate limit
  for (let i = 0; i < ownedTokens.length; i++) {
    const token = ownedTokens[i];
    if (i > 0) await new Promise(r => setTimeout(r, 200));

    try {
      console.log(`[courtyard] [pass 1] token ${token.tokenId} (${i + 1}/${ownedTokens.length})...`);
      const card = await fetchTokenMetadata(token);
      cards.push(card);
      console.log(`[courtyard] [pass 1] OK: ${card.name} | image: ${card.image ? 'yes' : 'null'} | grade: ${card.grade || 'null'}`);
    } catch (err) {
      console.error(`[courtyard] [pass 1] FAIL token ${token.tokenId}: ${err.message}`);
      const fallbackName = token.tokenName || `Token #${token.tokenId}`;
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

  // Retry pass: find incomplete cards and retry with 500ms delay
  const failedIndices = cards
    .map((card, idx) => isIncomplete(card) ? idx : -1)
    .filter(idx => idx !== -1);

  if (failedIndices.length > 0) {
    console.log(`[courtyard] [retry] ${failedIndices.length} incomplete cards, retrying...`);
    for (let j = 0; j < failedIndices.length; j++) {
      const idx = failedIndices[j];
      const token = ownedTokens[idx];
      if (j > 0) await new Promise(r => setTimeout(r, 500));

      try {
        console.log(`[courtyard] [retry] token ${token.tokenId} (${j + 1}/${failedIndices.length})...`);
        const card = await fetchTokenMetadata(token);
        cards[idx] = card;
        console.log(`[courtyard] [retry] OK: ${card.name} | image: ${card.image ? 'yes' : 'null'} | grade: ${card.grade || 'null'}`);
      } catch (err) {
        console.error(`[courtyard] [retry] FAIL token ${token.tokenId}: ${err.message}`);
      }
    }
  }

  const successCount = cards.filter(c => !isIncomplete(c)).length;
  console.log(`[courtyard] Done: ${successCount}/${cards.length} cards with full metadata`);

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

// ── ACTIVITY ──
let cachedActivity = { activity: [], count: 0, updated: null };

async function refreshActivity() {
  console.log('[activity] Refreshing activity...');
  const apiKey = process.env.POLYGONSCAN_API_KEY || '';
  const base = 'https://api.etherscan.io/v2/api';
  const wallet = NFT_WALLET.toLowerCase();

  try {
    const [nftRes, erc20Res] = await Promise.all([
      fetchWithTimeout(`${base}?chainid=137&module=account&action=tokennfttx&address=${NFT_WALLET}&page=1&offset=200&sort=desc&apikey=${apiKey}`),
      fetchWithTimeout(`${base}?chainid=137&module=account&action=tokentx&address=${NFT_WALLET}&page=1&offset=200&sort=desc&apikey=${apiKey}`),
    ]);

    const nftData = await nftRes.json();
    const erc20Data = await erc20Res.json();

    const nftTxs = (nftData.status === '1' && Array.isArray(nftData.result)) ? nftData.result : [];
    const erc20Txs = (erc20Data.status === '1' && Array.isArray(erc20Data.result)) ? erc20Data.result : [];

    // Build card name lookup from cached cards + transfer tokenName fallback
    const cardNames = {};
    for (const card of (cachedCards.cards || [])) {
      cardNames[card.tokenId] = card.name;
    }

    // USDC contract addresses (both native and bridged)
    const USDC_ADDRS = new Set([
      '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359',
      '0x2791bca1f2de4661ed88a30c99a7a9449aa84174',
    ]);

    // Group ERC-20 transfers by tx hash
    const erc20ByHash = {};
    for (const tx of erc20Txs) {
      const hash = tx.hash.toLowerCase();
      if (!erc20ByHash[hash]) erc20ByHash[hash] = [];
      erc20ByHash[hash].push(tx);
    }

    // Group NFT transfers by tx hash
    const nftByHash = {};
    for (const tx of nftTxs) {
      if (!(tx.tokenName || '').toLowerCase().includes('courtyard')) continue;
      const hash = tx.hash.toLowerCase();
      if (!nftByHash[hash]) nftByHash[hash] = [];
      nftByHash[hash].push(tx);
    }

    // Collect all unique tx hashes
    const allHashes = new Set([...Object.keys(nftByHash), ...Object.keys(erc20ByHash)]);
    const processedHashes = new Set();
    const activity = [];

    // Process NFT transactions first (may merge with ERC-20)
    for (const hash of Object.keys(nftByHash)) {
      processedHashes.add(hash);
      const nfts = nftByHash[hash];
      const erc20s = erc20ByHash[hash] || [];

      // Find USDC transfers in this tx
      const usdcTxs = erc20s.filter(t => USDC_ADDRS.has(t.contractAddress.toLowerCase()));
      let usdcAmount = 0;
      let usdcDirection = null;
      for (const ut of usdcTxs) {
        const amt = parseInt(ut.value || '0') / 1e6;
        if (amt > 0) {
          usdcAmount += amt;
          usdcDirection = ut.from.toLowerCase() === wallet ? 'out' : 'in';
        }
      }

      for (const nft of nfts) {
        const nftToUs = nft.to.toLowerCase() === wallet;
        const nftFromZero = nft.from.toLowerCase() === '0x0000000000000000000000000000000000000000';
        const tokenId = nft.tokenID;
        const cardName = cardNames[tokenId] || nft.tokenName || `Token #${tokenId}`;

        let type;
        if (nftToUs && usdcAmount > 0 && usdcDirection === 'out') {
          type = nftFromZero ? 'mint' : 'trade';
        } else if (!nftToUs && usdcAmount > 0 && usdcDirection === 'in') {
          type = 'trade';
        } else if (nftToUs) {
          type = 'receive';
        } else {
          type = 'send';
        }

        const counterparty = nftToUs ? nft.from : nft.to;

        activity.push({
          type,
          cardName,
          tokenId,
          amount: usdcAmount > 0 ? usdcAmount : null,
          direction: nftToUs ? 'in' : 'out',
          hash: nft.hash,
          counterparty,
          timestamp: parseInt(nft.timeStamp || '0'),
        });
      }
    }

    // Process standalone ERC-20 transfers (no matching NFT)
    for (const hash of Object.keys(erc20ByHash)) {
      if (processedHashes.has(hash)) continue;
      const erc20s = erc20ByHash[hash];

      for (const tx of erc20s) {
        if (!USDC_ADDRS.has(tx.contractAddress.toLowerCase())) continue;
        const amt = parseInt(tx.value || '0') / 1e6;
        if (amt <= 0) continue;

        const isOut = tx.from.toLowerCase() === wallet;
        activity.push({
          type: isOut ? 'send' : 'receive',
          cardName: null,
          tokenId: null,
          amount: amt,
          direction: isOut ? 'out' : 'in',
          hash: tx.hash,
          counterparty: isOut ? tx.to : tx.from,
          timestamp: parseInt(tx.timeStamp || '0'),
        });
      }
    }

    // Sort newest first
    activity.sort((a, b) => b.timestamp - a.timestamp);

    // Count unique hashes
    const uniqueHashes = new Set(activity.map(a => a.hash.toLowerCase()));

    cachedActivity = { activity, count: uniqueHashes.size, updated: new Date().toISOString() };
    console.log(`[activity] Cached ${activity.length} items (${uniqueHashes.size} unique txns)`);
  } catch (err) {
    console.error('[activity] Refresh failed:', err.message);
  }
}

// ── ROUTES ──
app.get('/price', (req, res) => {
  res.json(cachedPrice);
});

app.get('/courtyard-cards', (req, res) => {
  res.json(cachedCards);
});

app.get('/prices', (req, res) => {
  res.json(cachedPrices);
});

app.get('/activity', (req, res) => {
  res.json(cachedActivity);
});

// ── POLYGON BALANCE via PolygonScan API ──
const POLYGON_WALLET_ADDR = '0x028Edd38341280e3e322D75C09b90E420572d21f';
const POLYGON_USDC_NATIVE = '0x3c499c542cEF5E3811e1192ce70d8cC03d5c3359';
const POLYGON_USDC_BRIDGED = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174'; // USDC.e

app.get('/polygon-balance', async (req, res) => {
  const apiKey = process.env.POLYGONSCAN_API_KEY || '';
  const base = 'https://api.etherscan.io/v2/api';

  try {
    const [polRes, usdcNativeRes, usdcBridgedRes] = await Promise.all([
      fetch(`${base}?chainid=137&module=account&action=balance&address=${POLYGON_WALLET_ADDR}&tag=latest&apikey=${apiKey}`),
      fetch(`${base}?chainid=137&module=account&action=tokenbalance&contractaddress=${POLYGON_USDC_NATIVE}&address=${POLYGON_WALLET_ADDR}&tag=latest&apikey=${apiKey}`),
      fetch(`${base}?chainid=137&module=account&action=tokenbalance&contractaddress=${POLYGON_USDC_BRIDGED}&address=${POLYGON_WALLET_ADDR}&tag=latest&apikey=${apiKey}`),
    ]);

    const polData = await polRes.json();
    const usdcNativeData = await usdcNativeRes.json();
    const usdcBridgedData = await usdcBridgedRes.json();

    const polBal = Number(BigInt(polData.result || '0')) / 1e18;
    const usdcNative = Number(BigInt(usdcNativeData.result || '0')) / 1e6;
    const usdcBridged = Number(BigInt(usdcBridgedData.result || '0')) / 1e6;
    const usdcBal = usdcNative + usdcBridged;

    console.log(`[polygon] POL: ${polBal.toFixed(18)}, USDC native: ${usdcNative.toFixed(6)}, USDC.e: ${usdcBridged.toFixed(6)}, total: ${usdcBal.toFixed(6)}`);
    res.json({ pol: polBal, usdc: usdcBal, usdcNative, usdcBridged, updated: new Date().toISOString() });
  } catch (err) {
    console.error('[polygon] Balance fetch failed:', err.message);
    res.status(500).json({ error: err.message, pol: 0, usdc: 0 });
  }
});

app.get('/health', (req, res) => {
  res.json({ status: 'ok', lastUpdate: cachedPrice.updated });
});

// ── START ──
app.listen(PORT, () => {
  console.log(`[server] Listening on port ${PORT}`);

  // Fetch NFT cards first, then scrape prices + build activity
  refreshCards().then(() => {
    scrapeAllPrices();
    refreshActivity();
  });

  // Also run legacy single-card scrape for backwards compat
  scrapePrice();

  // Re-scrape prices every 6 hours, refresh cards + activity every 12 hours
  setInterval(scrapePrice, SIX_HOURS);
  setInterval(async () => {
    await refreshCards();
    scrapeAllPrices();
    refreshActivity();
  }, TWELVE_HOURS);
});

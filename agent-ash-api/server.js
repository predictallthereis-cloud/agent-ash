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
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || '/opt/render/.cache/puppeteer/chrome/linux-146.0.7680.76/chrome-linux64/chrome',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
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
      const bodyText = document.body.innerText;

      const mvMatch = bodyText.match(/Market\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
      if (mvMatch) return parseFloat(mvMatch[1].replace(/,/g, ''));

      const evMatch = bodyText.match(/Est(?:imated)?\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
      if (evMatch) return parseFloat(evMatch[1].replace(/,/g, ''));

      const priceMatch = bodyText.match(/Price[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
      if (priceMatch) return parseFloat(priceMatch[1].replace(/,/g, ''));

      const allPrices = [...document.querySelectorAll('*')].reduce((found, el) => {
        const text = el.textContent.trim();
        const m = text.match(/^\$([0-9,]+\.\d{2})$/);
        if (m) {
          const val = parseFloat(m[1].replace(/,/g, ''));
          if (val > 50 && val < 50000) found.push(val);
        }
        return found;
      }, []);

      if (allPrices.length > 0) return allPrices[0];
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

// ── ROUTES ──
app.get('/price', (req, res) => {
  res.json(cachedPrice);
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

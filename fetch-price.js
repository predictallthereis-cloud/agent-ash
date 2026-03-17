const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');

const ASSET_URL = 'https://courtyard.io/asset/8c99487dc8046491286671308b38df7a8e7da26a64cf5f4ae2f6d6c71ec71a52';
const OUTPUT = path.join(__dirname, 'price.json');

(async () => {
  console.log('[fetch-price] Starting browser...');
  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox'],
  });

  try {
    const page = await browser.newPage();
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );

    console.log('[fetch-price] Loading:', ASSET_URL);
    await page.goto(ASSET_URL, { waitUntil: 'networkidle2', timeout: 60000 });

    // Wait for price-related content to render
    await page.waitForFunction(
      () => document.body.innerText.includes('$'),
      { timeout: 30000 }
    );

    // Extra wait for dynamic content to settle
    await new Promise(r => setTimeout(r, 3000));

    // Try multiple strategies to find the Market Value price
    const price = await page.evaluate(() => {
      const bodyText = document.body.innerText;

      // Strategy 1: Look for "Market Value" label followed by a price
      const mvMatch = bodyText.match(/Market\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
      if (mvMatch) return parseFloat(mvMatch[1].replace(/,/g, ''));

      // Strategy 2: Look for "Estimated Value" or "Est. Value"
      const evMatch = bodyText.match(/Est(?:imated)?\s*Value[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
      if (evMatch) return parseFloat(evMatch[1].replace(/,/g, ''));

      // Strategy 3: Look for "Price" label near a dollar amount
      const priceMatch = bodyText.match(/Price[:\s]*\$([0-9,]+(?:\.\d{2})?)/i);
      if (priceMatch) return parseFloat(priceMatch[1].replace(/,/g, ''));

      // Strategy 4: Find all dollar amounts on the page, return the most prominent
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
      const result = {
        price,
        source: 'Courtyard Market Value',
        updated: new Date().toISOString(),
      };

      fs.writeFileSync(OUTPUT, JSON.stringify(result, null, 2));
      console.log('[fetch-price] Saved:', JSON.stringify(result));
    } else {
      // Dump visible text for debugging
      const text = await page.evaluate(() => document.body.innerText.slice(0, 2000));
      console.error('[fetch-price] Could not find price. Page text preview:');
      console.error(text);
      process.exitCode = 1;
    }
  } catch (err) {
    console.error('[fetch-price] Error:', err.message);
    process.exitCode = 1;
  } finally {
    await browser.close();
    console.log('[fetch-price] Done.');
  }
})();

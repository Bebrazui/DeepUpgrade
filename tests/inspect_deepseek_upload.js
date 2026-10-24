const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  try {
    console.log('Navigating to chat.deepseek.com...');
    await page.goto('https://chat.deepseek.com', { waitUntil: 'load', timeout: 25000 });
    await page.waitForTimeout(4000);

    const bodyText = await page.evaluate(() => document.body.innerText);
    console.log('Page title:', await page.title());
    console.log('Body length:', bodyText.length);
    console.log('Body snippet:', bodyText.slice(0, 300));

    // Check if there are any buttons or inputs anywhere
    const stats = await page.evaluate(() => {
      return {
        allTags: Array.from(document.querySelectorAll('*')).map(e => e.tagName.toLowerCase()).filter((v, i, a) => a.indexOf(v) === i),
        inputs: Array.from(document.querySelectorAll('input')).map(i => i.outerHTML),
        textareas: Array.from(document.querySelectorAll('textarea')).map(t => t.outerHTML),
        buttons: Array.from(document.querySelectorAll('button, div[role="button"]')).map(b => b.innerText || b.getAttribute('aria-label') || b.className)
      };
    });
    console.log('DOM Stats:', JSON.stringify(stats, null, 2));

  } catch (err) {
    console.error('ERR:', err.message);
  } finally {
    await browser.close();
  }
})();

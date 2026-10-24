const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('https://chat.deepseek.com', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(8000);
  const info = await page.evaluate(() => {
    const textareas = [...document.querySelectorAll('textarea')].map(t => ({ cls: t.className, visible: t.offsetParent !== null, ph: t.placeholder }));
    const editables = [...document.querySelectorAll('[contenteditable="true"]')].map(t => ({ tag: t.tagName, cls: t.className, ph: t.getAttribute('data-placeholder') || t.getAttribute('placeholder') }));
    const roleBtns = [...document.querySelectorAll('div[role="button"]')].map(b => ({ cls: (b.className || '').slice(0, 120), ad: b.getAttribute('aria-disabled') }));
    return {
      title: document.title,
      bodySnippet: document.body.innerText.slice(0, 400).replace(/\n+/g, ' | '),
      textareas, editables, roleBtns: roleBtns.slice(0, 12)
    };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

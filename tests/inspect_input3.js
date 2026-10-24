const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: false, channel: 'chrome' });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('https://chat.deepseek.com', { waitUntil: 'load', timeout: 40000 }).catch(() => {});
  await page.waitForTimeout(9000);
  const info = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    const editables = [...document.querySelectorAll('[contenteditable="true"]')].map(t => ({ tag: t.tagName, cls: t.className }));
    if (!ta) return { error: 'no textarea', title: document.title, snippet: document.body.innerText.slice(0, 200), editables };
    // container of input area
    const bar = ta.closest('div[class]');
    const btns = [...document.querySelectorAll('div[role="button"]')].map(b => ({
      cls: (b.className || '').toString().slice(0, 150),
      ad: b.getAttribute('aria-disabled'),
      inBar: !!(bar && bar.contains(b)),
      hasSvg: !!b.querySelector('svg'),
      svgPath: (b.querySelector('svg path') || {}).getAttribute ? (b.querySelector('svg path')||{}).getAttribute('d') : null
    }));
    return { taCls: ta.className, taPh: ta.placeholder, barCls: bar ? bar.className : null, btns };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

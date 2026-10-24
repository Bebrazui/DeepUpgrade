const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
  await page.goto('https://chat.deepseek.com', { waitUntil: 'load', timeout: 30000 });
  await page.waitForTimeout(5000);
  const info = await page.evaluate(() => {
    const ta = document.querySelector('textarea');
    if (!ta) return { error: 'no textarea' };
    const parentChain = [];
    let p = ta.parentElement;
    for (let i = 0; i < 5 && p; i++) { parentChain.push(p.tagName + '.' + (p.className && p.className.baseVal !== undefined ? p.className.baseVal : p.className)); p = p.parentElement; }
    // all role=button elements in bottom area
    const btns = [...document.querySelectorAll('div[role="button"]')].map(b => ({
      cls: b.className,
      ariaDisabled: b.getAttribute('aria-disabled'),
      html: b.outerHTML.slice(0, 300)
    }));
    return { taClass: ta.className, taParent: ta.parentElement.className, parentChain, btnCount: btns.length, btns };
  });
  console.log(JSON.stringify(info, null, 2));
  await browser.close();
})().catch(e => { console.error('ERR', e.message); process.exit(1); });

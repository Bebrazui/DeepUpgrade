// Project plate layout regression test.
//
// In a populated chat DeepSeek renders the composer inside a wide footer, while
// the native card stays a centered, narrower element. The project bar used to
// take 100% of the footer width, which made it look like a flat dark strip and
// clipped the input card. This test loads the real geometry sync helper and
// asserts the plate always matches the card's box.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const CONTENT_PATH = path.resolve(__dirname, '..', 'extension', 'content.js');

function extractPlateHelper(source) {
  const start = source.indexOf('// <du-project-plate>');
  const end = source.indexOf('// </du-project-plate>');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not find <du-project-plate> markers in content.js');
  }
  return source.slice(start, end);
}

const PLATE_HELPER = extractPlateHelper(fs.readFileSync(CONTENT_PATH, 'utf8'));

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

const SETUP = function () {
  document.body.innerHTML = '';
  document.body.style.margin = '0';

  const footer = document.createElement('div');
  footer.id = 'footer';
  footer.style.cssText = 'width:100%;padding:0 24px;box-sizing:border-box;background:#212327';

  const card = document.createElement('div');
  card.id = 'card';
  card.style.cssText = 'width:600px;max-width:100%;height:80px;margin:0 auto;background:#2b2d31;border:1px solid #3a3c42;border-radius:22px;box-sizing:border-box';

  const bar = document.createElement('div');
  bar.id = 'bar';
  bar.style.cssText = 'position:relative;height:36px;box-sizing:border-box';

  footer.appendChild(bar);
  footer.appendChild(card);
  document.body.appendChild(footer);

  window.__card = card;
  window.__bar = bar;
  return true;
};

const MEASURE = function () {
  const card = window.__card.getBoundingClientRect();
  const bar = window.__bar.getBoundingClientRect();
  return {
    cardWidth: Math.round(card.width),
    barWidth: Math.round(bar.width),
    cardLeft: Math.round(card.left),
    barLeft: Math.round(bar.left),
    radiusVar: window.__bar.style.getPropertyValue('--du-plate-radius'),
    borderVar: window.__bar.style.getPropertyValue('--du-plate-border')
  };
};

const nextFrames = function (count) {
  return new Promise((resolve) => {
    let left = count;
    const tick = () => (--left <= 0 ? resolve() : requestAnimationFrame(tick));
    requestAnimationFrame(tick);
  });
};

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.addScriptTag({ content: PLATE_HELPER });
    await page.evaluate(SETUP);

    console.log('centered narrow card in a wide footer');
    await page.evaluate(() => {
      window.syncProjectBarGeometry(window.__bar, window.__card);
      return new Promise((r) => setTimeout(r, 100));
    });
    let m = await page.evaluate(MEASURE);
    check('plate width matches the card', Math.abs(m.barWidth - m.cardWidth) <= 1, JSON.stringify(m));
    check('plate is aligned with the card', Math.abs(m.barLeft - m.cardLeft) <= 1, JSON.stringify(m));
    check('plate inherits the card corner radius', m.radiusVar === '22px', JSON.stringify(m));
    check('plate does not inherit the card border color', m.borderVar === '', JSON.stringify(m));

    console.log('focused card with a colored border');
    await page.evaluate(() => {
      window.__card.style.borderColor = '#a855f7';
      return new Promise((r) => setTimeout(r, 150));
    });
    m = await page.evaluate(MEASURE);
    check('focused violet card never paints the plate', m.borderVar === '', JSON.stringify(m));

    console.log('card resize');
    await page.evaluate(() => {
      window.__card.style.width = '420px';
      return new Promise((r) => setTimeout(r, 150));
    });
    m = await page.evaluate(MEASURE);
    check('plate follows a resized card', Math.abs(m.barWidth - m.cardWidth) <= 1 && Math.abs(m.barLeft - m.cardLeft) <= 1, JSON.stringify(m));

    console.log('full-width card');
    await page.evaluate(() => {
      window.__card.style.width = '100%';
      window.__card.style.margin = '0';
      return new Promise((r) => setTimeout(r, 150));
    });
    m = await page.evaluate(MEASURE);
    check('full-width card keeps the plate aligned', Math.abs(m.barWidth - m.cardWidth) <= 1 && Math.abs(m.barLeft - m.cardLeft) <= 1, JSON.stringify(m));

    console.log('composer card resolution');
    const resolved = await page.evaluate(() => {
      const build = (cardClass, cardRadius, cardBg) => {
        document.body.innerHTML = '';
        const host = document.createElement('div');
        const card = document.createElement('div');
        card.className = cardClass;
        card.dataset.role = 'card';
        card.style.cssText =
          'width:600px;box-sizing:border-box;border:1px solid #3a3c42;' +
          'border-radius:' + cardRadius + ';background:' + cardBg;
        const wrap = document.createElement('div');
        wrap.style.cssText = 'margin:4px 0';
        const inner = document.createElement('div');
        inner.style.cssText = 'position:relative;background:transparent';
        const textarea = document.createElement('textarea');
        inner.appendChild(textarea);
        wrap.appendChild(inner);
        card.appendChild(wrap);
        host.appendChild(card);
        document.body.appendChild(host);
        return { textarea, card };
      };

      const cases = {};
      [
        ['empty', '_77cefa5 _9996a53', '24px', 'rgb(44, 44, 46)'],
        ['populated', '_77cefa5 _3d616d3 focused', '24px', 'rgb(44, 44, 46)'],
        ['renamed', 'x y z', '20px', 'rgb(44, 44, 46)']
      ].forEach(([name, cls, radius, bg]) => {
        const { textarea, card } = build(cls, radius, bg);
        const found = window.findComposerCard(textarea);
        cases[name] = {
          matchesCard: found === card,
          foundTag: found ? found.tagName + '.' + (found.className || '') : null
        };
      });
      return cases;
    });
    check('empty chat resolves the `_9996a53` card', resolved.empty.matchesCard, JSON.stringify(resolved.empty));
    check('populated chat resolves the outer card, not the inner wrapper', resolved.populated.matchesCard, JSON.stringify(resolved.populated));
    check('renamed classes resolve a rounded painted ancestor', resolved.renamed.matchesCard, JSON.stringify(resolved.renamed));
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll project plate checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

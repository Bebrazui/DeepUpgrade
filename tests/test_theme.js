// Theme regression test.
//
// The popup has always offered "Темы", but for a long time it only stored a
// value: content.js had no `set_theme` handler and injected.css had no theme
// rules, so every option rendered exactly like `default`.
//
// DeepSeek paints through CSS custom properties, so themes remap the palette
// instead of touching hashed classes. This suite loads the real theme engine and
// the real injected.css over a fixture that mimics DeepSeek's cascade and checks
// that each option produces distinct colors, and that `default` is a no-op.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const CONTENT_PATH = path.resolve(__dirname, '..', 'extension', 'content.js');
const CSS_PATH = path.resolve(__dirname, '..', 'extension', 'ui', 'injected.css');
const POPUP_JS_PATH = path.resolve(__dirname, '..', 'extension', 'ui', 'popup.js');

function extractBlock(source, name) {
  const start = source.indexOf(`// <${name}>`);
  const end = source.indexOf(`// </${name}>`);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not find <${name}> markers in content.js`);
  }
  return source.slice(start, end);
}

const SOURCE = fs.readFileSync(CONTENT_PATH, 'utf8');
const THEME_ENGINE = extractBlock(SOURCE, 'du-theme');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');
const POPUP_JS = fs.readFileSync(POPUP_JS_PATH, 'utf8');

// Same custom-property layout DeepSeek ships: statics on body, dark aliases on
// body[data-ds-dark-theme]. The real values are used so the assertions are
// meaningful.
const FIXTURE = `<!doctype html><html><head><meta charset="utf-8"><style>
  body {
    --dsw-static-neutral-bluish-00: #fff;
    --dsw-static-neutral-bluish-50: #f9fafb;
    --dsw-static-neutral-bluish-100: #ebeef2;
    --dsw-static-neutral-bluish-300: #cfd3d6;
    --dsw-static-neutral-bluish-400: #adb2b8;
    --dsw-static-neutral-bluish-600: #81858c;
    --dsw-static-neutral-bluish-750: #43454a;
    --dsw-static-neutral-bluish-800: #353638;
    --dsw-static-neutral-bluish-850: #2c2c2e;
    --dsw-static-neutral-bluish-875: #232324;
    --dsw-static-neutral-bluish-900: #1b1b1c;
    --dsw-static-neutral-bluish-950: #151517;
    --dsw-static-neutral-700: #3c3c3d;
    --dsw-static-neutral-600: #545557;
    --dsw-static-deepseek-400: #679efe;
    --dsw-static-deepseek-450: #5686fe;
    --dsw-static-deepseek-500: #4a7cf0;
    --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950);
    --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850);
    --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
    background-color: var(--dsw-static-neutral-bluish-950);
    color: var(--dsw-static-neutral-bluish-50);
  }
  body[data-ds-dark-theme] {
    --dsw-alias-bg-base: var(--dsw-static-neutral-bluish-950);
    --dsw-alias-bg-layer-2: var(--dsw-static-neutral-bluish-850);
    --dsw-alias-border-l2: rgba(255, 255, 255, 0.12);
  }
  .ds-panel {
    background: var(--dsw-alias-bg-layer-2);
    border: 1px solid var(--dsw-alias-border-l2);
  }
</style>
<style>${CSS}</style>
</head><body data-ds-dark-theme="dark"><div class="ds-panel" id="panel">panel</div></body></html>`;

const STUB = `
  window.__storedTheme = window.__storedTheme || 'default';
  window.__changeListeners = [];
  window.chrome = {
    storage: {
      local: {
        get(keys, cb) { setTimeout(() => cb({ du_theme: window.__storedTheme }), 0); }
      },
      onChanged: {
        addListener(fn) { window.__changeListeners.push(fn); }
      }
    }
  };
`;

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(FIXTURE);
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    // The theme adds a 200ms background fade; tests assert settled colors.
    await page.addStyleTag({ content: 'html[data-du-theme] body { transition: none !important; }' });
    await page.addScriptTag({ content: STUB });
    await page.addScriptTag({ content: THEME_ENGINE });
    await page.waitForTimeout(20);

    // Theme switches animate the page background for 200ms; measure the settled state.
    const apply = async (theme) => {
      await page.evaluate((value) => window.__DU_THEME__.apply(value), theme);
      await page.waitForTimeout(320);
    };

    const snapshot = async () => page.evaluate(() => {
      const body = getComputedStyle(document.body);
      const panel = getComputedStyle(document.getElementById('panel'));
      return {
        attr: document.documentElement.getAttribute('data-du-theme'),
        engine: window.__DU_THEME__.current(),
        bodyBg: body.backgroundColor,
        bodyImage: body.backgroundImage,
        panelBg: panel.backgroundColor,
        panelBorder: panel.borderTopColor,
        brand: body.getPropertyValue('--dsw-static-deepseek-450').trim(),
        layer2: body.getPropertyValue('--dsw-static-neutral-bluish-850').trim(),
        stored: localStorage.getItem('du_theme')
      };
    });

    console.log('default is a no-op');
    let s = await snapshot();
    check('no theme attribute by default', s.attr === null && s.engine === 'default', JSON.stringify(s));
    check('native background is untouched', s.bodyBg === 'rgb(21, 21, 23)', s.bodyBg);
    check('native panel is untouched', s.panelBg === 'rgb(44, 44, 46)', s.panelBg);

    console.log('oled');
    await apply('oled');
    s = await snapshot();
    check('attribute applied', s.attr === 'oled', s.attr);
    check('page becomes pure black', s.bodyBg === 'rgb(0, 0, 0)', s.bodyBg);
    check('panels get near-black layers', s.panelBg === 'rgb(17, 17, 19)', s.panelBg);
    check('value is persisted', s.stored === 'oled', s.stored);

    console.log('cyberpunk');
    await apply('cyberpunk');
    s = await snapshot();
    check('attribute applied', s.attr === 'cyberpunk', s.attr);
    check('page uses the neon base', s.bodyBg === 'rgb(7, 2, 15)', s.bodyBg);
    check('panels use the purple layer', s.panelBg === 'rgb(29, 10, 48)', s.panelBg);
    check('brand color is neon magenta', s.brand === '#ff2bd6', s.brand);
    check('neon glow gradient is painted', /radial-gradient/.test(s.bodyImage), s.bodyImage);
    check('borders follow the neon palette', s.panelBorder !== 'rgba(255, 255, 255, 0.12)', s.panelBorder);

    console.log('glass');
    await apply('glass');
    s = await snapshot();
    check('attribute applied', s.attr === 'glass', s.attr);
    check('body uses the deep blue base', s.bodyBg === 'rgb(6, 11, 20)', s.bodyBg);
    check('body gets the glass gradient', /linear-gradient/.test(s.bodyImage), s.bodyImage);
    check('panel layer is translucent', /^rgba\(21, 32, 54/.test(s.panelBg), s.panelBg);

    console.log('back to default');
    await apply('default');
    s = await snapshot();
    check('attribute removed', s.attr === null, String(s.attr));
    check('native background restored', s.bodyBg === 'rgb(21, 21, 23)', s.bodyBg);
    check('native panel restored', s.panelBg === 'rgb(44, 44, 46)', s.panelBg);
    check('native gradients removed', s.bodyImage === 'none', s.bodyImage);

    console.log('validation and wiring');
    await apply('nonsense');
    s = await snapshot();
    check('unknown theme falls back to default', s.attr === null, String(s.attr));
    check('unknown theme is stored as default', s.stored === 'default', s.stored);

    await page.evaluate(() => {
      for (const fn of window.__changeListeners) fn({ du_theme: { newValue: 'glass' } }, 'local');
    });
    s = await snapshot();
    check('chrome.storage changes apply the theme', s.attr === 'glass', String(s.attr));

    await page.evaluate(() => {
      for (const fn of window.__changeListeners) fn({ du_theme: { newValue: 'oled' } }, 'sync');
    });
    s = await snapshot();
    check('ignores other storage areas', s.attr === 'glass', String(s.attr));

    // A stored value must win over the local mirror on load.
    await page.evaluate(() => { localStorage.setItem('du_theme', 'default'); });
    await page.evaluate(() => { window.__storedTheme = 'cyberpunk'; });
    await page.addScriptTag({ content: THEME_ENGINE });
    await page.waitForTimeout(30);
    s = await snapshot();
    check('chrome.storage wins over localStorage on load', s.attr === 'cyberpunk', String(s.attr));

    console.log('message handler');
    check('content.js handles set_theme', /action === 'set_theme'/.test(SOURCE));
    check('content.js routes it to the theme engine', /__DU_THEME__[\s\S]{0,80}\.apply\(/.test(SOURCE));
    check('popup sends set_theme', /action: 'set_theme'/.test(POPUP_JS));
    check('popup persists du_theme', /du_theme:\s*themeSelect\.value/.test(POPUP_JS));

    console.log('no hashed selectors');
    const themeCss = CSS.slice(CSS.indexOf('THEMES'), CSS.length);
    check('theme rules avoid hashed classes', !/\.[_][0-9a-f]{6,}/.test(themeCss));
    check('theme rules are scoped to the attribute',
      themeCss.split('\n').filter((line) => line.includes('data-du-theme') && line.includes('{')).length > 0);

    console.log('light mode safety');
    await page.evaluate(() => {
      document.body.removeAttribute('data-ds-dark-theme');
      window.__DU_THEME__.apply('cyberpunk');
    });
    s = await snapshot();
    check('themes do not repaint the light palette', s.bodyBg === 'rgb(21, 21, 23)', s.bodyBg);
    check('attribute is still remembered', s.attr === 'cyberpunk', String(s.attr));
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll theme checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

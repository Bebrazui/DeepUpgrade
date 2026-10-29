// Tool card UI regression test.
//
// Three things are easy to break here:
//  1. the shell card must be labelled "Терминал" (it used to say "Оболочка"),
//  2. `write` must show the real file content in a scrollable block instead of
//     a 15-line "+" diff preview,
//  3. the card must appear (shimmering label) while the tool block is still
//     streaming and must be reused once the block is complete, never duplicated.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const CONTENT_PATH = path.resolve(__dirname, '..', 'extension', 'content.js');
const CSS_PATH = path.resolve(__dirname, '..', 'extension', 'ui', 'injected.css');

function extractBlock(source, name) {
  const start = source.indexOf(`// <${name}>`);
  const end = source.indexOf(`// </${name}>`);
  if (start === -1 || end === -1 || end <= start) {
    throw new Error(`Could not find <${name}> markers in content.js`);
  }
  return source.slice(start, end);
}

const CARD_HELPER = extractBlock(fs.readFileSync(CONTENT_PATH, 'utf8'), 'du-tool-card');
const CSS = fs.readFileSync(CSS_PATH, 'utf8');

const HOST = `<!doctype html><html><head><meta charset="utf-8"><style>${CSS}</style></head>
<body><div id="msg" class="ds-message"></div></body></html>`;

const PRELUDE = `
  function escapeHtml(str) {
    return String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }
  function formatBytes(bytes) {
    if (!bytes) return '0 B';
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }
  function updateSidebarTodoList() {}
`;

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

async function main() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end(HOST);
  });
  const port = await new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.addScriptTag({ content: PRELUDE + '\n' + CARD_HELPER });

    console.log('terminal card');
    let info = await page.evaluate(() => {
      const host = document.getElementById('msg');
      const pre = document.createElement('pre');
      pre.textContent = '{"tool":"bash","code":"ls -la"}';
      host.appendChild(pre);
      const card = renderOpenCode1to1(pre, { tool: 'bash', code: 'ls -la' });
      return {
        label: card.querySelector('.opencode-tool-text').textContent,
        body: card.querySelector('.opencode-terminal-input').textContent,
        hasCodeView: !!card.querySelector('.du-code-view'),
        preHidden: pre.closest('.md-code-block') ? true : pre.style.display
      };
    });
    check('label is "Терминал"', info.label === 'Терминал', info.label);
    check('label is not "Оболочка"', info.label !== 'Оболочка', info.label);
    check('terminal command is shown in a code view', info.hasCodeView, info.body);
    check('terminal command text is intact', info.body.includes('ls -la'), info.body);

    console.log('write card');
    info = await page.evaluate(() => {
      const host = document.getElementById('msg');
      const code = Array.from({ length: 20 }, (_, i) => `line_${i} = ${i}`).join('\n');
      const pre = document.createElement('pre');
      pre.textContent = '{"tool":"write"}';
      host.appendChild(pre);
      const card = renderOpenCode1to1(pre, { tool: 'write', path: '/src/app.py', content: code });
      const view = card.querySelector('.du-code-view');
      return {
        label: card.querySelector('.opencode-tool-text').textContent,
        fullCode: view ? view.textContent : '',
        hasDiffAdd: !!card.querySelector('.opencode-terminal-input .du-diff-add'),
        maxHeight: view ? getComputedStyle(view).maxHeight : '',
        overflow: view ? getComputedStyle(view).overflowY : ''
      };
    });
    check('write label names the file', info.label === 'Запись: app.py', info.label);
    check('write shows the whole file', info.fullCode.split('\n').length === 20, String(info.fullCode.split('\n').length));
    check('write has no "+" diff preview', !info.hasDiffAdd);
    check('write block is scrollable', info.overflow === 'auto' && info.maxHeight === '360px', `${info.overflow}/${info.maxHeight}`);

    console.log('long file');
    info = await page.evaluate(() => {
      const host = document.getElementById('msg');
      const code = Array.from({ length: 900 }, (_, i) => `row ${i}`).join('\n');
      const pre = document.createElement('pre');
      pre.textContent = '{"tool":"write"}';
      host.appendChild(pre);
      const card = renderOpenCode1to1(pre, { tool: 'write', path: '/big.txt', content: code });
      const view = card.querySelector('.du-code-view');
      return {
        lines: view ? view.textContent.split('\n').length : 0,
        more: card.querySelector('.du-code-more') ? card.querySelector('.du-code-more').textContent : ''
      };
    });
    check('long file is capped at 800 lines', info.lines === 800, String(info.lines));
    check('long file reports the hidden lines', /ещё 100 строк/.test(info.more), info.more);

    console.log('streaming card');
    info = await page.evaluate(() => {
      const host = document.getElementById('msg');
      host.innerHTML = '';
      const pre = document.createElement('pre');
      pre.textContent = '{"tool":"write","path":"/stream.py","content":"print(1)';
      host.appendChild(pre);
      renderStreamingToolCard(pre, extractPartialToolMeta(pre.textContent));
      const first = host.querySelector('.opencode-tool-root');
      const firstHtml = first ? first.outerHTML : '';
      const pendingSeen = first ? !!first.querySelector('.du-code-streaming') : false;
      const labelSeen = first ? first.querySelector('.opencode-tool-text').textContent : '';
      // The model keeps streaming: the card must be reused, not duplicated.
      renderStreamingToolCard(pre, extractPartialToolMeta(pre.textContent));
      const count = host.querySelectorAll('.opencode-tool-root').length;
      // Block completes.
      pre.textContent = '{"tool":"write","path":"/stream.py","content":"print(1)\\n"}';
      const finalCard = renderOpenCode1to1(pre, { tool: 'write', path: '/stream.py', content: 'print(1)\n' });
      return {
        rootCount: host.querySelectorAll('.opencode-tool-root').length,
        streamingAttr: firstHtml.includes('data-du-streaming="true"'),
        pending: pendingSeen,
        label: labelSeen,
        stillStreaming: finalCard.hasAttribute('data-du-streaming'),
        finalCode: finalCard.querySelector('.du-code-view') ? finalCard.querySelector('.du-code-view').textContent : '',
        finalCards: count
      };
    });
    check('card appears while streaming', info.streamingAttr, String(info.streamingAttr));
    check('streaming card shows a pending hint', info.pending, String(info.pending));
    check('streaming label names the file', info.label === 'Запись: stream.py', info.label);
    check('no duplicate card while streaming', info.finalCards === 1, String(info.finalCards));
    check('single card after completion', info.rootCount === 1, String(info.rootCount));
    check('finished card is no longer streaming', info.stillStreaming === false);
    check('finished card shows the final code', info.finalCode === 'print(1)\n', JSON.stringify(info.finalCode));
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll tool card checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

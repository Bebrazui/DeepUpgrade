// Durable VFS regression test.
//
// The tool sandbox lives in a manifest sandbox page (unique origin) and cannot
// touch OPFS itself. The host page owns the durable copy and answers the
// hydrate/mutate protocol. This test reproduces that setup with the real
// `<du-vfs-store>` code from content.js and the real runner.html, then checks
// that files survive a full runner reload.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', 'extension', 'sandbox');
const CONTENT = path.resolve(__dirname, '..', 'extension', 'content.js');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.whl': 'application/octet-stream'
};

function extractStore(source) {
  const start = source.indexOf('// <du-vfs-store>');
  const end = source.indexOf('// </du-vfs-store>');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not find <du-vfs-store> markers in content.js');
  }
  return source.slice(start, end);
}

const STORE = extractStore(fs.readFileSync(CONTENT, 'utf8'));

const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="sb" sandbox="allow-scripts" src="about:blank" style="display:none"></iframe>
<script>
${STORE}
(function () {
  const frame = document.getElementById('sb');
  const store = window.__DU_VFS_STORE;

  window.addEventListener('message', async (ev) => {
    const data = ev.data || {};
    if (data.type === 'DU_VFS_BOOT') {
      const mode = await store.init();
      const files = await store.loadAll();
      ev.source.postMessage({ type: 'DU_VFS_SNAPSHOT', files, mode }, '*');
    } else if (data.type === 'DU_VFS_MUTATE') {
      const result = await store.apply(data);
      ev.source.postMessage({ type: 'DU_VFS_MUTATED', reqId: data.reqId, ...result }, '*');
    }
  });

  // Queue runs until the runner has loaded.
  let pending = [];
  let ready = false;
  frame.addEventListener('load', () => {
    ready = true;
    for (const fn of pending) fn();
    pending = [];
  });
  frame.src = '/runner.html';

  window.__run = (payload) => new Promise((resolve) => {
    const id = 'test_' + Math.random().toString(36).slice(2);
    const timer = setTimeout(() => resolve({ success: false, output: 'TIMEOUT' }), 60000);
    const on = (ev) => {
      if (ev.data && ev.data.id === id && ev.data.type !== 'DU_RUN') {
        clearTimeout(timer);
        window.removeEventListener('message', on);
        resolve(ev.data);
      }
    };
    window.addEventListener('message', on);
    const send = () => frame.contentWindow.postMessage({ id, type: 'DU_RUN', ...payload }, '*');
    if (ready) send(); else pending.push(send);
  });

  window.__reloadRunner = () => new Promise((resolve) => {
    ready = false;
    pending = [];
    frame.addEventListener('load', () => resolve(true), { once: true });
    frame.src = '/runner.html?reload=' + Math.random();
  });

  window.__storeFiles = async () => (await store.loadAll()).map((f) => f.path).sort();
  window.__ready = true;
})();
</script>
</body></html>`;

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    if (urlPath === '/' || urlPath === '/index.html') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(HOST_PAGE);
      return;
    }
    const file = path.join(ROOT, urlPath.replace(/^\/+/, ''));
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port })));
}

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
  const { server, port } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load', timeout: 30000 });
    await page.waitForFunction(() => window.__ready === true, null, { timeout: 15000 });

    console.log('write reaches the durable store');
    let res = await page.evaluate(() => window.__run({ tool: 'write', path: '/smoke/hard3.py', content: 'print(42)\n' }));
    check('write succeeds', res.success === true && /Successfully wrote/.test(res.output), res.output);
    check('write reports characters and bytes', /10 characters \(10 bytes\)/.test(res.output), res.output);

    let files = await page.evaluate(() => window.__storeFiles());
    check('file persisted in OPFS', files.includes('/smoke/hard3.py'), JSON.stringify(files));

    console.log('emoji-safe counter');
    res = await page.evaluate(() => window.__run({ tool: 'write', path: '/len/emoji.txt', content: '😀😀' }));
    check('emoji counted as code points', /2 characters \(8 bytes\)/.test(res.output), res.output);

    console.log('files survive a runner reload');
    await page.evaluate(() => window.__reloadRunner());
    await page.evaluate(() => new Promise((r) => setTimeout(r, 500)));

    res = await page.evaluate(() => window.__run({ tool: 'read', path: '/smoke/hard3.py' }));
    check('read sees the file after reload', res.success === true && /print\(42\)/.test(res.output), res.output);

    res = await page.evaluate(() => window.__run({ tool: 'bash', code: 'cat /smoke/hard3.py' }));
    check('bash sees the file after reload', res.success === true && /print\(42\)/.test(res.output), res.output);

    res = await page.evaluate(() => window.__run({ tool: 'bash', code: 'ls /smoke' }));
    check('bash ls sees the file after reload', res.success === true && /hard3\.py/.test(res.output), res.output);

    console.log('deletions reach the store');
    res = await page.evaluate(() => window.__run({ tool: 'bash', code: 'rm /smoke/hard3.py' }));
    check('rm succeeds', res.success === true, res.output);
    files = await page.evaluate(() => window.__storeFiles());
    check('deleted file is gone from OPFS', !files.includes('/smoke/hard3.py'), JSON.stringify(files));

    console.log('browser swap files are ignored');
    const swapCreated = await page.evaluate(async () => {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle('du-vfs', { create: true });
      const swap = await dir.getFileHandle('half-written.py.crswap', { create: true });
      const writable = await swap.createWritable();
      await writable.write('partial');
      await writable.close();
      const listed = await window.__storeFiles();
      await dir.removeEntry('half-written.py.crswap');
      return listed;
    });
    check('persisted file is ignored', !swapCreated.some((p) => p.endsWith('.crswap')), JSON.stringify(swapCreated));
    check('real file still loaded', swapCreated.includes('/len/emoji.txt'), JSON.stringify(swapCreated));
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll durable VFS checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

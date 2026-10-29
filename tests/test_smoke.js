// DeepUpgrade sandbox regression smoke test.
// Serves extension/sandbox over HTTP and exercises the real runner.html message API.
//
// Run: node tests/sandbox_smoke.js

const http = require('http');
const fs = require('fs');
const path = require('path');
const { chromium } = require('playwright');

const ROOT = path.resolve(__dirname, '..', 'extension', 'sandbox');

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json',
  '.wasm': 'application/wasm',
  '.zip': 'application/zip',
  '.whl': 'application/octet-stream'
};

function startServer() {
  const server = http.createServer((req, res) => {
    const urlPath = decodeURIComponent((req.url || '/').split('?')[0]);
    const rel = urlPath === '/' ? 'runner.html' : urlPath.replace(/^\/+/, '');
    const file = path.join(ROOT, rel);
    if (!file.startsWith(ROOT) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    fs.createReadStream(file).pipe(res);
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}

async function main() {
  const { server, port } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  let pyodideReady = false;
  page.on('console', (msg) => {
    const text = msg.text();
    if (text.includes('loaded 100% offline')) pyodideReady = true;
    if (text.includes('Failed to ')) console.log('[sandbox console]', text);
  });

  const failures = [];
  const check = (name, condition, detail) => {
    if (condition) {
      console.log(`  PASS  ${name}`);
    } else {
      failures.push(name);
      console.log(`  FAIL  ${name}  ${detail || ''}`);
    }
  };

  try {
    await page.goto(`http://127.0.0.1:${port}/runner.html`, { waitUntil: 'load', timeout: 30000 });

    async function run(tool, payload = {}) {
      const id = 'test_' + Math.random().toString(36).slice(2);
      return page.evaluate(({ id, tool, payload }) => new Promise((resolve) => {
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMessage);
          resolve({ success: false, output: 'TIMEOUT' });
        }, 30000);
        const onMessage = (ev) => {
          if (ev.data && ev.data.id === id && ev.data.type !== 'DU_RUN') {
            clearTimeout(timer);
            window.removeEventListener('message', onMessage);
            resolve(ev.data);
          }
        };
        window.addEventListener('message', onMessage);
        window.postMessage({ id, type: 'DU_RUN', tool, ...payload }, '*');
      }), { id, tool, payload });
    }

    console.log('write validation');
    let res = await run('write', { path: '/empty.txt', content: '' });
    check('empty content is rejected', res.success === false && /empty/i.test(res.output), res.output);

    res = await run('write', { path: '/a.txt', content: 'hello' });
    check('valid write succeeds', res.success === true && /Successfully wrote 5 characters/.test(res.output), res.output);

    res = await run('write', { path: '/b.txt' });
    check('missing content is rejected', res.success === false && /empty/i.test(res.output), res.output);

    console.log('bash');
    res = await run('bash', { code: 'cat /a.txt' });
    check('write -> bash cat', res.success === true && res.output.trim() === 'hello', res.output);

    res = await run('bash', { code: 'find / -name "*.txt"' });
    check('find works', res.success === true && /\/a\.txt/.test(res.output), res.output);

    res = await run('bash', { code: 'git clone https://github.com/x/y' });
    check('git fails honestly', res.success === false && /not available/i.test(res.output), res.output);

    res = await run('bash', { code: 'df -h' });
    check('unknown command fails honestly', res.success === false && /command not found/i.test(res.output), res.output);

    res = await run('bash', { code: 'touch /t.txt && echo ok' });
    check('touch + && chain', res.success === true && /ok/.test(res.output), res.output);

    console.log('edit');
    res = await run('edit', { path: '/new.txt', old_str: '', new_str: 'created' });
    check('edit creates a new file', res.success === true && /created/.test(res.output), res.output);
    res = await run('bash', { code: 'cat /new.txt' });
    check('edit -> bash cat', res.success === true && res.output.trim() === 'created', res.output);

    console.log('tool validation');
    res = await run('shell', { code: 'find /' });
    check('unknown tool is rejected', res.success === false && /Unknown tool/i.test(res.output), res.output);

    res = await run('bash', { code: '   ' });
    check('empty code is rejected', res.success === false && /non-empty "code"/i.test(res.output), res.output);

    console.log('python <-> VFS bridge');
    await page.waitForFunction(() => true);
    const started = Date.now();
    while (!pyodideReady && Date.now() - started < 60000) {
      await page.waitForTimeout(250);
    }
    if (!pyodideReady) {
      check('Pyodide loaded', false, 'timeout');
    } else {
      res = await run('python', { code: 'print(1+1)' });
      check('python print evaluates an expression', res.success === true && res.output.trim() === '2', res.output);

      res = await run('bash', { code: 'python -c "print(1+1)"' });
      check('bash python -c evaluates an expression', res.success === true && res.output.trim() === '2', res.output);

      res = await run('write', { path: '/skills/smoke/SKILL.md', content: 'skill-body' });
      check('mount skill via write', res.success === true, res.output);

      res = await run('python', { code: "print(open('/skills/smoke/SKILL.md').read())" });
      check('python sees file written via write', res.success === true && /skill-body/.test(res.output), res.output);

      res = await run('python', { code: "open('/home/pyodide/from_python.txt', 'w').write('py-created')" });
      check('python creates a file', res.success === true, res.output);

      res = await run('bash', { code: 'cat /home/pyodide/from_python.txt' });
      check('bash cat sees python file', res.success === true && /py-created/.test(res.output), res.output);

      res = await run('bash', { code: 'ls /home/pyodide' });
      check('bash ls sees python file', res.success === true && /from_python\.txt/.test(res.output), res.output);

      res = await run('python', { code: "open('/skills/smoke/SKILL.md', 'w').write('updated-by-python')" });
      check('python edits a VFS file', res.success === true, res.output);

      res = await run('read', { path: '/skills/smoke/SKILL.md' });
      check('python edits flow back to VFS', res.success === true && /updated-by-python/.test(res.output), res.output);
    }
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll sandbox smoke checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

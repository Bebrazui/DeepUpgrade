// POSIX shell regression test.
//
// The old shell cut the command line with split(';') / split('>'), so `>>` was
// echoed literally, `$?` and `$VAR` were not expanded and a '>' inside quotes
// broke the command. That made the model believe write/bash/python used three
// different filesystems. This suite drives the real runner and checks the
// shell semantics models rely on.

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
  if (start === -1 || end === -1) throw new Error('No <du-vfs-store> markers in content.js');
  return source.slice(start, end);
}

const STORE = extractStore(fs.readFileSync(CONTENT, 'utf8'));

const HOST_PAGE = `<!doctype html><html><head><meta charset="utf-8"></head><body>
<iframe id="sb" src="about:blank" style="display:none"></iframe>
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
  let pending = [];
  let ready = false;
  frame.addEventListener('load', () => { ready = true; for (const fn of pending) fn(); pending = []; });
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
  window.__ready = true;
})();
</script></body></html>`;

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
  return new Promise((r) => server.listen(0, '127.0.0.1', () => r({ server, port: server.address().port })));
}

const failures = [];
function check(name, condition, detail) {
  if (condition) console.log(`  PASS  ${name}`);
  else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

async function main() {
  const { server, port } = await startServer();
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (e) => console.log('[pageerror]', e.message));

  const run = async (code) => page.evaluate((c) => window.__run({ tool: 'bash', code: c }), code);
  const out = async (code) => {
    const res = await run(code);
    return { ok: res.success, text: res.output, raw: res };
  };

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.waitForFunction(() => window.__ready === true);
    await page.waitForTimeout(400);

    console.log('redirections');
    let r = await out('printf "one\\n" > /t/a.txt; printf "two\\n" >> /t/a.txt; cat /t/a.txt');
    check('> creates and >> appends', r.ok && r.text === 'one\ntwo', r.text);

    r = await out('echo "a > b" > /t/quoted.txt; cat /t/quoted.txt');
    check('> inside quotes is literal', r.ok && r.text.trim() === 'a > b', r.text);

    r = await out('echo hi > /t/over.txt; echo hi2 > /t/over.txt; cat /t/over.txt');
    check('> truncates', r.ok && r.text.trim() === 'hi2', r.text);

    r = await out('echo only-err > /t/e.txt 2>/dev/null; cat /t/e.txt');
    check('stderr redirect still writes stdout', r.ok && r.text.trim() === 'only-err', r.text);

    console.log('exit status and conditions');
    r = await out('false; echo $?');
    check('$? reports the previous status', r.ok && r.text.trim() === '1', r.text);

    r = await out('echo ok; echo $?');
    check('$? is 0 after success', r.ok && r.text.split('\n')[1].trim() === '0', r.text);

    r = await out('true && echo yes || echo no');
    check('&& runs on success', r.ok && r.text.trim() === 'yes', r.text);

    r = await out('false && echo yes || echo no');
    check('|| runs on failure', r.ok && r.text.trim() === 'no', r.text);

    r = await out('test -f /t/a.txt && echo present');
    check('test -f sees the file', r.ok && r.text.trim() === 'present', r.text);

    r = await out('[ -d /t ] && echo isdir');
    check('[ -d ] sees the directory', r.ok && r.text.trim() === 'isdir', r.text);

    console.log('variables and expansion');
    r = await out('X=5; echo "x=$X"');
    check('variable assignment + expansion', r.ok && r.text.trim() === 'x=5', r.text);

    r = await out('echo $((2 + 3))');
    check('arithmetic expansion', r.ok && r.text.trim() === '5', r.text);

    r = await out('echo "sub=$(printf hi)"');
    check('command substitution', r.ok && r.text.trim() === 'sub=hi', r.text);

    r = await out('echo ${MISSING:-fallback}');
    check('default expansion', r.ok && r.text.trim() === 'fallback', r.text);

    console.log('quoting');
    r = await out("echo 'a;b' > /t/semi.txt; cat /t/semi.txt");
    check('semicolon inside quotes is literal', r.ok && r.text.trim() === 'a;b', r.text);

    r = await out("printf '%s\\n' a b");
    check('printf repeats the format', r.ok && r.text === 'a\nb', r.text);

    r = await out('echo -n noeol; echo x');
    check('echo -n drops the newline', r.ok && r.text.trim() === 'noeolx', r.text);

    console.log('pipelines');
    r = await out('cat /t/a.txt | sort | uniq');
    check('pipeline', r.ok && r.text === 'one\ntwo', r.text);

    r = await out('cat /t/a.txt | wc -l');
    check('wc -l counts lines', r.ok && r.text.trim() === '2', r.text);

    r = await out('cat /t/a.txt | grep -n two');
    check('grep -n numbers lines', r.ok && r.text.trim() === '2:two', r.text);

    r = await out('printf x > /t/n.txt; wc -c < /t/n.txt');
    check('input redirect', r.ok && r.text.trim() === '1', r.text);

    console.log('heredoc');
    r = await out("cat << 'EOF' > /t/h.txt\nline1\nline2\nEOF\ncat /t/h.txt");
    check('heredoc writes the body', r.ok && r.text === 'line1\nline2', r.text);

    console.log('working directory');
    r = await out('cd /t && pwd && cat a.txt');
    check('cd changes pwd', r.ok && r.text.split('\n')[0].trim() === '/t', r.text);
    check('relative paths resolve from cwd', r.ok && r.text.includes('one'), r.text);

    r = await out('cd / && cd t && ls | grep a.txt');
    check('relative cd', r.ok && r.text.trim() === 'a.txt', r.text);

    r = await out('cd /t && cd .. && pwd');
    check('cd .. goes up', r.ok && r.text.trim() === '/', r.text);

    console.log('globs and file commands');
    r = await out('cd /t && printf "# %s\\n" *.txt | head -n 3');
    check('glob expansion', r.ok && /a\.txt/.test(r.text), r.text);

    r = await out('cd /t && ls *.md');
    check('unmatched glob stays literal', !r.ok && /quoted\.md|No such file/.test(r.text), r.text);

    r = await out('cd /t && cp a.txt copied.txt && cat copied.txt');
    check('cp copies', r.ok && r.text.includes('one'), r.text);

    r = await out('cd /t && mkdir -p deep/nested && echo x > deep/nested/f.txt && cat deep/nested/f.txt');
    check('mkdir -p nests', r.ok && r.text.trim() === 'x', r.text);

    r = await out('cd /t && mv copied.txt moved.txt && ls | grep moved.txt');
    check('mv moves', r.ok && r.text.trim() === 'moved.txt', r.text);

    r = await out('cd /t && rm -r deep && ls | grep -c deep');
    check('rm -r removes the tree', r.ok && !/deep/.test(r.text), r.text);

    r = await out('find /t -name "*.txt" -maxdepth 1');
    check('find -name -maxdepth', r.ok && /\/t\/a\.txt/.test(r.text), r.text);

    r = await out('cd /t && sed s/one/ONE/ a.txt');
    check('sed substitution', r.ok && r.text.includes('ONE'), r.text);

    r = await out('cd /t && ls -l | head -n 1');
    check('ls -l long format', r.ok && /^-rw/.test(r.text), r.text);

    console.log('errors');
    r = await out('cat /nope/missing.txt');
    check('missing file fails with status', !r.ok && /No such file/.test(r.text), r.text);

    r = await out('git status');
    check('git stays honest', !r.ok && /not available/.test(r.text), r.text);

    r = await out('nosuchcommand');
    check('unknown command fails', !r.ok && /command not found/.test(r.text), r.text);

    console.log('cross-tool filesystem');
    r = await out('echo appended > /t/shared.txt');
    check('bash writes for python', r.ok, r.text);
    let py = await page.evaluate(() => window.__run({ tool: 'python', code: "print(open('/t/shared.txt').read().strip())" }));
    check('python reads the bash file', py.success && py.output.trim() === 'appended', py.output);

    py = await page.evaluate(() => window.__run({ tool: 'python', code: "open('/t/frompy.txt','w').write('py-line')" }));
    check('python writes a file', py.success, py.output);
    r = await out('cat /t/frompy.txt');
    check('bash reads the python file', r.ok && r.text.trim() === 'py-line', r.text);

    r = await out('ls /t | sort');
    check('bash ls lists both files', r.ok && /frompy\.txt/.test(r.text) && /shared\.txt/.test(r.text), r.text);
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll POSIX shell checks passed.');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

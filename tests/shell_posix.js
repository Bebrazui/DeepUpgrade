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

    r = await out('echo $BASH_VERSION');
    check('BASH_VERSION is set', r.ok && r.text.includes('5.2'), r.text);

    console.log('quoting');
    r = await out("echo 'a;b' > /t/semi.txt; cat /t/semi.txt");
    check('semicolon inside quotes is literal', r.ok && r.text.trim() === 'a;b', r.text);

    r = await out("printf '%s\\n' a b");
    check('printf repeats the format', r.ok && r.text === 'a\nb', r.text);

    r = await out("printf '%-8s OK\\n' ls cat");
    check('printf width specifier and left-align', r.ok && r.text === 'ls       OK\ncat      OK', r.text);

    r = await out("printf 'fixed\\n' a b c");
    check('printf without specifiers stops cleanly without loop', r.ok && r.text === 'fixed', r.text);

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

    console.log('control structures (if / elif / else / fi)');
    r = await out('if [ -f /t/a.txt ]; then echo exists; else echo missing; fi');
    check('if-then branch', r.ok && r.text.trim() === 'exists', r.text);

    r = await out('if [ -f /t/nonexistent.txt ]; then echo yes; else echo no; fi');
    check('if-else branch', r.ok && r.text.trim() === 'no', r.text);

    r = await out('x=2; if [ "$x" = "1" ]; then echo one; elif [ "$x" = "2" ]; then echo two; else echo other; fi');
    check('if-elif-else branch', r.ok && r.text.trim() === 'two', r.text);

    r = await out('if ! false; then echo negated; fi');
    check('pipeline negation in if condition', r.ok && r.text.trim() === 'negated', r.text);

    console.log('loops (for / while / until / break / continue)');
    r = await out('for x in a b c; do echo $x; done');
    check('for in loop', r.ok && r.text === 'a\nb\nc', r.text);

    r = await out('for i in 1 2 3 4; do if [ "$i" = "3" ]; then break; fi; echo $i; done');
    check('for with break', r.ok && r.text === '1\n2', r.text);

    r = await out('for i in 1 2 3 4; do if [ "$i" = "2" ]; then continue; fi; echo $i; done');
    check('for with continue', r.ok && r.text === '1\n3\n4', r.text);

    r = await out('i=0; while [ "$i" -lt 3 ]; do echo $i; i=$((i+1)); done');
    check('while loop with arithmetic', r.ok && r.text === '0\n1\n2', r.text);

    r = await out('i=0; until [ "$i" -ge 3 ]; do echo $i; i=$((i+1)); done');
    check('until loop', r.ok && r.text === '0\n1\n2', r.text);

    r = await out('for x in alpha beta gamma; do echo $x; done > /t/loop_out.txt; cat /t/loop_out.txt');
    check('loop output redirect', r.ok && r.text === 'alpha\nbeta\ngamma', r.text);

    r = await out('for x in 10 20 30; do echo $x; done | grep 20');
    check('loop pipeline', r.ok && r.text.trim() === '20', r.text);

    r = await out('for i in 1 2 3; do for j in a b; do if [ "$j" = "b" ]; then break 2; fi; echo $i-$j; done; done');
    check('break 2 exits nested loops', r.ok && r.text.trim() === '1-a', r.text);

    console.log('functions (def / args / return)');
    r = await out('greet() { echo "Hello, $1!"; }; greet World');
    check('function definition and positional arg', r.ok && r.text.trim() === 'Hello, World!', r.text);

    r = await out('function calc() { echo $(( $1 + $2 )); }; calc 40 2');
    check('function keyword definition and multiple args', r.ok && r.text.trim() === '42', r.text);

    r = await out('info() { echo count:$# all:$@; }; info x y z');
    check('function $# and $@ parameters', r.ok && r.text.trim() === 'count:3 all:x y z', r.text);

    r = await out('check_num() { if [ "$1" -lt 0 ]; then return 1; fi; echo ok; return 0; }; check_num -5; echo ret:$?');
    check('function return status', r.ok && r.text.trim() === 'ret:1', r.text);

    r = await out('square() { echo $(($1 * $1)); }; res=$(square 7); echo "result: $res"');
    check('function output captured by command substitution', r.ok && r.text.trim() === 'result: 49', r.text);

    r = await out('fact() { if [ "$1" -le 1 ]; then echo 1; else echo $(( $1 * $(fact $(( $1 - 1 ))) )); fi; }; fact 5');
    check('recursive function call', r.ok && r.text.trim() === '120', r.text);

    r = await out('set_v() { MY_VAR="val_$1"; }; set_v 123; echo $MY_VAR');
    check('function updates environment', r.ok && r.text.trim() === 'val_123', r.text);

    r = await out('my_cmd() { echo foo; }; type my_cmd');
    check('type recognizes functions', r.ok && r.text.includes('is a function'), r.text);

    console.log('agent probe loop');
    r = await out("echo '--- builtins check ---'; for c in ls cat grep sed awk curl wget find head tail sort tr cut wc mkdir cp mv rm touch chmod date whoami id env echo printf; do if command -v $c >/dev/null 2>&1; then printf '%-8s OK\\n' $c; else printf '%-8s MISSING\\n' $c; fi; done");
    check('agent builtins loop succeeds with OK for all', r.ok && !r.text.includes('MISSING') && r.text.includes('ls       OK') && r.text.includes('printf   OK'), r.text);

    console.log('advanced bash features');
    r = await out('if [[ "abc" == a* ]]; then echo glob-match OK; fi');
    check('[[ ]] pattern matching', r.ok && r.text.trim() === 'glob-match OK', r.text);

    r = await out('if [[ 5 -gt 3 && "x" != "y" ]]; then echo logic OK; fi');
    check('[[ ]] compound logic', r.ok && r.text.trim() === 'logic OK', r.text);

    r = await out('arr=(one two three); echo count=${#arr[@]} second=${arr[1]}; arr+=(four); echo after-append=${arr[*]}');
    check('indexed arrays and append', r.ok && r.text.includes('count=3 second=two') && r.text.includes('after-append=one two three four'), r.text);

    r = await out('declare -A m; m[a]=1; m[b]=2; echo m[a]=${m[a]} keys=${!m[*]}');
    check('associative arrays', r.ok && r.text.includes('m[a]=1') && r.text.includes('keys=a b'), r.text);

    r = await out("diff <(echo -e 'a\\nb') <(echo -e 'a\\nc') | head -2");
    check('process substitution <(...)', r.ok && r.text.includes('--- /tmp/.procsub_') && r.text.includes('+++ /tmp/.procsub_'), r.text);

    r = await out("for ((i=0;i<3;i++)); do printf '%d ' $i; done");
    check('C-style for loop', r.ok && r.text.trim() === '0 1 2', r.text);

    r = await out("s='Hello World'; echo len=${#s} sub=${s:6:5} upper=${s^^} replace=${s/World/Bash}");
    check('parameter expansion string ops', r.ok && r.text.includes('len=11') && r.text.includes('sub=World') && r.text.includes('upper=HELLO WORLD') && r.text.includes('replace=Hello Bash'), r.text);

    r = await out("grep -o 'o' <<< 'foo' | wc -l");
    check('here-string <<< and grep -o', r.ok && r.text.trim() === '2', r.text);

    r = await out('f(){ local v=inner; echo in=$v; }; v=outer; f; echo out=$v');
    check('local variable scoping', r.ok && r.text.includes('in=inner') && r.text.includes('out=outer'), r.text);

    const fullAdvancedScript = `echo '=== advanced bash features ==='; echo '--- [[ ]] ---'; if [[ "abc" == a* ]]; then echo 'glob-match OK'; fi; if [[ 5 -gt 3 && "x" != "y" ]]; then echo 'logic OK'; fi; echo '--- arrays ---'; arr=(one two three); echo "count=\${#arr[@]} second=\${arr[1]}"; arr+=(four); echo "after-append=\${arr[*]}"; echo '--- assoc arrays ---'; declare -A m; m[a]=1; m[b]=2; echo "m[a]=\${m[a]} keys=\${!m[*]}"; echo '--- process substitution ---'; diff <(echo -e 'a\\nb') <(echo -e 'a\\nc') | head -2; echo '--- C-style loop ---'; for ((i=0;i<3;i++)); do printf '%d ' $i; done; echo; echo '--- string ops ---'; s='Hello World'; echo "len=\${#s}"; echo "sub=\${s:6:5}"; echo "upper=\${s^^}"; echo "replace=\${s/World/Bash}"; echo '--- here-string ---'; grep -o 'o' <<< 'foo' | wc -l; echo '--- functions & local ---'; f(){ local v=inner; echo "in=$v"; }; v=outer; f; echo "out=$v"`;
    r = await out(fullAdvancedScript);
    check('full advanced bash script executes cleanly', r.ok && r.text.includes('glob-match OK') && r.text.includes('logic OK') && r.text.includes('count=3 second=two') && r.text.includes('after-append=one two three four') && r.text.includes('m[a]=1') && r.text.includes('0 1 2') && r.text.includes('len=11') && r.text.includes('sub=World') && r.text.includes('upper=HELLO WORLD') && r.text.includes('replace=Hello Bash') && r.text.includes('in=inner\nout=outer'), r.text);

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

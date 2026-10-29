// Silent-send regression test.
//
// Loads the real send path from extension/content.js (between the
// <du-send-path> markers) into a page that mimics DeepSeek's React composer:
//
//   * the send button reflects React state, not the DOM value;
//   * React may commit the value late (async onChange);
//   * React may re-render and replace the <textarea> node;
//   * every submit is reported to the content script as DU_OUTGOING_PROMPT,
//     exactly like extension/interceptor.js does in the real page.
//
// Run: node tests/send_path.js

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const CONTENT_PATH = path.resolve(__dirname, '..', 'extension', 'content.js');

function extractSendPath(source) {
  const start = source.indexOf('// <du-send-path>');
  const end = source.indexOf('// </du-send-path>');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not find <du-send-path> markers in content.js');
  }
  return source.slice(start, end);
}

const SEND_PATH = extractSendPath(fs.readFileSync(CONTENT_PATH, 'utf8'));

const failures = [];
function check(name, condition, detail) {
  if (condition) {
    console.log(`  PASS  ${name}`);
  } else {
    failures.push(name);
    console.log(`  FAIL  ${name}${detail ? '  -> ' + detail : ''}`);
  }
}

const SETUP = function (opts) {
  document.body.innerHTML = '';
  window.__sent = [];
  window.__clickCount = 0;
  window.__rerendered = false;
  try { sessionStorage.removeItem('du_send_log'); } catch (e) {}

  if (opts.searchBox) {
    const search = document.createElement('textarea');
    search.id = 'sidebar-search';
    search.style.cssText = 'width:140px;height:20px;display:block';
    document.body.appendChild(search);
  }

  const box = document.createElement('div');
  box.id = 'composer-box';
  box.style.cssText = 'width:640px;height:160px;position:relative;display:block';
  document.body.appendChild(box);

  const btn = document.createElement('button');
  btn.id = 'send';
  btn.setAttribute('role', 'button');
  btn.innerHTML = '<svg width="16" height="16"><path d="M0 0"/></svg>';
  btn.style.cssText = 'width:24px;height:24px;display:block';
  box.appendChild(btn);

  const state = { value: '', timer: null };
  let input = null;

  function render(replaceInput) {
    if (replaceInput && input) {
      const next = makeInput();
      next.value = state.value;
      box.replaceChild(next, input);
      input = next;
    }
    if (input) input.value = state.value;
    // A real send button is disabled while React state is empty.
    const disabled = !opts.alwaysEnabled && state.value.length === 0;
    btn.setAttribute('aria-disabled', disabled ? 'true' : 'false');
  }

  function makeInput() {
    const ta = document.createElement('textarea');
    ta.style.cssText = 'width:520px;height:60px;display:block';
    ta.addEventListener('input', () => {
      const captured = ta.value;
      clearTimeout(state.timer);
      state.timer = setTimeout(() => {
        state.value = captured;
        render(false);
      }, opts.reactLatency || 0);

      if (opts.rerenderOnFirstInput && !window.__rerendered) {
        window.__rerendered = true;
        setTimeout(() => render(true), 40);
      }
    });
    return ta;
  }

  input = makeInput();
  box.insertBefore(input, btn);
  render(false);

  btn.addEventListener('click', () => {
    if (!opts.alwaysEnabled && btn.getAttribute('aria-disabled') === 'true') return;
    if (opts.alwaysEnabled && btn.getAttribute('aria-disabled') === 'true') {
      // Simulates the worst case: the button stays clickable while the React
      // state is still stale, which is what produces an empty message.
    }
    window.__clickCount++;
    const submitted = state.value; // React submits its state, not the DOM value
    window.__sent.push(submitted);
    window.postMessage({
      type: 'DU_OUTGOING_PROMPT',
      prompt: submitted,
      transport: 'mock',
      ts: Date.now()
    }, '*');
    state.value = '';
    render(opts.rerenderAfterSend === true);
  });

  return true;
};

async function reset(page, opts) {
  await page.evaluate(SETUP, opts || {});
  await page.evaluate(() => {
    // Let a previous job's timers settle before starting a new one.
    return new Promise((r) => setTimeout(r, 50));
  });
}

async function run(page, text) {
  return page.evaluate((reply) => window.sendSilentReply(reply), text);
}

async function main() {
  // localStorage/sessionStorage are unavailable on about:blank, so serve a page.
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.addScriptTag({ content: SEND_PATH });

    const reply = '[SANDBOX OUTPUT (python)]:\n42';

    console.log('normal dispatch');
    await reset(page, { reactLatency: 0 });
    let outcome = await run(page, reply);
    let sent = await page.evaluate(() => window.__sent);
    check('reply is delivered once', outcome === 'delivered' && sent.length === 1, `outcome=${outcome} sent=${JSON.stringify(sent)}`);
    check('delivered text equals the reply', sent[0] === reply, JSON.stringify(sent[0]));

    console.log('composer detection');
    await reset(page, { reactLatency: 0, searchBox: true });
    outcome = await run(page, reply);
    sent = await page.evaluate(() => ({ sent: window.__sent, search: document.getElementById('sidebar-search').value }));
    check('small sidebar input is not used', sent.search === '' && sent.sent.length === 1, JSON.stringify(sent));
    check('reply goes to the chat composer', sent.sent[0] === reply, JSON.stringify(sent.sent));

    console.log('React re-render before submit');
    await reset(page, { reactLatency: 0, rerenderOnFirstInput: true });
    outcome = await run(page, reply);
    sent = await page.evaluate(() => window.__sent);
    check('reply survives a replaced <textarea>', outcome === 'delivered' && sent.length === 1 && sent[0] === reply, `outcome=${outcome} sent=${JSON.stringify(sent)}`);

    console.log('stale React state (empty message race)');
    await reset(page, { reactLatency: 500, alwaysEnabled: true });
    outcome = await run(page, reply);
    const race = await page.evaluate(() => ({
      sent: window.__sent,
      log: window.__duSendLog().map((e) => e.phase),
      empty: window.__duSendLog().filter((e) => e.phase === 'outgoing-EMPTY').length
    }));
    check('empty submission is detected by the network hook', race.empty >= 1, JSON.stringify(race.log));
    check('empty submission is recovered', race.log.includes('recover-resending') || race.log.includes('recover-restoring'), JSON.stringify(race.log));
    check('final delivery contains the reply', race.sent.length >= 1 && race.sent[race.sent.length - 1] === reply, JSON.stringify(race.sent));
    check('job reports delivered', outcome === 'delivered', `outcome=${outcome}`);

    console.log('serialized sends');
    await reset(page, { reactLatency: 0 });
    const outcomes = await page.evaluate(async () => {
      const first = window.sendSilentReply('first silent reply');
      const second = window.sendSilentReply('second silent reply');
      return Promise.all([first, second]);
    });
    const serialized = await page.evaluate(() => window.__sent);
    check('two overlapping replies both finish', outcomes[0] === 'delivered' && outcomes[1] === 'delivered', JSON.stringify(outcomes));
    check('overlapping replies are sent in order', serialized.length === 2 && serialized[0] === 'first silent reply' && serialized[1] === 'second silent reply', JSON.stringify(serialized));

    console.log('failing send does not stall the chain');
    await reset(page, { reactLatency: 0 });
    const failing = await page.evaluate(async () => {
      // triggerSend is a hoisted global function declaration, so it is a
      // writable window property. Simulate the worst transport failure: the
      // click path throws synchronously inside the send attempt.
      window.__origTriggerSend = window.triggerSend;
      window.triggerSend = () => { throw new Error('mock transport failure'); };
      return window.sendSilentReply('reply that cannot be sent');
    });
    const failureLog = await page.evaluate(() => window.__duSendLog().map((e) => e.phase));
    check('failing send settles with an error outcome', failing === 'error', `outcome=${failing}`);
    check('failing send is logged as an error', failureLog.includes('abort-error'), JSON.stringify(failureLog));

    // The serialized chain must keep working after a failed job.
    await reset(page, { reactLatency: 0 });
    const recovered = await page.evaluate(async () => {
      if (window.__origTriggerSend) window.triggerSend = window.__origTriggerSend;
      return window.sendSilentReply('reply after the failure');
    });
    const recoveredSent = await page.evaluate(() => window.__sent);
    check('next reply is delivered after a failed send', recovered === 'delivered' && recoveredSent.length === 1 && recoveredSent[0] === 'reply after the failure', `outcome=${recovered} sent=${JSON.stringify(recoveredSent)}`);

    console.log('empty reply guard');
    await reset(page, { reactLatency: 0 });
    outcome = await run(page, '');
    const guard = await page.evaluate(() => ({
      sent: window.__sent,
      clicks: window.__clickCount,
      log: window.__duSendLog().map((e) => e.phase)
    }));
    check('empty reply is rejected', outcome === false, `outcome=${outcome}`);
    check('no click is made for an empty reply', guard.clicks === 0 && guard.sent.length === 0, JSON.stringify(guard));
    check('rejection is logged', guard.log.includes('abort-empty-reply'), JSON.stringify(guard.log));

    console.log('diagnostics log');
    const logShape = await page.evaluate(() => {
      const log = window.__duSendLog();
      return {
        isArray: Array.isArray(log),
        hasRequested: log.some((e) => e.phase === 'requested'),
        keys: Object.keys(log[0] || {})
      };
    });
    check('__duSendLog() returns structured entries', logShape.isArray && logShape.keys.includes('ts') && logShape.keys.includes('phase'), JSON.stringify(logShape));
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll silent-send checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

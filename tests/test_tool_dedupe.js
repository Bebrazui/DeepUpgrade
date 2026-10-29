// Tool-call dedupe regression test.
//
// The agent used to dedupe tool calls by block text for the whole session. When
// the model retried the same command in a new turn ("пробуй вновь"), the block
// was marked "Уже выполнено в этой сессии.", the sandbox was never called and
// no [SANDBOX OUTPUT] was sent, so the model starved. Dedupe now has to be
// scoped to the user turn: the same command in a new turn must execute again,
// while a re-render or reload of the same turn must not.

const fs = require('fs');
const path = require('path');
const http = require('http');
const { chromium } = require('playwright');

const CONTENT_PATH = path.resolve(__dirname, '..', 'extension', 'content.js');

function extractDedupeHelper(source) {
  const start = source.indexOf('// <du-tool-dedupe>');
  const end = source.indexOf('// </du-tool-dedupe>');
  if (start === -1 || end === -1 || end <= start) {
    throw new Error('Could not find <du-tool-dedupe> markers in content.js');
  }
  return source.slice(start, end);
}

const DEDUPE_HELPER = extractDedupeHelper(fs.readFileSync(CONTENT_PATH, 'utf8'));

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
    res.end('<!doctype html><html><body></body></html>');
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage();
  page.on('pageerror', (err) => console.log('[pageerror]', err.message));

  try {
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'load' });
    await page.addScriptTag({ content: DEDUPE_HELPER });

    const result = await page.evaluate(() => {
      const BLOCK_TEXT = '{"tool":"bash","code":"echo bash_alive"}';
      const BLOCK = 'du_' + BLOCK_TEXT.replace(/\s+/g, '').slice(0, 80);

      function addTurn(userText, messageText) {
        const user = document.createElement('div');
        user.className = 'fbb737a4';
        user.textContent = userText;
        document.body.appendChild(user);

        const message = document.createElement('div');
        message.className = 'ds-message';

        const prose = document.createElement('div');
        prose.textContent = messageText;

        const code = document.createElement('div');
        code.className = 'md-code-block';
        code.textContent = BLOCK_TEXT;

        message.appendChild(prose);
        message.appendChild(code);
        document.body.appendChild(message);

        return { user, message, code, block: code };
      }

      const first = addTurn('сделай smoke-тест', 'Запускаю проверку.');
      const firstKey = getToolBlockKey(first.block, BLOCK);

      // Same turn, React replaced the whole message node (re-render).
      const rerendered = document.createElement('div');
      rerendered.className = 'ds-message';
      const prose2 = document.createElement('div');
      prose2.textContent = 'Запускаю проверку.';
      const code2 = document.createElement('div');
      code2.className = 'md-code-block';
      code2.textContent = BLOCK_TEXT;
      rerendered.appendChild(prose2);
      rerendered.appendChild(code2);
      first.message.replaceWith(rerendered);
      const rerenderKey = getToolBlockKey(code2, BLOCK);

      // Same turn after execution: raw block hidden, widget rendered instead.
      code2.style.display = 'none';
      const widget = document.createElement('div');
      widget.className = 'opencode-tool-root';
      widget.textContent = 'Оболочка echo bash_alive bash_alive';
      rerendered.appendChild(widget);
      const executedKey = getToolBlockKey(code2, BLOCK);

      // New turn with the same command ("пробуй вновь").
      const retry = addTurn('пробуй вновь', 'Запускаю проверку.');
      const retryKey = getToolBlockKey(retry.block, BLOCK);

      const firstIsLatest = isLatestAssistantBlock(code2);
      const retryIsLatest = isLatestAssistantBlock(retry.block);

      // First load: every block already in the DOM is history, not work.
      const beforeSeed = executedTurns.has(getToolTurnKey(retry.block));
      seedHistoricalExecutions();
      const afterSeed = executedTurns.has(getToolTurnKey(retry.block));

      // Fallback identity when the user-bubble class is not present.
      document.querySelectorAll('.fbb737a4').forEach((node) => node.remove());
      const fallbackKey = (proseText) => {
        const message = document.createElement('div');
        message.className = 'ds-message';
        const prose = document.createElement('div');
        prose.textContent = proseText;
        const code = document.createElement('div');
        code.className = 'md-code-block';
        code.textContent = BLOCK_TEXT;
        message.appendChild(prose);
        message.appendChild(code);
        document.body.appendChild(message);
        return getToolBlockKey(code, BLOCK);
      };
      const fallbackKeyA = fallbackKey('Первый ответ без класса.');
      const fallbackKeyB = fallbackKey('Второй ответ без класса.');

      return {
        firstKey, rerenderKey, executedKey, retryKey, fallbackKeyA, fallbackKeyB,
        firstIsLatest, retryIsLatest, beforeSeed, afterSeed
      };
    });

    check('same turn survives React re-render', result.firstKey === result.rerenderKey, JSON.stringify(result));
    check('same turn after execution keeps the key', result.firstKey === result.executedKey, JSON.stringify(result));
    check('retry in a new turn gets a new key', result.firstKey !== result.retryKey, JSON.stringify(result));
    check('fallback message identity differs between turns', result.fallbackKeyA !== result.fallbackKeyB, JSON.stringify(result));
    check('old turn is not the latest turn', result.firstIsLatest === false, JSON.stringify(result));
    check('new turn is the latest turn', result.retryIsLatest === true, JSON.stringify(result));
    check('history seeding marks existing turns', result.beforeSeed === false && result.afterSeed === true, JSON.stringify(result));

    const shared = await page.evaluate(() => {
      const BLOCK_A = 'du_{"tool":"bash","code":"echo one"}';
      const BLOCK_B = 'du_{"tool":"bash","code":"echo two"}';
      const message = document.createElement('div');
      message.className = 'ds-message';
      const one = document.createElement('div');
      one.className = 'md-code-block';
      one.textContent = BLOCK_A;
      const two = document.createElement('div');
      two.className = 'md-code-block';
      two.textContent = BLOCK_B;
      message.appendChild(one);
      message.appendChild(two);
      document.body.appendChild(message);
      return {
        sameTurn: getToolTurnKey(one) === getToolTurnKey(two),
        differentBlockKey: getToolBlockKey(one, BLOCK_A) !== getToolBlockKey(two, BLOCK_B)
      };
    });
    check('blocks in one answer share the turn', shared.sameTurn === true, JSON.stringify(shared));
    check('blocks in one answer have distinct block keys', shared.differentBlockKey === true, JSON.stringify(shared));

    console.log('dedupe storage');
    const storage = await page.evaluate(() => {
      markExecuted('turn-a', 'block-a', 'output-a');
      markExecuted('turn-b', 'block-b', 'output-b');
      return {
        hasA: executedTurns.has('turn-a'),
        outputA: executedOutputs.get('block-a'),
        persisted: JSON.parse(sessionStorage.getItem(EXECUTED_KEY) || '[]'),
        outputs: JSON.parse(sessionStorage.getItem(EXECUTED_OUTPUT_KEY) || '[]')
      };
    });
    check('execution is recorded per turn', storage.hasA === true, JSON.stringify(storage));
    check('output is cached per block', storage.outputA === 'output-a', JSON.stringify(storage));
    check('execution is persisted for reloads', storage.persisted.includes('turn-a'), JSON.stringify(storage));
  } finally {
    await browser.close();
    server.close();
  }

  if (failures.length > 0) {
    console.error(`\n${failures.length} check(s) failed: ${failures.join(', ')}`);
    process.exit(1);
  }
  console.log('\nAll tool dedupe checks passed.');
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});

const { chromium } = require('playwright');
const http = require('http');
const fs = require('fs');

const injectedCss = fs.readFileSync('C:\\DeepUpgrade\\extension\\ui\\injected.css', 'utf8');

const mockHtml = `
<!DOCTYPE html>
<html>
<head>
  <meta charset="utf-8">
  <style>
    body { margin: 0; background: #131415; color: #fff; font-family: sans-serif; display: flex; flex-direction: column; height: 100vh; }
    .chat-container { flex: 1; overflow-y: auto; padding: 20px; }
    ._871cbca { position: fixed; bottom: 0; left: 0; right: 0; padding: 12px 16px; background: #131415; }
    ._77cefa5 { display: flex; flex-direction: column; background: #212224; border-radius: 16px; padding: 10px 12px; }
    ._020ab5b { display: flex; flex-direction: column; width: 100%; }
    ._24fad49 { position: relative; width: 100%; min-height: 40px; }
    textarea._27c9245 {
      width: 100%;
      min-height: 40px;
      border: none;
      background: transparent;
      color: white;
      outline: none;
      resize: none;
      font-family: inherit;
      font-size: 14px;
    }
    .ec4f5d61 { display: flex; justify-content: space-between; align-items: center; margin-top: 8px; }
    ._58b31c9 { display: flex; gap: 8px; }
    .bf38813a { display: flex; gap: 8px; align-items: center; }
    ._52c986b { width: 34px; height: 34px; border-radius: 50%; background: #3b82f6; cursor: pointer; display: flex; align-items: center; justify-content: center; }
  </style>
  <style id="du-injected-style">${injectedCss}</style>
</head>
<body>
  <div class="chat-container">
    <div>Сообщение истории 1</div>
    <div>Сообщение истории 2</div>
  </div>
  <div class="_871cbca">
    <div class="d72636e2"></div>
    <div class="aaff8b8f">
      <div class="_77cefa5 _3d616d3">
        <div class="_020ab5b">
          <div class="_24fad49">
            <textarea class="_27c9245 ds-scroll-area d96f2d2a" placeholder="Message DeepSeek" rows="2" data-du-hooked="true"></textarea>
          </div>
          <div class="ec4f5d61">
            <div class="_58b31c9">
              <div class="f79352dc ds-toggle-button du-agent-toggle-btn ds-toggle-button--selected" aria-pressed="true">Agent</div>
            </div>
            <div class="bf38813a">
              <div role="button" class="ds-button _52c986b bd74640a" tabindex="0">Send</div>
            </div>
          </div>
        </div>
      </div>
    </div>
  </div>
</body>
</html>
`;

async function runTest() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(mockHtml);
  });
  await new Promise(r => server.listen(8877, r));

  console.log('[Test] Server listening on http://localhost:8877');
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  await page.goto('http://localhost:8877/');

  // Set up real-time Layout Shift & Dimension Observer in page context
  await page.evaluate(() => {
    window.metricsLog = [];
    const textarea = document.querySelector('textarea');
    const container = document.querySelector('._77cefa5');

    function logState(tag) {
      const tRect = textarea.getBoundingClientRect();
      const cRect = container.getBoundingClientRect();
      window.metricsLog.push({
        tag,
        timestamp: performance.now(),
        textareaHeight: tRect.height,
        textareaTop: tRect.top,
        containerHeight: cRect.height,
        containerTop: cRect.top
      });
    }

    window.logState = logState;
    logState('initial');

    const ro = new ResizeObserver((entries) => {
      for (const entry of entries) {
        logState(`resize_${entry.target.tagName.toLowerCase()}_${entry.contentRect.height.toFixed(1)}`);
      }
    });
    ro.observe(textarea);
    ro.observe(container);
  });

  // Inject content.js
  const contentJs = fs.readFileSync('C:\\DeepUpgrade\\extension\\content.js', 'utf8');
  await page.evaluate(contentJs);

  console.log('[Test] Typing user message "проверь пайтон"...');
  await page.fill('textarea', 'проверь пайтон');
  await page.evaluate(() => window.logState('after_type'));

  console.log('[Test] Triggering Enter keydown...');
  await page.keyboard.press('Enter');

  await page.waitForTimeout(400);

  const logs = await page.evaluate(() => window.metricsLog);
  console.log('\n--- METRICS OF JITTER / LAYOUT SHIFT ---');
  let prevHeight = null;
  let jitterCount = 0;
  for (const m of logs) {
    const diff = prevHeight !== null ? (m.containerHeight - prevHeight) : 0;
    if (Math.abs(diff) > 2) jitterCount++;
    console.log(`[${m.tag.padEnd(30)}] Container H: ${m.containerHeight.toFixed(1)}px (delta: ${diff > 0 ? '+' : ''}${diff.toFixed(1)}px), Top: ${m.containerTop.toFixed(1)}px | Textarea H: ${m.textareaHeight.toFixed(1)}px`);
    prevHeight = m.containerHeight;
  }

  console.log(`\nTotal noticeable layout jumps: ${jitterCount}`);

  await browser.close();
  server.close();
}

runTest().catch(console.error);

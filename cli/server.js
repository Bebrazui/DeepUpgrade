#!/usr/bin/env node
'use strict';

/*
 * DeepUpgrade local API server.
 *
 * Exposes the DeepSeek direct HTTP path (challenge → PoW → completion) as:
 *
 *   POST /v1/chat/completions     OpenAI-compatible (stream and non-stream)
 *   GET  /v1/models               OpenAI-compatible model list
 *   GET  /v1/chats                local named chats
 *   POST /v1/chats                create a local chat
 *   GET  /v1/chats/:id            chat + local message mirror
 *   PATCH/DELETE /v1/chats/:id
 *   POST /v1/chats/import         import a chat from the DeepSeek account
 *   GET  /v1/deepseek/chats       chats from the DeepSeek account
 *   GET  /v1/deepseek/chats/:id/messages
 *   GET  /health
 *
 * Usage: node cli/server.js --help
 */

const http = require('http');
const crypto = require('crypto');
const { parseArgv } = require('./du');
const ds = require('./lib/client');
const chatsStore = require('./lib/chats');
const { loadConfig, configPath } = require('./lib/config');
const {
  applyCachedAuth,
  authenticateFromBrowser,
  withAuthRetry,
  isAuthError
} = require('./lib/auth');

const DEFAULT_PORT = 8787;
const DEFAULT_HOST = '127.0.0.1';
const MAX_BODY_BYTES = 10 * 1024 * 1024;

const VALUE_FLAGS = new Set([
  'token', 'cookie', 'base-url', 'timeout', 'threads', 'port', 'host', 'api-key',
  'browser', 'profile', 'login-timeout', 'model', 'session', 'mode', 'account',
  'transport', 'curl-path', 'impersonate', 'chrome-version', 'accept-language'
]);

const HELP = `
DeepUpgrade local API — OpenAI-совместимый сервер поверх DeepSeek.

Использование:
  node cli/server.js
  node cli/server.js --port 8787 --api-key secret
  node cli/server.js --token <token> --base-url https://chat.deepseek.com
  node cli/server.js --mode browser --account <id>

Режимы (--mode):
  direct   Прямой HTTP API: PoW + ваши заголовки. Токен из --token/кэша/браузера.
  browser  Через настоящий веб-клиент: запрос печатается в композер Chrome,
           поэтому shumei/x-hif-* заголовки генерирует сама страница.
           Нужен аккаунт из дашборда (--account). Один активный веб-чат
           на аккаунт; локальные /v1/chats и /v1/models тоже работают.

Маршруты:
  POST /v1/chat/completions     OpenAI Chat Completions (stream: true/false)
  GET  /v1/models               список моделей
  GET  /v1/chats                локальные чаты
  POST /v1/chats                создать локальный чат
  GET  /v1/chats/:id            чат и локальная история
  PATCH /v1/chats/:id           переименовать
  DELETE /v1/chats/:id          удалить локальный чат
  POST /v1/chats/import         импортировать чат из аккаунта
  GET  /v1/deepseek/chats       чаты в аккаунте DeepSeek
  GET  /v1/deepseek/chats/:id/messages
  GET  /health

Параметры:
      --port <n>            Порт (по умолчанию ${DEFAULT_PORT}).
      --host <addr>         Адрес (по умолчанию ${DEFAULT_HOST}; 0.0.0.0 — в сеть).
      --api-key <key>       Требовать Authorization: Bearer <key>
                            (или env DU_API_KEY).
      --model <name>        Модель по умолчанию (deepseek-chat).
      --mode <direct|browser> Как отправлять запросы (по умолчанию direct).
      --account <id>        Аккаунт дашборда для --mode browser.
      --window              Показать окно браузера в режиме browser.
      --timeout <сек>       Таймаут запросов к DeepSeek, 0 = без таймаута.
      --threads <n>         Потоков для PoW.
  -t, --token <token>       Bearer-токен (или env DEEPSEEK_TOKEN).
      --cookie <value>      Cookie (или env DEEPSEEK_COOKIE).
      --base-url <url>      По умолчанию ${ds.DEFAULT_BASE_URL}.
      --login               Принудительно перечитать токен из браузера.
      --browser <name>      chrome | edge | brave | chromium | vivaldi | default.
      --profile <sel>       Профиль браузера.
      --new-profile         Чистый временный профиль (вход в другой аккаунт).
      --login-timeout <сек> Сколько ждать входа (по умолчанию 180).
      --no-browser          Не открывать браузер.
      --no-cache            Не читать/не писать кэш токена.
      --verbose             Подробный лог запросов.
      --transport <type>     native | tls (по умолчанию: native). tls повторяет
                            браузерный TLS/HTTP2-отпечаток через curl_cffi.
      --curl-path <path>     Бинарник curl-impersonate. Если не задан, TLS
                            работает через Python-пакет curl_cffi.
      --impersonate <ver>    Браузер для имитации (по умолчанию: chrome131).
      --chrome-version <ver> Версия Chrome для User-Agent (по умолчанию: 131.0.0.0).
      --accept-language <lang> Язык для заголовков (по умолчанию: ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7).
  -h, --help                Эта справка.

Чат в запросе:
  Передайте "chat_id": "<локальный id>", чтобы продолжить локальный чат,
  или "deepseek_chat_id"/"chat_session_id" — чтобы продолжить серверный чат.
  Заголовок X-Chat-Id работает так же. Без привязки каждый запрос — новый чат,
  а история из messages[] передаётся модели транскриптом.
`;

function logLine(text) {
  process.stderr.write('[deepupgrade] ' + text + '\n');
}

function redact(token) {
  if (!token) return '(none)';
  if (token.length <= 12) return '***';
  return token.slice(0, 6) + '…' + token.slice(-4) + ` (len ${token.length})`;
}

function clientFromCtx(ctx) {
  return ds.createClient({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    cookie: ctx.cookie,
    timeoutMs: ctx.timeoutMs,
    threads: ctx.threads,
    transport: ctx.transport || 'native',
    curlPath: ctx['curl-path'],
    impersonate: ctx.impersonate || 'chrome131',
    chromeVersion: ctx['chrome-version'] || '131.0.0.0',
    acceptLanguage: ctx['accept-language'] || 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7'
  });
}

/* ------------------------------------------------------------------ HTTP --- */

function setCors(res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers',
    'authorization, content-type, x-api-key, x-chat-id, x-create-chat');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PATCH, DELETE, OPTIONS');
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload);
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body)
  });
  res.end(body);
}

function sendError(res, status, message, type) {
  sendJson(res, status, {
    error: {
      message: String(message),
      type: type || 'invalid_request_error',
      param: null,
      code: null
    }
  });
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    let size = 0;
    req.on('data', (chunk) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      const raw = Buffer.concat(chunks).toString('utf8');
      if (!raw.trim()) return resolve(null);
      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error('Invalid JSON body'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function contentText(content) {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'string') return part;
        if (part && typeof part.text === 'string') return part.text;
        return '';
      })
      .join('');
  }
  if (content == null) return '';
  return String(content);
}

function extractSystem(messages) {
  return messages
    .filter((m) => m && (m.role === 'system' || m.role === 'developer'))
    .map((m) => contentText(m.content))
    .filter(Boolean)
    .join('\n\n');
}

function lastUserMessage(messages) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i];
    if (m && m.role === 'user') return m;
  }
  return null;
}

/**
 * Text of everything that happened after the last assistant message: the new
 * user turn, a tool result, or a batch of parallel tool results. DeepSeek keeps
 * the earlier history server-side, so only this tail must be sent.
 */
function pendingTurnMessages(messages) {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }
  return messages
    .slice(lastAssistant + 1)
    .filter((m) => m && m.role !== 'system' && m.role !== 'developer');
}

function pendingTurnText(messages) {
  const pending = pendingTurnMessages(messages);
  if (pending.length === 0) return '';

  const toolNames = new Map();
  for (const m of messages) {
    if (!m || m.role !== 'assistant' || !Array.isArray(m.tool_calls)) continue;
    for (const call of m.tool_calls) {
      if (call && call.id) toolNames.set(call.id, call.function && call.function.name);
    }
  }

  return pending
    .map((m) => {
      const text = contentText(m.content).trim();
      if (!text) return '';
      if (m.role !== 'tool') return text;
      const name = toolNames.get(m.tool_call_id);
      const label = name ? `${name}${m.tool_call_id ? ' ' + m.tool_call_id : ''}` : (m.tool_call_id || '');
      return label ? `[TOOL RESULT ${label}]:\n${text}` : `[TOOL RESULT]:\n${text}`;
    })
    .filter(Boolean)
    .join('\n\n');
}

/**
 * Builds the single DeepSeek prompt string from an OpenAI messages array.
 * When continuing a bound chat, only the pending turn is sent (new user text or
 * tool output); otherwise the whole conversation is sent as a transcript so
 * stateless clients still work.
 */
function messagesToPrompt(messages, boundToSession, options) {
  const opts = options || {};
  const system = opts.system !== undefined ? opts.system : extractSystem(messages);
  const turns = messages.filter((m) => m && m.role !== 'system' && m.role !== 'developer');
  const last = lastUserMessage(turns);
  const lastText = last ? contentText(last.content).trim() : '';

  let prompt;
  if (boundToSession) {
    prompt = pendingTurnText(messages) || lastText;
  } else if (turns.length <= 1) {
    prompt = lastText;
  } else {
    prompt = turns
      .map((m) => {
        const role = m.role === 'assistant' ? 'Assistant' : m.role === 'tool' ? 'Tool' : 'User';
        return `${role}: ${contentText(m.content).trim()}`;
      })
      .join('\n\n');
  }

  if (system) prompt = `[SYSTEM INSTRUCTION: ${system}]\n\n${prompt}`;
  return prompt;
}

/**
 * Stable per-conversation identity supplied by agent clients (OpenCode sends
 * these on every model request: `x-opencode-session-id` is the session itself,
 * `x-session-affinity` groups child/forks with their source session).
 * Falls back to an explicit prompt-cache key.
 */
const AFFINITY_HEADERS = [
  'x-opencode-session-id',
  'x-session-affinity',
  'x-opencode-session',
  'x-session-id'
];

function requestAffinity(req, body) {
  for (const name of AFFINITY_HEADERS) {
    const value = req.headers[name];
    if (typeof value === 'string' && value) return value;
  }
  if (body && typeof body.prompt_cache_key === 'string' && body.prompt_cache_key) {
    return body.prompt_cache_key;
  }
  return '';
}

function modelSupportsThinking(model) {
  const name = String(model || '').toLowerCase();
  return name.includes('reasoner') || name.includes('reason') || name.includes('r1');
}

/*
 * DeepSeek emits tool calls inline as DSML markup and is not consistent about
 * its spelling. In practice it mixes all of:
 *   - ASCII `|` with fullwidth `｜`
 *   - one, two or more separators (`<|DSML||calls>`, `<||DSML||calls>`)
 *   - spaces around every separator (`< | | DSML | | calls>`)
 *   - `calls`, `function_calls` or `tool_calls`
 *
 * Harness clients only understand native `tool_calls`, so leaked markup ends up
 * in the transcript as the model's answer. Every tag head is therefore rewritten
 * to one canonical form first; the regexes below only parse that form.
 */
const DSML_TAG_HEAD_RE = /<\s*(\/?)\s*(?:[|｜]\s*)+DSML\s*(?:[|｜]\s*)+/gi;
const DSML_START_RE = /<\s*\/?\s*(?:[|｜]\s*)+DSML/i;
const DSML_CALLS_BLOCK_RE =
  /<\|DSML\|\|(?:(?:function_|tool_)?calls)\s*>([\s\S]*?)<\/\|DSML\|\|(?:(?:function_|tool_)?calls)\s*>/i;
const DSML_INVOKE_RE = /<\|DSML\|\|invoke\s*([^>]*)>([\s\S]*?)<\/\|DSML\|\|invoke\s*>/gi;
const DSML_PARAMETER_RE = /<\|DSML\|\|parameter\s*([^>]*)>([\s\S]*?)<\/\|DSML\|\|parameter\s*>/gi;
const ATTRIBUTE_RE = /([A-Za-z_][\w-]*)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+))/g;

/**
 * Extracts DeepSeek DSML tool calls from completion text:
 * <|DSML||calls>
 *   <|DSML||invoke name="execute">
 *     <|DSML||parameter name="code" string="true">...</|DSML||parameter>
 *   </|DSML||invoke>
 * </|DSML||calls>
 *
 * Returns content before and after the block separately, so a streaming
 * caller can flush the tail without repeating what it already sent.
 */
function normalizeDsml(text) {
  return String(text == null ? '' : text)
    .replace(DSML_TAG_HEAD_RE, (match, slash) => '<' + (slash || '') + '|DSML||');
}

/** Reads `name="x" string="true"` style attributes of a DSML tag. */
function parseAttributes(source) {
  const attrs = {};
  ATTRIBUTE_RE.lastIndex = 0;
  let match;
  while ((match = ATTRIBUTE_RE.exec(source || '')) !== null) {
    const value = match[2] !== undefined ? match[2]
      : match[3] !== undefined ? match[3] : match[4];
    attrs[match[1].toLowerCase()] = value;
  }
  return attrs;
}

function argumentValue(raw, stringFlag) {
  const text = String(raw == null ? '' : raw).trim();
  if (stringFlag === 'true') return text;
  try { return JSON.parse(text); } catch (e) { return text; }
}

/** Parses canonical `<|DSML||invoke>` blocks into OpenAI tool calls. */
function extractInvocations(block) {
  const toolCalls = [];
  let index = 0;
  DSML_INVOKE_RE.lastIndex = 0;
  let invokeMatch;
  while ((invokeMatch = DSML_INVOKE_RE.exec(block || '')) !== null) {
    const name = String(parseAttributes(invokeMatch[1]).name || '').trim();
    if (!name) continue;
    const args = {};
    DSML_PARAMETER_RE.lastIndex = 0;
    let paramMatch;
    while ((paramMatch = DSML_PARAMETER_RE.exec(invokeMatch[2])) !== null) {
      const attrs = parseAttributes(paramMatch[1]);
      if (!attrs.name) continue;
      args[attrs.name] = argumentValue(paramMatch[2], attrs.string);
    }
    toolCalls.push({
      id: `call_${Date.now().toString(36)}_${index++}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args)
      }
    });
  }
  return toolCalls;
}

function parseDsmlToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  const source = normalizeDsml(text);
  const match = DSML_CALLS_BLOCK_RE.exec(source);

  if (!match) {
    // Some runs drop the <calls> wrapper and print bare invoke blocks.
    if (!/<\|DSML\|\|invoke\b/i.test(source)) return null;
    const toolCalls = extractInvocations(source);
    if (!toolCalls.length) return null;
    return {
      cleanContent: source.replace(DSML_INVOKE_RE, '').trim(),
      trailing: '',
      toolCalls
    };
  }

  const contentBefore = source.slice(0, match.index).trim();
  const trailing = source.slice(match.index + match[0].length).trim();
  const toolCalls = extractInvocations(match[1]);

  return {
    cleanContent: [contentBefore, trailing].filter(Boolean).join('\n\n'),
    trailing,
    toolCalls: toolCalls.length > 0 ? toolCalls : null
  };
}

/**
 * True while the buffer tail (starting at '<') can still grow into a DSML tag
 * head, e.g. `<`, `<|`, `< | | DSML`. Keeps a split tag from being streamed
 * out before it can be recognised.
 */
function isDsmlTagPrefix(tail) {
  if (!tail || tail[0] !== '<') return false;
  const rest = tail.slice(1).replace(/[\s|｜/]/g, '').toLowerCase();
  return rest.length <= 4 && 'dsml'.startsWith(rest);
}

/**
 * Renders OpenAI `tools` into the single DeepSeek prompt: the direct web API
 * has no tool channel, so the model has to be told both the schemas and the
 * DSML markup this server parses back into `tool_calls`.
 */
function renderToolsPrompt(tools) {
  const specs = (Array.isArray(tools) ? tools : [])
    .map((tool) => (tool && tool.function ? tool.function : tool))
    .filter((spec) => spec && spec.name);

  if (!specs.length) return '';

  const lines = [
    '[TOOLS]',
    'You can call the tools below. To call one, answer with this block and nothing else:',
    '<|DSML||calls>',
    '<|DSML||invoke name="TOOL_NAME">',
    '<|DSML||parameter name="ARG" string="true">VALUE</|DSML||parameter>',
    '</|DSML||invoke>',
    '</|DSML||calls>',
    'Repeat the invoke block for several calls. Use string="false" for JSON, number and boolean arguments.',
    'Never print this markup in prose or in reasoning, and never invent tool names.',
    'Tool results come back as [TOOL RESULT ...] messages.',
    'Available tools:'
  ];

  for (const spec of specs) {
    const description = String(spec.description || '').replace(/\s+/g, ' ').trim();
    lines.push(`- ${spec.name}${description ? ': ' + description : ''}`);
    const parameters = spec.parameters || spec.input_schema;
    if (parameters) lines.push(`  parameters: ${JSON.stringify(parameters)}`);
  }

  return lines.join('\n');
}

function appendToolsPrompt(prompt, tools) {
  const section = renderToolsPrompt(tools);
  return section ? `${prompt}\n\n${section}` : prompt;
}

/** Drops an unparsed DSML block so raw markup never reaches the client. */
function stripUnparsedDsml(text) {
  const match = DSML_START_RE.exec(text || '');
  if (!match) return text;
  return text.slice(0, match.index).trim();
}

function sseHeaders(res) {
  res.writeHead(200, {
    'content-type': 'text/event-stream; charset=utf-8',
    'cache-control': 'no-cache, no-transform',
    connection: 'keep-alive',
    'x-accel-buffering': 'no'
  });
  if (typeof res.flushHeaders === 'function') res.flushHeaders();
}

function sseWrite(res, payload) {
  if (res.writableEnded || res.destroyed) return false;
  res.write(`data: ${JSON.stringify(payload)}\n\n`);
  return true;
}

/* -------------------------------------------------------- completion flow --- */

/** Lazily opens the warm browser session used by --mode browser. */
async function openWebSession(ctx) {
  if (ctx.web.session) return ctx.web.session;
  const webSession = require('./lib/web-session');
  ctx.web.session = await webSession.openSession(ctx.web.accountId, {
    windowed: !!ctx.web.windowed
  });
  return ctx.web.session;
}

/**
 * Adapts web-session's event callbacks to the async iterator shape used by the
 * direct client, so the rest of the OpenAI server code stays unchanged.
 */
function webEventIterator(session, prompt, options) {
  const opts = options || {};
  const queue = [];
  const waiters = [];
  let finished = false;
  let failure = null;

  const settle = () => {
    while (waiters.length) {
      if (queue.length) {
        waiters.shift().resolve({ done: false, value: queue.shift() });
        continue;
      }
      if (failure) {
        waiters.shift().reject(failure);
        continue;
      }
      if (finished) {
        waiters.shift().resolve({ done: true, value: { responseMessageId: null } });
        continue;
      }
      break;
    }
  };

  const push = (event) => {
    if (finished) return;
    queue.push(event);
    settle();
  };
  const finish = (err) => {
    if (finished) return;
    finished = true;
    failure = err || null;
    settle();
  };

  if (opts.signal) {
    if (opts.signal.aborted) finish(new Error('aborted'));
    else opts.signal.addEventListener('abort', () => finish(new Error('aborted')), { once: true });
  }

  const run = session.send(prompt, {
    onEvent: (event) => {
      if (!event) return;
      if (event.type === 'content') push({ type: 'content', text: event.delta });
      else if (event.type === 'thinking') push({ type: 'thinking', text: event.delta });
      else if (event.type === 'done') {
        const result = event.result || {};
        if (result.ok) {
          push({ type: 'status', value: 'FINISHED' });
          finish();
        } else {
          finish(new Error(result.error || 'Веб-клиент не вернул ответ'));
        }
      }
    }
  });

  run.then((result) => {
    if (finished) return;
    if (result && result.ok) {
      push({ type: 'status', value: 'FINISHED' });
      finish();
    } else {
      finish(new Error((result && result.error) || 'Веб-клиент не вернул ответ'));
    }
  }, (err) => finish(err || new Error('Веб-клиент не вернул ответ')));

  return {
    next() {
      if (queue.length) return Promise.resolve({ done: false, value: queue.shift() });
      if (failure) return Promise.reject(failure);
      if (finished) return Promise.resolve({ done: true, value: { responseMessageId: null } });
      return new Promise((resolve, reject) => waiters.push({ resolve, reject }));
    }
  };
}

/**
 * Creates the session (unless given), fetches/solves PoW and opens the SSE
 * stream, forcing the first chunk to be read inside the auth-retry scope so a
 * 401 is retried before anything is written to the HTTP client.
 */
async function startCompletion(ctx, args, config, options) {
  const opts = options || {};
  if (ctx.web) {
    const session = opts.session || ('web:' + ctx.web.accountId);
    const web = await openWebSession(ctx);
    const iterator = webEventIterator(web, opts.prompt, { signal: opts.signal });
    const first = await iterator.next();
    return { session, iterator, first, body: { prompt: opts.prompt } };
  }
  return withAuthRetry(
    ctx, args, config, true,
    () => logLine('токен отвергнут — перечитываю из браузера'),
    async () => {
      const client = clientFromCtx(ctx);
      const session = opts.session || await ds.createSession(client);

      const challengeJson = await ds.fetchChallenge(client);
      const challenge = ds.extractChallenge(challengeJson);
      if (!challenge) {
        throw new Error('No challenge in response: ' + JSON.stringify(challengeJson));
      }
      const solved = await ds.solvePoW(challenge, { threads: ctx.threads });

      const body = {
        chat_session_id: session,
        parent_message_id: opts.parent === undefined || opts.parent === ''
          ? null
          : (/^\d+$/.test(String(opts.parent)) ? Number(opts.parent) : opts.parent),
        model_type: 'default',
        prompt: opts.prompt,
        ref_file_ids: [],
        thinking_enabled: !!opts.thinking
      };
      if (opts.search) body.search_enabled = true;
      body.action = null;
      body.preempt = false;

      const iterator = ds.completion(
        client, body, solved.powHeader, { signal: opts.signal }
      );
      const first = await iterator.next();
      return { session, iterator, first, challenge, solved, body };
    }
  );
}

function completionId() {
  return 'chatcmpl-' + crypto.randomBytes(12).toString('hex');
}

function promptDigest(text) {
  return crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 16);
}

/* ---------------------------------------------------------------- routes --- */

async function handleChatCompletions(req, res, ctx, args, config, store, state) {
  const body = await readBody(req);
  if (!body || !Array.isArray(body.messages) || body.messages.length === 0) {
    return sendError(res, 400, 'messages must be a non-empty array');
  }

  logLine(`incoming tools: ${body.tools ? body.tools.length : 0}, stream: ${body.stream}`);

  const requestedModel = String(body.model || state.defaultModel || 'deepseek-chat');
  const thinking = body.thinking_enabled !== undefined
    ? !!body.thinking_enabled
    : modelSupportsThinking(requestedModel);
  const search = !!body.search_enabled;

  const headerChatId = req.headers['x-chat-id'];
  const chatId = body.chat_id || body.conversation_id || headerChatId || '';
  const explicitSession = String(body.deepseek_chat_id || body.chat_session_id || '');
  const wantsNewChat = !chatId && (
    body.create_chat === true || req.headers['x-create-chat'] === '1'
  );

  let chat = null;
  if (chatId) {
    chat = chatsStore.getChat(store, String(chatId));
    if (!chat) return sendError(res, 404, `chat not found: ${chatId}`);
  }

  // Derive conversation key for stateless clients (e.g. OpenCode) that send full message history.
  // Agent clients identify the conversation with headers; hashing the first user message is only
  // a fallback, because that text changes whenever a client injects a system reminder or skills.
  const turns = body.messages.filter((m) => m && m.role !== 'system' && m.role !== 'developer');
  const affinity = requestAffinity(req, body);
  let convKey = '';
  if (affinity) {
    convKey = 'affinity:' + affinity;
  } else if (turns.length > 0) {
    const firstTurn = turns[0];
    const firstContent = contentText(firstTurn.content).trim();
    if (firstContent) {
      convKey = 'first:' + crypto.createHash('sha256').update(firstContent).digest('hex').slice(0, 16);
    }
  }

  let session = explicitSession || (chat && chat.deepseek_session_id) || '';
  let parent = (chat && chat.parent_message_id !== undefined)
    ? chat.parent_message_id
    : (body.parent_message_id !== undefined ? body.parent_message_id : null);
  // In browser mode the page keeps the conversation, so the first request has
  // to carry the transcript and every later one only the new tail.
  let boundToSession = false;

  if (ctx.web) {
    session = 'web:' + ctx.web.accountId;
    parent = null;
    boundToSession = !!ctx.web.started;
  } else {
    // Explicitly started or seeded conversation when the request carries no chat/session hint.
    // Only a bare single-turn request can be assumed to continue the active session: a
    // transcript from a stateless client must be sent whole, or its history is silently lost.
    if (!session && !wantsNewChat && state.activeSessionId && turns.length <= 1) {
      session = state.activeSessionId;
      if (parent === null && state.activeParentMessageId !== null) parent = state.activeParentMessageId;
    }

    // If not bound to a local chat and no explicit session was passed, continue the
    // DeepSeek session that belongs to this conversation.
    if (!chat && !explicitSession && !wantsNewChat && convKey) {
      const existing = state.conversationSessions.get(convKey);
      if (existing && (affinity || turns.length > 1)) {
        session = existing.sessionId;
        parent = existing.parentMessageId;
      }
    }

    boundToSession = !!session;
  }

  // DeepSeek keeps the conversation on its side, so the system prompt and the
  // tool schemas only have to enter a session once. Re-sending them on every
  // turn (a tool result may be two lines) dominates the request and the tokens.
  const systemText = extractSystem(body.messages);
  const toolsSection = renderToolsPrompt(body.tools);
  const systemSig = systemText ? promptDigest(systemText) : '';
  const toolsSig = toolsSection ? promptDigest(toolsSection) : '';
  const sentBefore = session ? state.promptCache.get(session) : null;
  const includeSystem = !!systemSig && (!sentBefore || sentBefore.system !== systemSig);
  const includeTools = !!toolsSig && (!sentBefore || sentBefore.tools !== toolsSig);

  const basePrompt = messagesToPrompt(body.messages, boundToSession, {
    system: includeSystem ? systemText : ''
  });
  if (!basePrompt || !basePrompt.trim()) {
    return sendError(res, 400, 'no user message with text content');
  }
  const prompt = includeTools ? `${basePrompt}\n\n${toolsSection}` : basePrompt;

  const model = requestedModel;
  const id = completionId();
  const created = Math.floor(Date.now() / 1000);
  const stream = !!body.stream;

  // Abort the upstream request if the HTTP client goes away.
  const controller = new AbortController();
  res.on('close', () => {
    if (!res.writableEnded) controller.abort();
  });

  let started;
  try {
    started = await startCompletion(ctx, args, config, {
      session,
      parent,
      prompt,
      thinking,
      search,
      signal: controller.signal
    });
  } catch (err) {
    return mapUpstreamError(res, err);
  }

  if (ctx.web) ctx.web.started = true;

  // Remember what this session already carries, so the next turn can send only
  // the new tool result / user message.
  const sentNow = {
    system: includeSystem ? systemSig : (sentBefore ? sentBefore.system : ''),
    tools: includeTools ? toolsSig : (sentBefore ? sentBefore.tools : '')
  };
  if (sentNow.system || sentNow.tools) {
    state.promptCache.set(started.session, sentNow);
    if (state.promptCache.size > 200) {
      state.promptCache.delete(state.promptCache.keys().next().value);
    }
  }

  const userText = contentText((lastUserMessage(body.messages) || {}).content);
  // Only the tail after the last assistant message is actually new. Tool-loop
  // turns carry the same user message again, so mirroring `userText` blindly
  // used to duplicate it on every tool result.
  const pendingMessages = pendingTurnMessages(body.messages);
  const pendingUsers = pendingMessages
    .filter((m) => m && m.role === 'user')
    .map((m) => contentText(m.content))
    .filter((text) => text.trim());
  const pendingHasToolResult = pendingMessages.some((m) => m && m.role === 'tool');
  let chatForResponse = chat ? chat.id : null;

  const finalize = (content, thinkingText, messageId) => {
    if (chat) {
      if (!pendingHasToolResult) {
        for (const text of pendingUsers) {
          chatsStore.appendMessage(store, chat, { role: 'user', content: text });
        }
      }
      if (content || thinkingText) {
        chatsStore.appendMessage(store, chat, {
          role: 'assistant',
          content,
          thinking: thinkingText,
          message_id: messageId
        });
      }
      chatsStore.updateChat(store, chat, {
        deepseek_session_id: started.session,
        parent_message_id: messageId === null || messageId === undefined
          ? chat.parent_message_id
          : messageId
      });
    } else if (wantsNewChat) {
      const created2 = chatsStore.createChat(store, {
        title: chatsStore.autoTitle(userText),
        deepseek_session_id: started.session,
        parent_message_id: messageId === null || messageId === undefined ? null : messageId
      });
      for (const text of pendingUsers.length ? pendingUsers : [userText]) {
        if (text.trim()) chatsStore.appendMessage(store, created2, { role: 'user', content: text });
      }
      if (content || thinkingText) {
        chatsStore.appendMessage(store, created2, {
          role: 'assistant',
          content,
          thinking: thinkingText,
          message_id: messageId
        });
      }
      chatForResponse = created2.id;
    }
    if (messageId !== null && messageId !== undefined) {
      state.activeSessionId = started.session;
      state.activeParentMessageId = messageId;
      if (convKey) {
        state.conversationSessions.set(convKey, {
          sessionId: started.session,
          parentMessageId: messageId,
          lastUsed: Date.now()
        });
        // Prune stale cache entries if too large
        if (state.conversationSessions.size > 200) {
          const oldestKey = state.conversationSessions.keys().next().value;
          state.conversationSessions.delete(oldestKey);
        }
      }
    }
    return {
      chat_id: chatForResponse,
      session_id: started.session,
      message_id: messageId
    };
  };

  const startedAt = Date.now();
  const sentParts = [`prompt=${prompt.length}`];
  if (systemSig && !includeSystem) sentParts.push('system=cached');
  if (toolsSig && !includeTools) sentParts.push('tools=cached');
  logLine(`completion start model=${model} session=${started.session} ` +
    `thinking=${thinking} stream=${stream} chat=${chat ? chat.id : '-'} ` +
    sentParts.join(' '));

  if (!stream) {
    const result = await collectIterator(started);
    const parsedDsml = parseDsmlToolCalls(result.content);
    const tcCount = parsedDsml ? parsedDsml.toolCalls.length : 0;
    logLine(`parseDsmlToolCalls result: toolCalls=${tcCount}`);
    logLine(`parseDsmlToolCalls firstToolName=${tcCount > 0 ? parsedDsml.toolCalls[0].function.name : 'none'}`);
    logLine(`parseDsmlToolCalls firstArgs=${tcCount > 0 ? parsedDsml.toolCalls[0].function.arguments : 'none'}`);
    let finalContent = parsedDsml ? parsedDsml.cleanContent : result.content;
    const toolCalls = parsedDsml ? parsedDsml.toolCalls : null;
    if (!parsedDsml && DSML_START_RE.test(result.content)) {
      logLine('DSML markup was not parsed; dropping it from the reply');
      finalContent = stripUnparsedDsml(result.content);
    }
    const finishReason = toolCalls ? 'tool_calls' : 'stop';

    const extra = finalize(result.content, result.thinking, result.responseMessageId);
    // DeepSeek only reports one running total, so it is the best value available
    // for each OpenAI usage field (previously this was hardcoded to zero).
    const tokens = result.tokenUsage || 0;
    logLine(`completion done ${Date.now() - startedAt} ms, ${result.content.length} chars` +
      (toolCalls ? ` (${toolCalls.length} tool calls)` : ''));
    return sendJson(res, 200, {
      id,
      object: 'chat.completion',
      created,
      model,
      choices: [{
        index: 0,
        message: {
          role: 'assistant',
          content: finalContent,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
          ...(thinking && result.thinking ? { reasoning_content: result.thinking } : {})
        },
        finish_reason: finishReason
      }],
      usage: { prompt_tokens: tokens, completion_tokens: tokens, total_tokens: tokens },
      x_deepseek: extra
    });
  }

  sseHeaders(res);
  sseWrite(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }]
  });

  let content = '';
  let thinkingText = '';
  let messageId = null;
  let tokenUsage = 0;
  let finishReason = 'stop';
  // Reply text without the DSML block, kept for the local chat mirror.
  let storedContent = null;

  // Buffer for content to prevent raw DSML tags from leaking into stream
  // before we know whether it is a tool call or regular text.
  let pendingContent = '';
  let insideDsml = false;

  const flushContent = (text) => {
    if (!text) return;
    sseWrite(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: { content: text }, finish_reason: null }]
    });
  };

  try {
    const handle = (event) => {
      if (!event) return;
      if (event.type === 'content') {
        content += event.text;
        pendingContent += event.text;

        if (!insideDsml) {
          // Check if a DSML block might be starting
          const dsmlStartIdx = pendingContent.search(DSML_START_RE);
          if (dsmlStartIdx !== -1) {
            // Flush text before the tag
            if (dsmlStartIdx > 0) {
              flushContent(pendingContent.slice(0, dsmlStartIdx));
              pendingContent = pendingContent.slice(dsmlStartIdx);
            }
            insideDsml = true;
          } else {
            // Hold back a trailing '<' that may still become a split DSML tag.
            const partialIdx = pendingContent.lastIndexOf('<');
            if (partialIdx !== -1 && isDsmlTagPrefix(pendingContent.slice(partialIdx))) {
              const safe = pendingContent.slice(0, partialIdx);
              if (safe) flushContent(safe);
              pendingContent = pendingContent.slice(partialIdx);
            } else {
              flushContent(pendingContent);
              pendingContent = '';
            }
          }
        }
      } else if (event.type === 'thinking') {
        thinkingText += event.text;
        sseWrite(res, {
          id, object: 'chat.completion.chunk', created, model,
          choices: [{ index: 0, delta: { reasoning_content: event.text }, finish_reason: null }]
        });
      } else if (event.type === 'message_id') {
        messageId = event.id;
      } else if (event.type === 'usage') {
        tokenUsage = Number(event.value) || 0;
      }
    };

    // First chunk was already pulled inside the retry scope.
    const first = started.first;
    if (!first.done) handle(first.value);
    while (true) {
      const step = await started.iterator.next();
      if (step.done) {
        if (step.value && step.value.responseMessageId !== null) {
          messageId = step.value.responseMessageId;
        }
        break;
      }
      handle(step.value);
    }

    // After stream finished, check if DSML calls were collected
    const parsedDsml = parseDsmlToolCalls(content);
    if (parsedDsml && parsedDsml.toolCalls) {
      finishReason = 'tool_calls';
      storedContent = parsedDsml.cleanContent;
      // Text that followed the block was held back with it; flush it now.
      if (parsedDsml.trailing) flushContent(parsedDsml.trailing);
      // Emit delta tool_calls chunk for OpenAI streaming clients
      for (let i = 0; i < parsedDsml.toolCalls.length; i++) {
        const tc = parsedDsml.toolCalls[i];
        sseWrite(res, {
          id, object: 'chat.completion.chunk', created, model,
          choices: [{
            index: 0,
            delta: {
              tool_calls: [{
                index: i,
                id: tc.id,
                type: 'function',
                function: {
                  name: tc.function.name,
                  arguments: tc.function.arguments
                }
              }]
            },
            finish_reason: null
          }]
        });
      }
    } else if (pendingContent) {
      if (insideDsml) {
        // Unparseable tool markup: never leak raw DSML into the transcript.
        logLine('DSML markup was not parsed; dropping it from the stream');
        storedContent = stripUnparsedDsml(content);
      } else {
        // Flush any remaining buffered plain text
        flushContent(pendingContent);
      }
      pendingContent = '';
    }
  } catch (err) {
    logLine('stream failed: ' + err.message);
    sseWrite(res, {
      error: {
        message: err.message,
        type: isAuthError(err) ? 'authentication_error' : 'upstream_error',
        code: err.apiCode !== undefined ? err.apiCode : null
      }
    });
  }

  const extra = finalize(storedContent !== null ? storedContent : content, thinkingText, messageId);
  sseWrite(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    x_deepseek: extra
  });
  // Send usage once in a final chunk before DONE (OpenAI-compatible streaming)
  if (tokenUsage > 0) {
    sseWrite(res, {
      id, object: 'chat.completion.chunk', created, model,
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: tokenUsage, completion_tokens: tokenUsage, total_tokens: tokenUsage }
    });
  }
  if (!res.writableEnded && !res.destroyed) res.write('data: [DONE]\n\n');
  res.end();
  logLine(`completion stream done ${Date.now() - startedAt} ms, ${content.length} chars`);
}

async function collectIterator(started) {
  const state = { content: '', thinking: '', responseMessageId: null, tokenUsage: 0 };
  const handle = (event) => {
    if (!event) return;
    if (event.type === 'content') state.content += event.text;
    else if (event.type === 'thinking') state.thinking += event.text;
    else if (event.type === 'message_id') state.responseMessageId = event.id;
    else if (event.type === 'usage') state.tokenUsage = Number(event.value) || 0;
  };
  if (!started.first.done) handle(started.first.value);
  while (true) {
    const step = await started.iterator.next();
    if (step.done) {
      if (step.value && step.value.responseMessageId !== null) {
        state.responseMessageId = step.value.responseMessageId;
      }
      break;
    }
    handle(step.value);
  }
  return state;
}

function mapUpstreamError(res, err) {
  if (err && err.status === 401) {
    return sendError(res, 401, err.message, 'authentication_error');
  }
  if (err && err.status === 429) {
    return sendError(res, 429, err.message, 'rate_limit_error');
  }
  const message = String((err && err.message) || err || '');
  if (/Токен не найден|не авторизован|разлогинен/i.test(message)) {
    return sendError(res, 401, message, 'authentication_error');
  }
  if (/заблокирован|suspended/i.test(message)) {
    return sendError(res, 403, message, 'account_suspended');
  }
  if (/hCaptcha|Send failed|muted/i.test(message)) {
    return sendError(res, 429, message, 'account_limited');
  }
  const status = (err && Number.isInteger(err.status) && err.status >= 400 && err.status < 600)
    ? err.status
    : 502;
  return sendError(res, status, (err && err.message) || String(err), 'upstream_error');
}

async function handleChats(req, res, ctx, method, segments, store, state) {
  // /v1/chats
  if (segments.length === 0) {
    if (method === 'GET') {
      return sendJson(res, 200, { object: 'list', data: chatsStore.listChats(store) });
    }
    if (method === 'POST') {
      const body = await readBody(req);
      const chat = chatsStore.createChat(store, {
        title: (body && body.title) || 'Новый чат',
        deepseek_session_id: body && body.deepseek_session_id
      });
      return sendJson(res, 201, chatsStore.toSummary(chat));
    }
    return sendError(res, 405, 'method not allowed');
  }

  if (segments[0] === 'import') {
    if (ctx.web) {
      return sendError(res, 501,
        'chat import is not available in browser mode', 'not_implemented');
    }
    if (method !== 'POST') return sendError(res, 405, 'method not allowed');
    const body = await readBody(req);
    const sessionId = body && (body.session_id || body.chat_session_id);
    if (!sessionId) return sendError(res, 400, 'session_id is required');
    try {
      const history = await ds.getChatHistory(clientFromCtx(ctx), String(sessionId));
      const chat = chatsStore.importChat(store, history, {
        session_id: String(sessionId),
        title: body.title
      });
      return sendJson(res, 201, chat);
    } catch (err) {
      return mapUpstreamError(res, err);
    }
  }

  const id = segments[0];
  const chat = chatsStore.getChat(store, id);
  if (!chat) return sendError(res, 404, `chat not found: ${id}`);

  if (method === 'GET') return sendJson(res, 200, chat);
  if (method === 'PATCH') {
    const body = await readBody(req);
    chatsStore.updateChat(store, chat, body || {});
    return sendJson(res, 200, chat);
  }
  if (method === 'DELETE') {
    chatsStore.deleteChat(store, id);
    return sendJson(res, 200, { deleted: true, id });
  }
  return sendError(res, 405, 'method not allowed');
}

async function handleDeepseekChats(res, ctx, method, segments, url) {
  if (method !== 'GET') return sendError(res, 405, 'method not allowed');

  if (segments.length === 0) {
    try {
      const count = Math.min(Math.max(Number(url.searchParams.get('count')) || 50, 1), 100);
      const result = await ds.listChats(clientFromCtx(ctx), {
        count,
        cursor: url.searchParams.get('cursor') || undefined
      });
      return sendJson(res, 200, {
        object: 'list',
        data: result.chats.map((chat) => ({
          id: chat.id,
          object: 'chat',
          title: chat.title,
          model_type: chat.model_type,
          pinned: !!chat.pinned,
          updated_at: chat.updated_at
        })),
        has_more: result.hasMore
      });
    } catch (err) {
      return mapUpstreamError(res, err);
    }
  }

  const sessionId = segments[0];
  if (segments[1] !== 'messages') {
    return sendError(res, 404, 'not found');
  }
  try {
    const history = await ds.getChatHistory(clientFromCtx(ctx), sessionId);
    return sendJson(res, 200, {
      id: sessionId,
      title: history.session ? history.session.title : null,
      object: 'chat.history',
      data: history.messages.map(ds.normalizeMessage)
    });
  } catch (err) {
    return mapUpstreamError(res, err);
  }
}

/* ------------------------------------------------------------------ main --- */

async function main() {
  const args = parseArgv(process.argv.slice(2), VALUE_FLAGS);
  if (args.help) {
    process.stdout.write(HELP.trimStart());
    return;
  }

  const port = args.port === undefined ? DEFAULT_PORT : Number(args.port);
  if (!Number.isInteger(port) || port < 0 || port > 65535) {
    throw new Error('Некорректный --port: ' + args.port);
  }
  const host = args.host ? String(args.host) : DEFAULT_HOST;
  const apiKey = String(args['api-key'] || process.env.DU_API_KEY || '');
  const config = args['no-cache'] ? null : loadConfig();

  const mode = String(args.mode || process.env.DU_MODE || 'direct').toLowerCase();
  if (mode !== 'direct' && mode !== 'browser') {
    throw new Error(`Неизвестный режим: ${args.mode}. Используйте direct или browser.`);
  }
  const accountId = String(args.account || process.env.DU_WEB_ACCOUNT || '');
  if (mode === 'browser' && !accountId) {
    throw new Error('Для --mode browser нужен --account <id> (id аккаунта из дашборда).');
  }

  const ctx = {
    baseUrl: String(args['base-url'] || ds.DEFAULT_BASE_URL).replace(/\/+$/, ''),
    token: ds.normalizeToken(args.token || process.env.DEEPSEEK_TOKEN || ''),
    cookie: String(args.cookie || process.env.DEEPSEEK_COOKIE || ''),
    timeoutMs: Number(args.timeout) > 0 ? Number(args.timeout) * 1000 : 0,
    threads: args.threads === undefined ? undefined : Number(args.threads),
    transport: args.transport || 'native',
    'curl-path': args['curl-path'],
    impersonate: args.impersonate,
    'chrome-version': args['chrome-version'],
    'accept-language': args['accept-language'],
    web: mode === 'browser'
      ? { accountId, windowed: !!args.window, started: false, session: null }
      : null
  };
  ctx.explicitToken = !!ctx.token;

  // Browser mode authenticates through the page itself, so the token cache
  // and the direct API browser handshake are not involved at all.
  if (!ctx.web) {
    if (args.login) {
      ctx.token = '';
      ctx.explicitToken = false;
      if (config) {
        const { clearCachedAuth } = require('./lib/config');
        clearCachedAuth(config);
      }
    }

    if (!ctx.token && config) await applyCachedAuth(ctx, config);

    if (!ctx.token && !args['no-browser']) {
      await authenticateFromBrowser(ctx, args, config, true);
    }

    if (!ctx.token) {
      throw new Error('Нужен токен: --token, DEEPSEEK_TOKEN, кэш или браузер ' +
        '(уберите --no-browser).');
    }
  }

  const store = chatsStore.loadChats();
  const state = {
    defaultModel: args.model ? String(args.model) : 'deepseek-chat',
    // Cache for conversation threads to reuse DeepSeek session & parent_message_id
    conversationSessions: new Map(), // convKey -> { sessionId, parentMessageId, lastUsed }
    // session id -> digests of the system prompt and tool schemas it already has
    promptCache: new Map(),
    activeSessionId: args.session ? String(args.session) : null,
    activeParentMessageId: null
  };

  const server = http.createServer((req, res) => {
    const startedAt = Date.now();
    setCors(res);

    let url;
    try {
      url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    } catch (err) {
      return sendError(res, 400, 'bad request url');
    }

    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      return res.end();
    }

    const method = req.method || 'GET';
    const path = url.pathname.replace(/\/+$/, '') || '/';
    const segments = path.split('/').filter(Boolean);

    res.on('finish', () => {
      if (args.verbose) {
        logLine(`${method} ${path} ${res.statusCode} ${Date.now() - startedAt} ms`);
      }
    });

    // Optional local API key. Health stays open for probes.
    if (apiKey && path !== '/health') {
      const auth = req.headers.authorization || '';
      const presented = auth.startsWith('Bearer ')
        ? auth.slice(7)
        : (req.headers['x-api-key'] || '');
      if (presented !== apiKey) {
        return sendError(res, 401, 'invalid local API key', 'authentication_error');
      }
    }

    const route = (fn) => {
      Promise.resolve(fn()).catch((err) => {
        logLine('request error: ' + (err && err.message ? err.message : err));
        if (res.headersSent) {
          try { res.end(); } catch (e) { /* ignore */ }
          return;
        }
        if (err && err.status === 400) return sendError(res, 400, err.message);
        sendError(res, 500, (err && err.message) || String(err), 'server_error');
      });
    };

    if (path === '/health' && method === 'GET') {
      return sendJson(res, 200, {
        ok: true,
        service: 'deepupgrade-local-api',
        model: state.defaultModel,
        mode: ctx.web ? 'browser' : 'direct',
        account: ctx.web ? ctx.web.accountId : null,
        token: ctx.web ? 'browser' : (ctx.fromCache ? 'cached' : 'provided'),
        chats: Object.keys(store.chats).length,
        base_url: ctx.web ? 'browser://web-client' : ctx.baseUrl
      });
    }

    if (path === '/v1/models' && method === 'GET') {
      return sendJson(res, 200, {
        object: 'list',
        data: [
          { id: 'deepseek-chat', object: 'model', created: 1700000000, owned_by: 'deepseek' },
          { id: 'deepseek-reasoner', object: 'model', created: 1700000000, owned_by: 'deepseek' }
        ]
      });
    }

    if (path === '/v1/chat/completions' && method === 'POST') {
      return route(() => handleChatCompletions(req, res, ctx, args, config, store, state));
    }

    if (segments[0] === 'v1' && segments[1] === 'chats') {
      return route(() => handleChats(req, res, ctx, method, segments.slice(2), store, state));
    }

    if (segments[0] === 'v1' && segments[1] === 'deepseek' && segments[2] === 'chats') {
      if (ctx.web) {
        return sendError(res, 501,
          'account chat APIs are not available in browser mode', 'not_implemented');
      }
      return route(() => handleDeepseekChats(res, ctx, method, segments.slice(3), url));
    }

    return sendError(res, 404, `not found: ${method} ${path}`);
  });

  server.on('error', (err) => {
    logLine('server error: ' + err.message);
    process.exitCode = 1;
  });

  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, host, resolve);
  });

  const actualPort = server.address().port;
  logLine(`DeepUpgrade local API слушает http://${host}:${actualPort}`);
  logLine(`  OpenAI base URL: http://${host}:${actualPort}/v1`);
  if (ctx.web) {
    logLine(`  mode: browser (настоящий веб-клиент, аккаунт ${ctx.web.accountId})`);
    logLine('  один активный веб-чат на аккаунт; браузер поднимется на первом запросе');
  } else {
    logLine('  mode: direct (PoW + прямой HTTP API)');
    logLine(`  token: ${redact(ctx.token)}${ctx.fromCache ? ' (кэш)' : ''}`);
    logLine(`  cache: ${config ? configPath() : '(отключён)'}`);
  }
  logLine(`  local API key: ${apiKey ? 'required' : 'not set (только localhost)'}`);
  logLine('  Ctrl+C — остановить.');

  const shutdown = () => {
    logLine('остановка…');
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 1500).unref();
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('\nОшибка: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  messagesToPrompt,
  modelSupportsThinking,
  contentText,
  parseDsmlToolCalls,
  renderToolsPrompt,
  appendToolsPrompt
};

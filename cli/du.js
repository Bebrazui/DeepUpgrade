#!/usr/bin/env node
'use strict';

/*
 * DeepUpgrade Direct API CLI
 *
 * Reproduces the HTTP path that extension/interceptor.js uses as its
 * "direct network API" fallback:
 *
 *   1. POST /api/v0/chat/create_pow_challenge
 *   2. solve DeepSeekHashV1 locally (23-round Keccak, same as sha3_wasm)
 *   3. POST /api/v0/chat/completion with x-ds-pow-response
 *   4. parse the SSE patch stream
 *
 * Usage: node cli/du.js --help
 */

const fs = require('fs');
const path = require('path');
const readline = require('readline/promises');
const { stdin, stdout } = require('process');

const { buildPowHeader } = require('./lib/pow');
const ds = require('./lib/client');
const { configPath, loadConfig, describeAge } = require('./lib/config');
const chats = require('./lib/chats');
const {
  isAuthError,
  applyCachedAuth,
  authenticateFromBrowser,
  withAuthRetry
} = require('./lib/auth');

const {
  DEFAULT_BASE_URL,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_USER_AGENT
} = ds;

const VALUE_FLAGS = new Set([
  'prompt', 'token', 'token-file', 'session', 'parent', 'challenge', 'threads',
  'har', 'cookie', 'cookie-file', 'base-url', 'timeout', 'save', 'system',
  'browser', 'profile', 'login-timeout', 'debug-port',
  'chat', 'chat-history', 'import-chat'
]);
const ALIASES = {
  p: 'prompt',
  t: 'token',
  s: 'session',
  i: 'interactive',
  h: 'help',
  j: 'json'
};

function parseArgv(argv, valueFlags) {
  const flags = valueFlags || VALUE_FLAGS;
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    let arg = argv[i];
    if (arg === '--') {
      out._.push(...argv.slice(i + 1));
      break;
    }
    if (!arg.startsWith('-') || arg === '-') {
      out._.push(arg);
      continue;
    }
    let name = arg.replace(/^--?/, '');
    let value;
    const eq = name.indexOf('=');
    if (eq !== -1) {
      value = name.slice(eq + 1);
      name = name.slice(0, eq);
    }
    name = ALIASES[name] || name;
    if (flags.has(name)) {
      if (value === undefined) value = argv[++i];
      if (value === undefined) throw new Error(`--${name} requires a value`);
      out[name] = value;
    } else if (name.startsWith('no-')) {
      // Keep the full name (e.g. args['no-cache'] === true) so callers can
      // distinguish "flag given" from "flag absent / value false".
      out[name] = true;
    } else {
      out[name] = value === undefined ? true : value;
    }
  }
  return out;
}

const HELP = `
DeepUpgrade Direct API CLI — посмотреть и повторить HTTP-отправку DeepSeek.

Использование:
  node cli/du.js "ваш запрос"
  node cli/du.js "ваш запрос" --token <token> [--session <id>] [--dry-run]
  node cli/du.js --interactive --har capture.har
  node cli/du.js --challenge challenge.json --threads 8

Токен:
  Если --token/--token-file/--har/DEEPSEEK_TOKEN не заданы, CLI открывает
  браузер по умолчанию, предлагает выбрать профиль (если их несколько)
  и читает userToken из localStorage. Поддерживаются Chrome, Edge, Brave,
  Chromium и Vivaldi. Для Firefox/Opera автоматическое чтение недоступно.

  Токен и выбранный профиль кэшируются в ~/.deepupgrade-cli.json, поэтому
  профиль спрашивается один раз, а браузер открывается только когда токена
  нет или сервер его отверг (401/403). --login — принудительно обновить,
  --no-cache — не использовать кэш.

Основное:
  -p, --prompt <текст>      Запрос. Можно передать позиционным аргументом.
  -i, --interactive         Многоходовой режим: после ответа parent_message_id
                            обновляется, можно задать следующий запрос.
  -t, --token <token>       Bearer-токен DeepSeek (или env DEEPSEEK_TOKEN).
      --token-file <file>   Файл с токеном (сырой токен или JSON с полем value).
      --login               Открыть браузер и взять свежий токен, даже если он
                            уже передан/найден.
      --browser <name>      chrome | edge | brave | chromium | vivaldi | default.
      --profile <sel>       Профиль браузера: номер, имя каталога, имя или email.
                            Без флага CLI спросит, если профилей несколько.
      --login-timeout <сек> Сколько ждать входа в аккаунт (по умолчанию 180).
      --keep-browser        Не закрывать браузер после получения токена.
      --no-browser          Не открывать браузер автоматически.
      --no-cache            Не читать и не писать кэш токена/профиля
                            (${'~'}/.deepupgrade-cli.json, можно задать DU_CONFIG).
      --har <file>          Взять authorization/cookie/session/parent из HAR.
      --cookie <value>      Заголовок Cookie (обычно нужен для direct API).
  -s, --session <id>        chat_session_id. Если не задан — создаётся.
      --parent <id>         parent_message_id (для продолжения ветки).
      --chat <id|имя>       Продолжить локальный чат (сессия/parent берутся из него).
      --new-chat            Создать локальный чат для этого запроса.
      --list-chats          Показать локальные чаты и выйти.
      --deepseek-chats      Показать чаты аккаунта DeepSeek и выйти.
      --chat-history <id>   Показать историю чата аккаунта.
      --import-chat <id>    Импортировать чат аккаунта в локальные.
      --dry-run             Получить PoW и показать запрос, но не отправлять.
      --thinking            thinking_enabled=true.
      --search              search_enabled=true.
      --system <текст>      Добавить [SYSTEM INSTRUCTION: ...] перед запросом.
      --threads <n>         Потоков для PoW (по умолчанию до 8).
      --raw                 Печатать сырые SSE-строки.
      --json                Машиночитаемый вывод (без стрима в консоль).
      --timeout <сек>       Таймаут запросов, 0 = без таймаута.
      --save <file>         Сохранить последний запрос как JSON.
      --challenge <file>    Только решить готовый PoW-челлендж (без сети).
      --base-url <url>      По умолчанию ${DEFAULT_BASE_URL}.
      --no-color            Отключить ANSI-цвета.
  -h, --help                Эта справка.

Переменные окружения:
  DEEPSEEK_TOKEN            То же, что --token.
  DEEPSEEK_COOKIE           То же, что --cookie.
`;

function makeLogger(useColor, jsonMode) {
  const paint = (code, text) => (useColor ? `\x1b[${code}m${text}\x1b[0m` : text);
  return {
    raw: (text) => { if (!jsonMode) stdout.write(text); },
    line: (text) => { if (!jsonMode) stdout.write((text === undefined ? '' : text) + '\n'); },
    step: (n, total, text) => { if (!jsonMode) stdout.write(paint('36;1', `[${n}/${total}] `) + paint('1', text) + '\n'); },
    info: (text) => { if (!jsonMode) stdout.write('  ' + text + '\n'); },
    ok: (text) => { if (!jsonMode) stdout.write(paint('32', '  ✔ ' + text) + '\n'); },
    warn: (text) => { if (!jsonMode) stdout.write(paint('33', '  ! ' + text) + '\n'); },
    dim: (text) => { if (!jsonMode) stdout.write(paint('90', text)); },
    content: (text) => { if (!jsonMode) stdout.write(text); },
    thinking: (text) => { if (!jsonMode) stdout.write(paint('90', text)); }
  };
}

function redactToken(token) {
  if (!token) return '(none)';
  if (token.length <= 12) return '***';
  return token.slice(0, 6) + '…' + token.slice(-4) + ` (len ${token.length})`;
}

const normalizeToken = ds.normalizeToken;

function readTokenFile(file) {
  return normalizeToken(fs.readFileSync(file, 'utf8'));
}

const extractChallenge = ds.extractChallenge;

function loadHar(file) {
  const har = JSON.parse(fs.readFileSync(file, 'utf8'));
  const entries = (har && har.log && har.log.entries) || [];
  const result = { token: '', cookie: '', session: '', parent: null, count: 0 };

  for (const entry of entries) {
    const request = entry && entry.request;
    if (!request || !request.url || !request.url.includes('/api/v0/')) continue;
    result.count++;

    for (const header of request.headers || []) {
      const name = String(header.name || '').toLowerCase();
      if (name === 'authorization' && header.value) result.token = normalizeToken(header.value);
      if (name === 'cookie' && header.value) result.cookie = header.value;
    }

    const text = request.postData && request.postData.text;
    if (text) {
      try {
        const body = JSON.parse(text);
        if (body.chat_session_id) result.session = String(body.chat_session_id);
        if (body.parent_message_id !== undefined) result.parent = body.parent_message_id;
      } catch (err) { /* post data is not JSON */ }
    }
  }

  return result;
}

async function readStdin() {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  return Buffer.concat(chunks).toString('utf8').trim();
}

function createContext(args) {
  const baseUrl = String(args['base-url'] || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutSec = args.timeout === undefined ? 60 : Number(args.timeout);
  const ctx = {
    baseUrl,
    token: '',
    cookie: String(args.cookie || process.env.DEEPSEEK_COOKIE || ''),
    session: args.session ? String(args.session) : '',
    parent: args.parent === undefined ? null : args.parent,
    threads: args.threads === undefined ? undefined : Number(args.threads),
    timeoutMs: Number.isFinite(timeoutSec) && timeoutSec > 0 ? timeoutSec * 1000 : 0
  };

  if (args.har) {
    const har = loadHar(args.har);
    if (har.token) ctx.token = har.token;
    if (!ctx.cookie && har.cookie) ctx.cookie = har.cookie;
    if (!ctx.session && har.session) ctx.session = har.session;
    if (ctx.parent === null && har.parent !== undefined) ctx.parent = har.parent;
  }

  if (args['token-file']) ctx.token = readTokenFile(args['token-file']);
  if (args.token) ctx.token = normalizeToken(args.token);
  if (!ctx.token && process.env.DEEPSEEK_TOKEN) {
    ctx.token = normalizeToken(process.env.DEEPSEEK_TOKEN);
  }

  return ctx;
}

function clientFromCtx(ctx) {
  return ds.createClient({
    baseUrl: ctx.baseUrl,
    token: ctx.token,
    cookie: ctx.cookie,
    timeoutMs: ctx.timeoutMs,
    threads: ctx.threads
  });
}

function buildHeaders(ctx, extra) {
  return ds.buildHeaders(clientFromCtx(ctx), extra);
}

function requestJson(ctx, pathname, body) {
  return ds.requestJson(clientFromCtx(ctx), pathname, body);
}

function fetchChallenge(ctx) {
  return ds.fetchChallenge(clientFromCtx(ctx));
}

function createSession(ctx) {
  return ds.createSession(clientFromCtx(ctx));
}

async function streamCompletion(ctx, body, powHeader, log, opts) {
  const iterator = ds.completion(clientFromCtx(ctx), body, powHeader);
  let step;
  while (!(step = await iterator.next()).done) {
    const event = step.value;
    if (event.type === 'content') {
      log.content(event.text);
    } else if (event.type === 'thinking') {
      if (opts.thinking) log.thinking(event.text);
    } else if (event.type === 'raw') {
      if (opts.raw) log.dim(event.text + '\n');
    }
  }
  return step.value;
}

function requestSnapshot(ctx, body, powHeader) {
  return {
    method: 'POST',
    url: ctx.baseUrl + '/api/v0/chat/completion',
    headers: {
      'content-type': 'application/json',
      authorization: 'Bearer ' + redactToken(ctx.token),
      'x-client-platform': 'web',
      'x-client-version': DEFAULT_CLIENT_VERSION,
      'x-ds-pow-response': powHeader ? powHeader.slice(0, 24) + `… (base64, ${powHeader.length} chars)` : '(none)',
      cookie: ctx.cookie ? '(present)' : '(absent)'
    },
    body
  };
}

async function solveAndReport(challenge, ctx, log) {
  log.info(`algorithm: ${challenge.algorithm}  difficulty: ${challenge.difficulty}  ` +
    `expire_at: ${challenge.expire_at}`);
  log.info(`salt: ${challenge.salt}`);
  log.info(`target: ${challenge.challenge}`);
  log.info(`prefix: ${challenge.salt}_${challenge.expire_at}_`);
  log.info(ctx.threads ? `solving with ${ctx.threads} thread(s)…` : 'solving…');

  const result = await ds.solvePoW(challenge, {
    threads: ctx.threads,
    onProgress: (done, total) => {
      if (process.stdout.isTTY) {
        const pct = total ? Math.floor((done / total) * 100) : 0;
        log.dim(`\r  … ${pct}%`);
      }
    }
  });
  if (process.stdout.isTTY) log.raw('\r');

  log.ok(`answer: ${result.answer}  (${result.elapsedMs} ms, ${result.threads} thread(s), ` +
    `${result.attempts} попыток)`);
  if (!result.verified) {
    log.warn('Локальная проверка хеша не сошлась — PoW может быть отвергнут сервером.');
  }
  return result;
}

async function runOnce(ctx, prompt, opts) {
  const total = opts.dryRun ? 3 : 4;
  const log = opts.log;

  if (!ctx.session) {
    log.info('сессия не задана, создаю новую…');
    ctx.session = await createSession(ctx);
    log.ok(`session: ${ctx.session}`);
  }

  log.step(1, total, 'create_pow_challenge');
  const challengeJson = await fetchChallenge(ctx);
  const challenge = extractChallenge(challengeJson);
  if (!challenge) throw new Error('No challenge in response: ' + JSON.stringify(challengeJson));
  log.ok('челлендж получен');

  log.step(2, total, 'solve DeepSeekHashV1');
  const solved = await solveAndReport(challenge, ctx, log);
  const powHeader = buildPowHeader(challenge, solved.answer);
  log.info(`x-ds-pow-response: ${powHeader.slice(0, 48)}… (${powHeader.length} chars base64)`);

  const body = {
    chat_session_id: ctx.session,
    parent_message_id: ctx.parent === null || ctx.parent === '' ? null : (
      /^\d+$/.test(String(ctx.parent)) ? Number(ctx.parent) : ctx.parent
    ),
    model_type: null,
    prompt,
    ref_file_ids: [],
    thinking_enabled: !!opts.thinking
  };
  if (opts.search) body.search_enabled = true;

  const snapshot = requestSnapshot(ctx, body, powHeader);

  log.step(3, total, 'chat/completion');
  log.line('  headers:');
  for (const [name, value] of Object.entries(snapshot.headers)) {
    log.line(`    ${name}: ${value}`);
  }
  log.line('  body:');
  log.line(JSON.stringify(body, null, 2).replace(/^/gm, '    '));

  if (opts.save) {
    fs.writeFileSync(opts.save, JSON.stringify({
      prompt,
      request: {
        method: 'POST',
        url: snapshot.url,
        headers: buildHeaders(ctx, { 'x-ds-pow-response': powHeader }),
        body
      },
      challenge,
      pow: { answer: solved.answer, elapsed_ms: solved.elapsedMs, threads: solved.threads },
      note: 'authorization contains the raw token; keep this file private'
    }, null, 2));
    log.info(`запрос сохранён: ${opts.save}`);
  }

  if (opts.dryRun) {
    log.ok('--dry-run: запрос не отправлен');
    return {
      prompt,
      dry_run: true,
      session: ctx.session,
      challenge,
      pow: { answer: solved.answer, elapsed_ms: solved.elapsedMs, threads: solved.threads },
      request: snapshot
    };
  }

  log.step(4, total, 'stream response');
  log.line('');
  if (opts.thinking) log.dim('[thinking]\n');
  const startedAt = Date.now();
  const state = await streamCompletion(ctx, body, powHeader, log, opts);
  if (state.content || state.thinking) log.line('');
  const elapsed = Date.now() - startedAt;

  if (state.responseMessageId !== null) ctx.parent = state.responseMessageId;
  log.ok(`готово за ${elapsed} ms, ответ ${state.content.length} симв.` +
    (state.responseMessageId !== null ? `, response_message_id=${state.responseMessageId}` : ''));

  return {
    prompt,
    dry_run: false,
    session: ctx.session,
    parent_message_id: ctx.parent,
    challenge,
    pow: { answer: solved.answer, elapsed_ms: solved.elapsedMs, threads: solved.threads },
    response: {
      content: state.content,
      thinking: state.thinking,
      response_message_id: state.responseMessageId,
      elapsed_ms: elapsed
    }
  };
}

function runWithAuthRetry(ctx, args, config, jsonMode, log, fn) {
  return withAuthRetry(
    ctx, args, config, jsonMode,
    () => log.warn('Токен отвергнут сервером — перечитываю его из браузера…'),
    fn
  );
}

function resolveChat(store, selector) {
  const direct = chats.getChat(store, selector);
  if (direct) return direct;
  const lowered = String(selector).toLowerCase();
  const matches = Object.values(store.chats)
    .filter((chat) => String(chat.title).toLowerCase().includes(lowered));
  if (matches.length === 1) return matches[0];
  if (matches.length === 0) {
    throw new Error(`Чат "${selector}" не найден. Посмотрите список: --list-chats.`);
  }
  throw new Error(`Под "${selector}" подходит несколько чатов; укажите id:\n` +
    matches.map((chat) => `  ${chat.id}  ${chat.title}`).join('\n'));
}

function printAccountChats(list) {
  if (!list.length) {
    stdout.write('(чатов нет)\n');
    return;
  }
  for (const chat of list) {
    const when = new Date(chat.updated_at * 1000).toISOString().replace('T', ' ').slice(0, 16);
    stdout.write(`${chat.id}  ${when}  ${chat.title}\n`);
  }
}

function resolvePrompt(args) {
  const positional = (args._ || []).join(' ').trim();
  if (args.prompt !== undefined && args.prompt !== true) {
    const value = String(args.prompt);
    return value === '-' ? null : value;
  }
  if (positional) return positional;
  return null;
}

async function interactiveLoop(ctx, opts, send) {
  const rl = readline.createInterface({ input: stdin, output: stdout });
  opts.log.line('Интерактивный режим. /exit — выход, /session — показать состояние.');
  try {
    while (true) {
      const input = (await rl.question('\nвы> ')).trim();
      if (!input) continue;
      if (input === '/exit' || input === '/quit') break;
      if (input === '/session') {
        opts.log.info(`session=${ctx.session} parent=${ctx.parent}`);
        continue;
      }
      await send(input);
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const args = parseArgv(process.argv.slice(2));
  if (args.help) {
    stdout.write(HELP.trimStart());
    return;
  }

  const useColor = !args['no-color'] && !!stdout.isTTY;
  const jsonMode = !!args.json;
  const log = makeLogger(useColor, jsonMode);
  const opts = {
    log,
    dryRun: !!args['dry-run'],
    thinking: !!args.thinking,
    search: !!args.search,
    raw: !!args.raw,
    save: args.save ? path.resolve(String(args.save)) : ''
  };

  const chatStore = chats.loadChats();

  if (args['list-chats']) {
    const list = chats.listChats(chatStore);
    if (jsonMode) {
      stdout.write(JSON.stringify({ object: 'list', data: list }, null, 2) + '\n');
    } else {
      log.line('Локальные чаты:');
      if (!list.length) log.info('(пусто)');
      for (const chat of list) {
        log.line(`  ${chat.title}`);
        log.info(`id: ${chat.id}  сообщений: ${chat.message_count}  ` +
          `обновлён: ${chat.updated_at}`);
      }
    }
    return;
  }

  // Offline mode: just solve a challenge from a file/stdin.
  if (args.challenge) {
    const raw = args.challenge === '-' ? await readStdin() : fs.readFileSync(String(args.challenge), 'utf8');
    const json = JSON.parse(raw);
    const challenge = extractChallenge(json) || json;
    const ctx = createContext(args);
    if (jsonMode) {
      const solved = await ds.solvePoW(challenge, { threads: ctx.threads });
      stdout.write(JSON.stringify({ challenge, pow: solved }, null, 2) + '\n');
      return;
    }
    log.line('Задача PoW (без сети)');
    const solved = await solveAndReport(challenge, ctx, log);
    log.line('');
    log.ok(`x-ds-pow-response: ${buildPowHeader(challenge, solved.answer)}`);
    return;
  }

  const ctx = createContext(args);
  ctx.explicitToken = !!ctx.token;
  const config = args['no-cache'] ? null : loadConfig();
  if (args.login) {
    ctx.token = '';
    ctx.explicitToken = false;
    if (config) {
      const { clearCachedAuth } = require('./lib/config');
      clearCachedAuth(config);
    }
  }

  // Token priority: explicit (--token/--token-file/--har/env) → cache → browser.
  if (!ctx.token && config) await applyCachedAuth(ctx, config);

  if (!ctx.token && !args['no-browser']) {
    await authenticateFromBrowser(ctx, args, config, jsonMode);
  }

  if (!ctx.token) {
    throw new Error('Нужен токен: --token, --token-file, --har, DEEPSEEK_TOKEN ' +
      'или разрешите автоматический вход через браузер (уберите --no-browser). ' +
      'Токен лежит в localStorage DeepSeek (ключ userToken).');
  }

  if (args['deepseek-chats'] || args['chat-history'] || args['import-chat']) {
    const client = clientFromCtx(ctx);
    if (args['deepseek-chats']) {
      const result = await ds.listChats(client, { count: 50 });
      if (jsonMode) {
        stdout.write(JSON.stringify(result, null, 2) + '\n');
      } else {
        stdout.write('Чаты аккаунта DeepSeek:\n');
        printAccountChats(result.chats);
        if (result.hasMore) stdout.write('(есть ещё; используйте веб-интерфейс для остальных)\n');
      }
      return;
    }
    if (args['chat-history']) {
      const history = await ds.getChatHistory(client, String(args['chat-history']));
      const messages = history.messages.map(ds.normalizeMessage);
      if (jsonMode) {
        stdout.write(JSON.stringify({ session: history.session, messages }, null, 2) + '\n');
      } else {
        stdout.write(`Чат: ${(history.session && history.session.title) || args['chat-history']}\n\n`);
        for (const message of messages) {
          stdout.write(`${message.role === 'user' ? 'вы' : 'assistant'}:\n${message.content}\n\n`);
        }
      }
      return;
    }
    const history = await ds.getChatHistory(client, String(args['import-chat']));
    const chat = chats.importChat(chatStore, history, { session_id: String(args['import-chat']) });
    if (jsonMode) {
      stdout.write(JSON.stringify(chat, null, 2) + '\n');
    } else {
      stdout.write(`Импортирован чат "${chat.title}" (${chat.id}), ` +
        `сообщений: ${chat.messages.length}.\nПродолжить: --chat ${chat.id}\n`);
    }
    return;
  }

  let activeChat = null;
  if (args.chat && args['new-chat']) {
    throw new Error('--chat и --new-chat несовместимы.');
  }
  if (args.chat) {
    activeChat = resolveChat(chatStore, String(args.chat));
    if (activeChat.deepseek_session_id) ctx.session = activeChat.deepseek_session_id;
    if (activeChat.parent_message_id !== null && activeChat.parent_message_id !== undefined) {
      ctx.parent = activeChat.parent_message_id;
    }
  } else if (args['new-chat']) {
    activeChat = chats.createChat(chatStore, {});
  }

  const prompt = resolvePrompt(args);
  const isTTY = !!stdin.isTTY;

  if (!jsonMode) {
    log.line('');
    log.line('DeepUpgrade Direct API CLI');
    log.info(`token: ${redactToken(ctx.token)}`);
    if (ctx.fromCache) {
      log.info(`token source: кэш ${configPath()}${ctx.cachedAt ? ` (${describeAge(ctx.cachedAt)})` : ''}`);
      log.info('  (обновить: --login, отключить кэш: --no-cache)');
    } else if (!ctx.explicitToken && !args['no-browser']) {
      log.info(`token source: браузер; сохранён в ${configPath()}`);
    }
    log.info(`session: ${ctx.session || '(будет создана)'}`);
    log.info(`parent: ${ctx.parent === null ? 'null' : ctx.parent}`);
    log.info(`cookie: ${ctx.cookie ? 'present' : 'absent'}`);
    log.info(`pow threads: ${ctx.threads || 'auto'}`);
    if (activeChat) log.info(`chat: ${activeChat.title} [${activeChat.id}]`);
  }

  const send = async (text) => {
    const result = await runWithAuthRetry(
      ctx, args, config, jsonMode, log,
      () => runOnce(ctx, text, opts)
    );
    if (activeChat && result && !result.dry_run) {
      chats.appendMessage(chatStore, activeChat, { role: 'user', content: text });
      chats.appendMessage(chatStore, activeChat, {
        role: 'assistant',
        content: result.response.content,
        thinking: result.response.thinking,
        message_id: result.response.response_message_id
      });
      chats.updateChat(chatStore, activeChat, {
        deepseek_session_id: result.session,
        parent_message_id: result.parent_message_id
      });
      if (!jsonMode) log.info(`чат: ${activeChat.title} [${activeChat.id}]`);
    }
    return result;
  };

  if (!prompt) {
    if (!isTTY) {
      const piped = await readStdin();
      if (!piped) throw new Error('Пустой запрос. Передайте текст аргументом или через stdin.');
      const result = await send(args.system ? `[SYSTEM INSTRUCTION: ${args.system}]\n\n${piped}` : piped);
      if (jsonMode) stdout.write(JSON.stringify(result, null, 2) + '\n');
      return;
    }

    if (args.interactive) {
      await interactiveLoop(ctx, opts, send);
      return;
    }

    const rl = readline.createInterface({ input: stdin, output: stdout });
    let one = '';
    try {
      one = (await rl.question('запрос> ')).trim();
    } finally {
      rl.close();
    }
    if (!one) throw new Error('Пустой запрос.');
    const result = await send(args.system ? `[SYSTEM INSTRUCTION: ${args.system}]\n\n${one}` : one);
    if (jsonMode) stdout.write(JSON.stringify(result, null, 2) + '\n');
    return;
  }

  const fullPrompt = args.system ? `[SYSTEM INSTRUCTION: ${args.system}]\n\n${prompt}` : prompt;
  const result = await send(fullPrompt);
  if (jsonMode) stdout.write(JSON.stringify(result, null, 2) + '\n');
}

if (require.main === module) {
  main().catch((err) => {
    process.stderr.write('\nОшибка: ' + (err && err.stack ? err.stack : String(err)) + '\n');
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgv,
  normalizeToken,
  extractChallenge,
  isAuthError,
  redactToken
};

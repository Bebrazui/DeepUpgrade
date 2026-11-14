'use strict';

/*
 * Reusable DeepSeek direct-API client.
 *
 * Both the CLI (du.js) and the local OpenAI-compatible server (server.js) talk
 * to chat.deepseek.com through this module, so the HTTP shape lives in exactly
 * one place:
 *
 *   POST /api/v0/chat/create_pow_challenge   (POST, JSON)
 *   GET  /api/v0/chat_session/create         -> actually POST
 *   POST /api/v0/chat/completion             (SSE)
 *   GET  /api/v0/chat_session/fetch_page     (chat list)
 *   GET  /api/v0/chat/history_messages       (chat history)
 *
 * Errors carry `.status` (HTTP) and `.apiCode` (DeepSeek business code) so
 * callers can detect auth failures without parsing strings.
 */

const { solveChallenge, buildPowHeader } = require('./pow');
const { TlsClient } = require('./tls-client');

const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
const DEFAULT_CLIENT_VERSION = '2.7.0';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';
const DEFAULT_CHROME_VERSION = '131.0.0.0';
const DEFAULT_ACCEPT_LANGUAGE = 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7';

function createClient(options) {
  const opts = options || {};
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs !== undefined
    ? Number(opts.timeoutMs) || 0
    : (Number(opts.timeoutSec) > 0 ? Number(opts.timeoutSec) * 1000 : 0);

  // Auto-detect Chrome version if not specified
  const chromeVersion = opts.chromeVersion || DEFAULT_CHROME_VERSION;
  const userAgent = opts.userAgent || DEFAULT_USER_AGENT.replace('131.0.0.0', chromeVersion);
  
  return {
    baseUrl,
    token: String(opts.token || ''),
    cookie: String(opts.cookie || ''),
    timeoutMs,
    threads: opts.threads,
    userAgent,
    chromeVersion,
    clientVersion: opts.clientVersion || DEFAULT_CLIENT_VERSION,
    acceptLanguage: opts.acceptLanguage || DEFAULT_ACCEPT_LANGUAGE,
    transport: opts.transport || 'native' // 'native' or 'tls'
  };
}

function buildHeaders(client, extra) {
  const headers = {
    'user-agent': client.userAgent,
    'sec-ch-ua': `"Chromium";v="${client.chromeVersion}", "Google Chrome";v="${client.chromeVersion}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'accept-language': client.acceptLanguage,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'priority': 'u=1, i',
    'accept': '*/*',
    'content-type': 'application/json',
    authorization: `Bearer ${client.token}`,
    'x-client-platform': 'web',
    'x-client-version': client.clientVersion,
    'x-client-locale': 'ru',
    // The web client sends its bundle id and local UTC offset on every call;
    // a request without them is visibly not the web app.
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-timezone-offset': String(-new Date().getTimezoneOffset() * 60),
    origin: client.baseUrl,
    referer: client.baseUrl + '/'
  };
  if (client.cookie) headers.cookie = client.cookie;
  return Object.assign(headers, extra || {});
}

function signalFor(client) {
  if (!client.timeoutMs) return undefined;
  return AbortSignal.timeout(client.timeoutMs);
}

async function safeReadJson(res) {
  const text = await res.text();
  try {
    return { text, json: JSON.parse(text) };
  } catch (err) {
    return { text, json: null };
  }
}

function apiError(pathname, res, payload) {
  const body = payload.json ? JSON.stringify(payload.json) : String(payload.text || '').slice(0, 800);
  const err = new Error(`${pathname}: HTTP ${res.status} ${body}`);
  err.status = res.status;
  return err;
}

function deepseekError(pathname, json, text) {
  const detail = json ? JSON.stringify(json) : String(text || '').slice(0, 800);
  const code = json && json.code !== undefined ? ` code=${json.code}` : '';
  const msg = json && json.msg ? ` msg=${json.msg}` : '';
  const err = new Error(`${pathname}:${code}${msg} ${detail}`);
  if (json && json.code !== undefined) err.apiCode = json.code;
  return err;
}

function buildQuery(query) {
  if (!query) return '';
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) {
    if (value === undefined || value === null || value === '') continue;
    params.set(key, String(value));
  }
  const text = params.toString();
  return text ? '?' + text : '';
}

/**
 * Performs a DeepSeek API call and returns `json.data.biz_data` when present,
 * otherwise the raw JSON. Throws on HTTP errors and non-zero business codes.
 *
 * @param {object} client
 * @param {string} pathname
 * @param {object} [body] JSON body; omit for GET
 * @param {{method?:string, query?:object, extraHeaders?:object}} [options]
 */
async function requestJson(client, pathname, body, options) {
  const opts = options || {};
  const method = opts.method || (body === undefined ? 'GET' : 'POST');
  const url = client.baseUrl + pathname + buildQuery(opts.query);

  // Use TLS transport if configured
  if (client.transport === 'tls') {
    return await requestJsonTls(client, pathname, body, opts);
  }

  // Default native fetch
  const init = {
    method,
    headers: buildHeaders(client, opts.extraHeaders),
    signal: signalFor(client)
  };
  if (body !== undefined && method !== 'GET') init.body = JSON.stringify(body);

  const res = await fetch(url, init);
  const payload = await safeReadJson(res);
  if (!res.ok) throw apiError(pathname, res, payload);
  if (payload.json && payload.json.code !== undefined && payload.json.code !== 0) {
    throw deepseekError(pathname, payload.json, payload.text);
  }
  const json = payload.json;
  if (json && json.data && json.data.biz_data !== undefined) return json.data.biz_data;
  return json;
}

async function requestJsonTls(client, pathname, body, options) {
  const opts = options || {};
  const method = opts.method || (body === undefined ? 'GET' : 'POST');
  const url = client.baseUrl + pathname + buildQuery(opts.query);

  const tlsClient = new TlsClient({
    curlPath: client.curlPath,
    impersonate: client.impersonate || 'chrome131',
    timeoutMs: client.timeoutMs,
    userAgent: client.userAgent,
    chromeVersion: client.chromeVersion,
    acceptLanguage: client.acceptLanguage
  });

  const headers = buildHeaders(client, opts.extraHeaders);
  // Remove Node-specific headers that curl_cffi doesn't need
  delete headers['content-length'];
  
  const response = await tlsClient.request({
    method,
    url,
    headers,
    body: body !== undefined && method !== 'GET' ? JSON.stringify(body) : undefined,
    origin: client.baseUrl,
    token: client.token,
    cookie: client.cookie
  });

  const payload = await response.json();
  if (!response.ok) throw apiError(pathname, response, { json: payload, text: response.text });
  if (payload && payload.code !== undefined && payload.code !== 0) {
    throw deepseekError(pathname, payload, response.text);
  }
  if (payload && payload.data && payload.data.biz_data !== undefined) return payload.data.biz_data;
  return payload;
}

function extractChallenge(json) {
  if (!json || typeof json !== 'object') return null;
  return json.challenge ||
    (json.biz_data && json.biz_data.challenge) ||
    (json.data && json.data.biz_data && json.data.biz_data.challenge) ||
    null;
}

function normalizeToken(raw) {
  let value = String(raw == null ? '' : raw).trim();
  if (!value) return '';
  if (value.startsWith('{')) {
    try {
      const json = JSON.parse(value);
      value = json.value || json.token || json.userToken ||
        (json.state && (json.state.userToken || json.state.token)) || '';
    } catch (err) { /* keep the raw string */ }
  }
  return value.replace(/^bearer\s+/i, '').trim();
}

async function createSession(client) {
  const biz = await requestJson(client, '/api/v0/chat_session/create', {});
  const id = biz && ((biz.chat_session && biz.chat_session.id) || biz.id);
  if (!id) {
    throw new Error('chat_session/create: no session id in response: ' + JSON.stringify(biz));
  }
  return String(id);
}

async function fetchChallenge(client) {
  return requestJson(client, '/api/v0/chat/create_pow_challenge', {
    target_path: '/api/v0/chat/completion'
  });
}

/**
 * Solves PoW for a challenge and returns { answer, powHeader, elapsedMs }.
 */
async function solvePoW(challenge, options) {
  const solved = await solveChallenge(challenge, options || {});
  return {
    answer: solved.answer,
    elapsedMs: solved.elapsedMs,
    threads: solved.threads,
    attempts: solved.attempts,
    verified: solved.verified,
    powHeader: buildPowHeader(challenge, solved.answer)
  };
}

/**
 * Streams completion events.
 *
 * Yields:
 *   {type:'content',  text}
 *   {type:'thinking', text}
 *   {type:'message_id', id}
 *   {type:'status',   value}
 *   {type:'usage',    value}
 * and returns the final state
 *   {content, thinking, responseMessageId, finished}
 *
 * @param {object} client
 * @param {object} body chat/completion JSON body
 * @param {string} powHeader x-ds-pow-response value
 * @param {{signal?:AbortSignal}} [options]
 */
async function* completion(client, body, powHeader, options) {
  const opts = options || {};
  // The web app refers to the chat it is answering in; the bare origin looks
  // like a request assembled outside the app.
  const extra = { 'x-ds-pow-response': powHeader };
  if (body && body.chat_session_id) {
    extra.referer = `${client.baseUrl}/a/chat/s/${body.chat_session_id}`;
  }
  const headers = buildHeaders(client, extra);
  
  if (client.transport === 'tls') {
    return yield* completionTls(client, body, headers, opts);
  }

  const res = await fetch(client.baseUrl + '/api/v0/chat/completion', {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
    signal: opts.signal || signalFor(client)
  });

  if (!res.ok || !res.body) {
    const payload = await safeReadJson(res);
    throw apiError('/api/v0/chat/completion', res, payload);
  }

  // A 200 with JSON instead of SSE means the server refused the turn
  // (muted account, invalid PoW, ...); surface it instead of streaming nothing.
  const contentType = res.headers.get('content-type') || '';
  if (!contentType.includes('text/event-stream')) {
    const payload = await safeReadJson(res);
    if (payload.json) throw deepseekError('/api/v0/chat/completion', payload.json, payload.text);
    throw apiError('/api/v0/chat/completion', res, payload);
  }

  const reader = res.body.getReader();
  return yield* streamReader(reader);
}

async function* completionTls(client, body, headers, options) {
  const tlsClient = new TlsClient({
    curlPath: client.curlPath,
    impersonate: client.impersonate || 'chrome131',
    timeoutMs: client.timeoutMs,
    userAgent: client.userAgent,
    chromeVersion: client.chromeVersion,
    acceptLanguage: client.acceptLanguage
  });

  const tlsHeaders = { ...headers };
  delete tlsHeaders['content-length'];

  const child = tlsClient.spawn({
    method: 'POST',
    url: client.baseUrl + '/api/v0/chat/completion',
    headers: tlsHeaders,
    body: JSON.stringify(body),
    origin: client.baseUrl,
    token: client.token,
    cookie: client.cookie,
    stream: true
  });

  return yield* streamChildProcess(child);
}

async function* streamReader(reader) {
  const decoder = new TextDecoder();
  const state = { content: '', thinking: '', responseMessageId: null, finished: false };
  let buffer = '';

  const apply = (event, inheritedPath, out) => {
    if (!event || typeof event !== 'object') return;
    const p = event.p || inheritedPath || '';
    const v = event.v;

    if (event.response_message_id !== undefined && event.response_message_id !== null) {
      state.responseMessageId = event.response_message_id;
      out.push({ type: 'message_id', id: event.response_message_id });
    }

    // DeepSeek sends the running token count inside a BATCH as
    // {p:'accumulated_token_usage', v:<number>}; surface it so callers can
    // report OpenAI-style usage instead of always returning zeros.
    if (p.includes('accumulated_token_usage')) {
      const tokens = Number(v);
      if (Number.isFinite(tokens)) out.push({ type: 'usage', value: tokens });
      return;
    }

    if (p === 'response/status') {
      if (v === 'FINISHED') state.finished = true;
      out.push({ type: 'status', value: v });
      return;
    }
    if (p.includes('status') || p === 'response/search') return;

    if (event.o === 'BATCH' && Array.isArray(v)) {
      for (const item of v) {
        apply(Object.assign({ p: item.p || p }, item), p, out);
      }
      return;
    }

    if (v && typeof v === 'object' && !Array.isArray(v) && v.response) {
      if (v.response.message_id !== undefined && v.response.message_id !== null) {
        state.responseMessageId = v.response.message_id;
        out.push({ type: 'message_id', id: v.response.message_id });
      }
      for (const fragment of v.response.fragments || []) {
        if (typeof fragment.content !== 'string') continue;
        if (fragment.type === 'THINK') {
          state.thinking += fragment.content;
          out.push({ type: 'thinking', text: fragment.content });
        } else {
          state.content += fragment.content;
          out.push({ type: 'content', text: fragment.content });
        }
      }
      return;
    }

    if (typeof v === 'string') {
      if (p.includes('thinking')) {
        state.thinking += v;
        out.push({ type: 'thinking', text: v });
      } else {
        state.content += v;
        out.push({ type: 'content', text: v });
      }
    }
  };

  const handleLine = (line) => {
    const trimmed = line.replace(/\r$/, '');
    if (!trimmed.startsWith('data:')) return [];
    const raw = trimmed.slice(5).trim();
    if (!raw) return [];
    if (raw === '[DONE]') {
      state.finished = true;
      return [{ type: 'status', value: 'DONE' }];
    }
    let event;
    try {
      event = JSON.parse(raw);
    } catch (err) {
      return [];
    }
    const out = [];
    apply(event, '', out);
    return out;
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    let idx;
    while ((idx = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 1);
      const trimmed = line.replace(/\r$/, '');
      if (trimmed.startsWith('data:')) {
        const rawText = trimmed.slice(5).trim();
        if (rawText) yield { type: 'raw', text: rawText };
      }
      for (const ev of handleLine(line)) yield ev;
    }
  }

  return state;
}

async function* streamChildProcess(child) {
  // Wrap the child's stdout in the reader interface streamReader expects.
  const chunks = [];
  let ended = false;
  let notify = null;
  let stderr = '';

  const wake = () => {
    if (notify) {
      const resume = notify;
      notify = null;
      resume();
    }
  };

  child.stdout.on('data', (chunk) => { chunks.push(chunk); wake(); });
  child.stdout.on('error', () => { ended = true; wake(); });
  child.stdout.on('end', () => { ended = true; wake(); });
  child.stderr.on('data', (chunk) => { stderr += chunk; });

  const exited = new Promise((resolve) => {
    child.once('close', (code) => resolve(code));
    child.once('error', () => resolve(-1));
  });

  const reader = {
    read: async () => {
      while (!chunks.length && !ended) {
        await new Promise((resolve) => { notify = resolve; });
      }
      if (!chunks.length) return { done: true };
      return { done: false, value: chunks.shift() };
    }
  };

  const state = yield* streamReader(reader);

  const code = await exited;
  if (code !== 0 && code !== null) {
    throw new Error(stderr.trim() || `TLS-транспорт завершился с кодом ${code}`);
  }
  if (!state.content && !state.thinking && !state.finished && stderr.trim()) {
    throw new Error(stderr.trim());
  }

  return state;
}

/**
 * Lists the newest chats from the DeepSeek account.
 * @returns {Promise<{chats:Array, hasMore:boolean}>}
 */
async function listChats(client, options) {
  const opts = options || {};
  const biz = await requestJson(client, '/api/v0/chat_session/fetch_page', undefined, {
    method: 'GET',
    query: { count: opts.count || 50, lte_cursor: opts.cursor }
  });
  return {
    chats: (biz && biz.chat_sessions) || [],
    hasMore: !!(biz && biz.has_more)
  };
}

/**
 * Fetches one chat with its messages.
 * @returns {Promise<{session:object, messages:Array}>}
 */
async function getChatHistory(client, sessionId) {
  const biz = await requestJson(client, '/api/v0/chat/history_messages', undefined, {
    method: 'GET',
    query: { chat_session_id: sessionId }
  });
  return {
    session: (biz && biz.chat_session) || null,
    messages: (biz && biz.chat_messages) || []
  };
}

/**
 * Normalises a raw DeepSeek message to {role, content, thinking, message_id}.
 */
function normalizeMessage(raw) {
  const fragments = (raw && raw.fragments) || [];
  let content = '';
  let thinking = '';
  for (const fragment of fragments) {
    if (typeof fragment.content !== 'string') continue;
    if (fragment.type === 'THINK') thinking += fragment.content;
    else if (fragment.type === 'REQUEST' || fragment.type === 'RESPONSE') content += fragment.content;
  }
  const role = raw && raw.role === 'USER' ? 'user' : 'assistant';
  return {
    role,
    content,
    thinking,
    message_id: raw ? raw.message_id : undefined
  };
}

module.exports = {
  DEFAULT_BASE_URL,
  DEFAULT_CLIENT_VERSION,
  DEFAULT_USER_AGENT,
  createClient,
  buildHeaders,
  signalFor,
  requestJson,
  extractChallenge,
  normalizeToken,
  createSession,
  fetchChallenge,
  solvePoW,
  completion,
  listChats,
  getChatHistory,
  normalizeMessage
};

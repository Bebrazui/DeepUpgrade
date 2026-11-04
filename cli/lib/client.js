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

const DEFAULT_BASE_URL = 'https://chat.deepseek.com';
const DEFAULT_CLIENT_VERSION = '2.7.0';
const DEFAULT_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

function createClient(options) {
  const opts = options || {};
  const baseUrl = String(opts.baseUrl || DEFAULT_BASE_URL).replace(/\/+$/, '');
  const timeoutMs = opts.timeoutMs !== undefined
    ? Number(opts.timeoutMs) || 0
    : (Number(opts.timeoutSec) > 0 ? Number(opts.timeoutSec) * 1000 : 0);

  return {
    baseUrl,
    token: String(opts.token || ''),
    cookie: String(opts.cookie || ''),
    timeoutMs,
    threads: opts.threads,
    userAgent: opts.userAgent || DEFAULT_USER_AGENT,
    clientVersion: opts.clientVersion || DEFAULT_CLIENT_VERSION
  };
}

function buildHeaders(client, extra) {
  const headers = {
    accept: '*/*',
    'content-type': 'application/json',
    authorization: `Bearer ${client.token}`,
    'x-client-platform': 'web',
    'x-client-version': client.clientVersion,
    'x-client-locale': 'en',
    origin: client.baseUrl,
    referer: client.baseUrl + '/',
    'user-agent': client.userAgent
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
  const headers = buildHeaders(client, { 'x-ds-pow-response': powHeader });
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

  const state = { content: '', thinking: '', responseMessageId: null, finished: false };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const apply = (event, inheritedPath, out) => {
    if (!event || typeof event !== 'object') return;
    const p = event.p || inheritedPath || '';
    const v = event.v;

    if (event.response_message_id !== undefined && event.response_message_id !== null) {
      state.responseMessageId = event.response_message_id;
      out.push({ type: 'message_id', id: event.response_message_id });
    }

    if (p === 'response/status') {
      if (v === 'FINISHED') state.finished = true;
      out.push({ type: 'status', value: v });
      return;
    }
    // Other status-ish paths (quasi_status, search_status, …) may carry a
    // string like "FINISHED" that must never be appended to the answer.
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
  if (buffer.trim()) {
    const trimmed = buffer.replace(/\r$/, '');
    if (trimmed.startsWith('data:')) {
      const rawText = trimmed.slice(5).trim();
      if (rawText) yield { type: 'raw', text: rawText };
    }
    for (const ev of handleLine(buffer)) yield ev;
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

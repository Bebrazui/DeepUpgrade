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
  'browser', 'profile', 'login-timeout', 'model', 'session'
]);

const HELP = `
DeepUpgrade local API — OpenAI-совместимый сервер поверх direct API DeepSeek.

Использование:
  node cli/server.js
  node cli/server.js --port 8787 --api-key secret
  node cli/server.js --token <token> --base-url https://chat.deepseek.com

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
      --timeout <сек>       Таймаут запросов к DeepSeek, 0 = без таймаута.
      --threads <n>         Потоков для PoW.
  -t, --token <token>       Bearer-токен (или env DEEPSEEK_TOKEN).
      --cookie <value>      Cookie (или env DEEPSEEK_COOKIE).
      --base-url <url>      По умолчанию ${ds.DEFAULT_BASE_URL}.
      --login               Принудительно перечитать токен из браузера.
      --browser <name>      chrome | edge | brave | chromium | vivaldi | default.
      --profile <sel>       Профиль браузера.
      --login-timeout <сек> Сколько ждать входа (по умолчанию 180).
      --no-browser          Не открывать браузер.
      --no-cache            Не читать/не писать кэш токена.
      --verbose             Подробный лог запросов.
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
    threads: ctx.threads
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
function pendingTurnText(messages) {
  let lastAssistant = -1;
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i] && messages[i].role === 'assistant') {
      lastAssistant = i;
      break;
    }
  }

  const pending = messages
    .slice(lastAssistant + 1)
    .filter((m) => m && m.role !== 'system' && m.role !== 'developer');
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
function messagesToPrompt(messages, boundToSession) {
  const system = extractSystem(messages);
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

/**
 * Extracts DeepSeek DSML tool calls from completion text:
 * < | DSML | | calls >
 *   < | DSML | | invoke name="execute">
 *     < | DSML | | parameter name="code" string="true">...</ | DSML | | parameter>
 *   </ | DSML | | invoke>
 * </ | DSML | | calls>
 */
function parseDsmlToolCalls(text) {
  if (!text || typeof text !== 'string') return null;
  const callsRegex = /<\s*\|\s*DSML\s*\|\s*\|\s*calls\s*>([\s\S]*?)<\s*\/\s*\|\s*DSML\s*\|\s*\|\s*calls\s*>/i;
  const match = callsRegex.exec(text);
  if (!match) return null;

  const contentBefore = text.slice(0, match.index).trim();
  const contentAfter = text.slice(match.index + match[0].length).trim();
  const cleanContent = [contentBefore, contentAfter].filter(Boolean).join('\n\n');

  const block = match[1];
  const invokeRegex = /<\s*\|\s*DSML\s*\|\s*\|\s*invoke\s+name=["']([^"']+)["']\s*>([\s\S]*?)<\s*\/\s*\|\s*DSML\s*\|\s*\|\s*invoke\s*>/gi;
  const paramRegex = /<\s*\|\s*DSML\s*\|\s*\|\s*parameter\s+name=["']([^"']+)["'](?:\s+string=["']([^"']+)["'])?\s*>([\s\S]*?)<\s*\/\s*\|\s*DSML\s*\|\s*\|\s*parameter\s*>/gi;

  const toolCalls = [];
  let invokeMatch;
  let idx = 0;
  while ((invokeMatch = invokeRegex.exec(block)) !== null) {
    const name = invokeMatch[1];
    const invokeBody = invokeMatch[2];
    const args = {};
    let paramMatch;
    while ((paramMatch = paramRegex.exec(invokeBody)) !== null) {
      const pName = paramMatch[1];
      const isString = paramMatch[2] === 'true';
      let val = paramMatch[3].trim();
      if (!isString) {
        try { val = JSON.parse(val); } catch (e) {}
      }
      args[pName] = val;
    }
    toolCalls.push({
      id: `call_${Date.now().toString(36)}_${idx++}`,
      type: 'function',
      function: {
        name,
        arguments: JSON.stringify(args)
      }
    });
  }

  return {
    cleanContent,
    toolCalls: toolCalls.length > 0 ? toolCalls : null
  };
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

/**
 * Creates the session (unless given), fetches/solves PoW and opens the SSE
 * stream, forcing the first chunk to be read inside the auth-retry scope so a
 * 401 is retried before anything is written to the HTTP client.
 */
async function startCompletion(ctx, args, config, options) {
  const opts = options || {};
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
        model_type: null,
        prompt: opts.prompt,
        ref_file_ids: [],
        thinking_enabled: !!opts.thinking
      };
      if (opts.search) body.search_enabled = true;

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

  // Explicitly started or seeded conversation when the request carries no chat/session hint.
  if (!session && !wantsNewChat && state.activeSessionId) {
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

  const prompt = messagesToPrompt(body.messages, !!session);
  if (!prompt || !prompt.trim()) {
    return sendError(res, 400, 'no user message with text content');
  }

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

  const userText = contentText((lastUserMessage(body.messages) || {}).content);
  let chatForResponse = chat ? chat.id : null;

  const finalize = (content, thinkingText, messageId) => {
    if (chat) {
      chatsStore.appendMessage(store, chat, { role: 'user', content: userText });
      chatsStore.appendMessage(store, chat, {
        role: 'assistant',
        content,
        thinking: thinkingText,
        message_id: messageId
      });
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
      chatsStore.appendMessage(store, created2, { role: 'user', content: userText });
      chatsStore.appendMessage(store, created2, {
        role: 'assistant',
        content,
        thinking: thinkingText,
        message_id: messageId
      });
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
  logLine(`completion start model=${model} session=${started.session} ` +
    `thinking=${thinking} stream=${stream} chat=${chat ? chat.id : '-'}`);

  if (!stream) {
    const result = await collectIterator(started);
    const parsedDsml = parseDsmlToolCalls(result.content);
    const finalContent = parsedDsml ? parsedDsml.cleanContent : result.content;
    const toolCalls = parsedDsml ? parsedDsml.toolCalls : null;
    const finishReason = toolCalls ? 'tool_calls' : 'stop';

    const extra = finalize(result.content, result.thinking, result.responseMessageId);
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
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
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
  let finishReason = 'stop';

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
          const dsmlStartIdx = pendingContent.search(/<\s*\|\s*DSML/i);
          if (dsmlStartIdx !== -1) {
            // Flush text before the tag
            if (dsmlStartIdx > 0) {
              flushContent(pendingContent.slice(0, dsmlStartIdx));
              pendingContent = pendingContent.slice(dsmlStartIdx);
            }
            insideDsml = true;
          } else {
            // If the buffer ends with a partial '<', keep only the trailing potential tag
            const partialIdx = pendingContent.lastIndexOf('<');
            if (partialIdx !== -1 && partialIdx > pendingContent.length - 20) {
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
      // Flush any remaining buffered plain text
      flushContent(pendingContent);
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

  const extra = finalize(content, thinkingText, messageId);
  sseWrite(res, {
    id, object: 'chat.completion.chunk', created, model,
    choices: [{ index: 0, delta: {}, finish_reason: finishReason }],
    x_deepseek: extra
  });
  if (!res.writableEnded && !res.destroyed) res.write('data: [DONE]\n\n');
  res.end();
  logLine(`completion stream done ${Date.now() - startedAt} ms, ${content.length} chars`);
}

async function collectIterator(started) {
  const state = { content: '', thinking: '', responseMessageId: null };
  const handle = (event) => {
    if (!event) return;
    if (event.type === 'content') state.content += event.text;
    else if (event.type === 'thinking') state.thinking += event.text;
    else if (event.type === 'message_id') state.responseMessageId = event.id;
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

  const ctx = {
    baseUrl: String(args['base-url'] || ds.DEFAULT_BASE_URL).replace(/\/+$/, ''),
    token: ds.normalizeToken(args.token || process.env.DEEPSEEK_TOKEN || ''),
    cookie: String(args.cookie || process.env.DEEPSEEK_COOKIE || ''),
    timeoutMs: Number(args.timeout) > 0 ? Number(args.timeout) * 1000 : 0,
    threads: args.threads === undefined ? undefined : Number(args.threads)
  };
  ctx.explicitToken = !!ctx.token;

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

  const store = chatsStore.loadChats();
  const state = {
    defaultModel: args.model ? String(args.model) : 'deepseek-chat',
    // Cache for conversation threads to reuse DeepSeek session & parent_message_id
    conversationSessions: new Map(), // convKey -> { sessionId, parentMessageId, lastUsed }
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
        token: ctx.fromCache ? 'cached' : 'provided',
        chats: Object.keys(store.chats).length,
        base_url: ctx.baseUrl
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
  logLine(`  token: ${redact(ctx.token)}${ctx.fromCache ? ' (кэш)' : ''}`);
  logLine(`  cache: ${config ? configPath() : '(отключён)'}`);
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
  contentText
};

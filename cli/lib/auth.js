'use strict';

/*
 * Shared token acquisition / refresh / retry.
 *
 * Priority: explicit token (CLI/env/HAR) → cached token → browser.
 * A cached token is refreshed from the browser only when the server actually
 * rejects it, never on a timer (the token has no client-side expiry).
 */

const { browserAuth, findLevelDbTokens } = require('./browsers');
const { getCachedAuth, setCachedAuth, clearCachedAuth } = require('./config');

const { TlsClient } = require('./tls-client');

/**
 * Validates a DeepSeek token against the user profile API.
 * Returns true if valid, false if rejected (e.g. code 40003) or network failure.
 */
async function validateToken(token, options = {}) {
  if (!token || typeof token !== 'string' || token.trim().length < 20) return false;
  
  const client = options.client || {
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    chromeVersion: '131.0.0.0',
    acceptLanguage: 'ru-RU,ru;q=0.9,en-US;q=0.8,en;q=0.7',
    transport: 'native'
  };
  
  const url = 'https://chat.deepseek.com/api/v0/users/current';
  const headers = {
    'Authorization': `Bearer ${token.trim()}`,
    'Accept': 'application/json',
    'User-Agent': client.userAgent,
    'sec-ch-ua': `"Chromium";v="${client.chromeVersion}", "Google Chrome";v="${client.chromeVersion}"`,
    'sec-ch-ua-mobile': '?0',
    'sec-ch-ua-platform': '"Windows"',
    'accept-language': client.acceptLanguage,
    'sec-fetch-site': 'same-origin',
    'sec-fetch-mode': 'cors',
    'sec-fetch-dest': 'empty',
    'priority': 'u=1, i'
  };

  try {
    if (client.transport === 'tls') {
      const tlsClient = new TlsClient({
        curlPath: client.curlPath,
        impersonate: client.impersonate || 'chrome131',
        timeoutMs: client.timeoutMs || 10000,
        userAgent: client.userAgent,
        chromeVersion: client.chromeVersion,
        acceptLanguage: client.acceptLanguage
      });
      
      const response = await tlsClient.request({
        method: 'GET',
        url,
        headers,
        origin: 'https://chat.deepseek.com',
        token: token.trim()
      });
      
      if (!response.ok) return false;
      const data = await response.json();
      return !!(data && data.code === 0);
    } else {
      const res = await fetch(url, {
        method: 'GET',
        headers,
        signal: client.timeoutMs ? AbortSignal.timeout(client.timeoutMs) : undefined
      });
      
      if (!res.ok) return false;
      const data = await res.json();
      return !!(data && data.code === 0);
    }
  } catch (err) {
    // A missing TLS backend is a setup problem, not a rejected token: let it
    // surface instead of silently triggering a browser re-login.
    if (err && err.code === 'TLS_BACKEND_MISSING') throw err;
    return false;
  }
}

/**
 * Heuristic: does this error mean the bearer token is no longer accepted?
 * DeepSeek replies 401/403, or 200 with a business code (40003 = not logged in).
 */
function isAuthError(err) {
  if (err && (err.status === 401 || err.status === 403)) return true;
  if (err && (err.apiCode === 40003 || err.apiCode === 40001 || err.apiCode === 401 || err.apiCode === 403)) return true;
  const message = String((err && err.message) || err || '');
  return /HTTP (401|403)\b/.test(message) ||
    /\bcode=(40003|40001|401|403)\b/.test(message) ||
    /invalid token|token (?:expired|invalid)|unauthori[sz]ed|not logged in|please log in|authorization failed/i.test(message);
}

/**
 * Fills `ctx.token`/`ctx.cookie` from the config cache when they are empty.
 * If the cached token is invalid, automatically clears it.
 * @returns {Promise<boolean>} true when a valid cached token was applied
 */
async function applyCachedAuth(ctx, config) {
  if (!config || ctx.token) return false;
  const cached = getCachedAuth(config);
  if (!cached || !cached.value) return false;

  // Validate cached token against API; if expired, clean it automatically!
  const isValid = await validateToken(cached.value, { client: ctx });
  if (!isValid) {
    clearCachedAuth(config);
    return false;
  }

  ctx.token = cached.value;
  if (!ctx.cookie && cached.cookie) ctx.cookie = cached.cookie;
  ctx.fromCache = true;
  ctx.cachedAt = cached.saved_at;
  return true;
}

/**
 * Tries silent extraction from browser's LevelDB storage without launching a UI window.
 * Returns true if a valid token was found and set.
 */
async function trySilentLevelDbAuth(ctx, config) {
  if (ctx.token) return true;
  try {
    const tokens = findLevelDbTokens();
    for (const token of tokens) {
      if (await validateToken(token)) {
        ctx.token = token;
        ctx.fromCache = false;
        ctx.cachedAt = null;
        if (config) setCachedAuth(config, { token, cookie: ctx.cookie || '' });
        return true;
      }
    }
  } catch (err) { /* silent fallback */ }
  return false;
}

/**
 * Reads a token from the default browser, stores it in the cache and applies
 * it to `ctx`.
 */
async function authenticateFromBrowser(ctx, args, config, jsonMode) {
  // The silent scan only looks at the Default Chromium profiles, so it would
  // return the wrong account when the user asked for a specific profile or a
  // fresh one. In those cases go straight to the browser window.
  const explicitProfile = !!(args && (args.profile || args['new-profile']));

  // 1. First, try reading directly from LevelDB without opening any window
  if (!explicitProfile && (!args || !args['no-browser'])) {
    const silentOk = await trySilentLevelDbAuth(ctx, config);
    if (silentOk) return ctx;
  }

  // 2. If no valid token found silently, open browser window to log in
  const auth = await browserAuth(args || {}, { jsonMode: !!jsonMode, config });
  ctx.token = auth.token;
  if (auth.cookie) ctx.cookie = auth.cookie;
  ctx.fromCache = false;
  ctx.cachedAt = null;
  if (config) setCachedAuth(config, auth);
  return ctx;
}

/**
 * Forces a fresh browser token, clearing the stale cache entry first.
 */
async function refreshAuth(ctx, args, config, jsonMode) {
  if (config) clearCachedAuth(config);
  ctx.token = '';
  return authenticateFromBrowser(ctx, args, config, jsonMode);
}

/**
 * Runs `fn`, and if it fails with an auth error once, re-reads the token from
 * the browser and retries. Explicit user-provided tokens are never replaced.
 * Includes exponential backoff for rate limiting.
 */
async function withAuthRetry(ctx, args, config, jsonMode, onRefresh, fn) {
  const maxAttempts = 3;
  const baseDelay = 1000; // 1 second base delay

  let lastError = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastError = err;
      if (!isAuthError(err) || (args && args['no-browser']) || ctx.explicitToken) throw err;
      // The last attempt has nowhere left to retry: surface the real error
      // instead of a generic "max retries" message.
      if (attempt === maxAttempts - 1) throw err;

      // Add jitter to avoid a thundering herd after a shared outage.
      const delay = baseDelay * Math.pow(2, attempt) + Math.random() * 1000;

      if (onRefresh) onRefresh(err);
      if (config) clearCachedAuth(config);

      // Never write progress to stdout: `du.js --json` emits one JSON document
      // there, and a stray line breaks machine-readable output.
      process.stderr.write(`Токен отвергнут, повтор через ${Math.round(delay / 1000)} с…\n`);
      await new Promise((resolve) => setTimeout(resolve, delay));

      await refreshAuth(ctx, args, config, jsonMode);
    }
  }

  throw lastError || new Error('Max auth retries exceeded');
}

module.exports = {
  validateToken,
  isAuthError,
  applyCachedAuth,
  trySilentLevelDbAuth,
  authenticateFromBrowser,
  refreshAuth,
  withAuthRetry
};


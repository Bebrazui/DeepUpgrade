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

/**
 * Validates a DeepSeek token against the user profile API.
 * Returns true if valid, false if rejected (e.g. code 40003) or network failure.
 */
async function validateToken(token) {
  if (!token || typeof token !== 'string' || token.trim().length < 20) return false;
  try {
    const res = await fetch('https://chat.deepseek.com/api/v0/users/current', {
      method: 'GET',
      headers: {
        'Authorization': `Bearer ${token.trim()}`,
        'Accept': 'application/json'
      }
    });
    if (!res.ok) return false;
    const data = await res.json();
    return !!(data && data.code === 0);
  } catch (err) {
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
  const isValid = await validateToken(cached.value);
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
  // 1. First, try reading directly from LevelDB without opening any window
  if (!args || !args['no-browser']) {
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
 */
async function withAuthRetry(ctx, args, config, jsonMode, onRefresh, fn) {
  try {
    return await fn();
  } catch (err) {
    if (!isAuthError(err) || (args && args['no-browser']) || ctx.explicitToken) throw err;
    if (onRefresh) onRefresh(err);
    if (config) clearCachedAuth(config);
    await refreshAuth(ctx, args, config, jsonMode);
    return fn();
  }
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


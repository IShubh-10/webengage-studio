/**
 * Redis client with a soft fallback: when it is unavailable the app keeps
 * working from its in-memory caches. `state` is shared by reference so callers
 * always see the live connection status.
 *
 * `createClient` exists because a connection in subscriber mode cannot run
 * ordinary commands — cross-worker cache invalidation needs a second connection
 * of its own (see lib/invalidation.js).
 */

const Redis = require('ioredis');

const state = { client: null, connected: false, enabled: true };

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Was anything pointed at a Redis explicitly? Used twice below: to decide
// whether the built-in production default applies, and to tell a deliberate
// in-memory-only run apart from a misconfigured one.
const HAS_EXPLICIT_CONFIG = Boolean(
  process.env.REDIS_URL ||
    process.env.REDIS_HOST ||
    process.env.REDIS_PORT ||
    process.env.REDIS_PASSWORD
);

// The Render Key Value instance for this app. This is the *internal* URL: the
// hostname only resolves inside this Render account's private network, and the
// instance has no public access (`ipAllowList: []` in render.yaml), so it is a
// location rather than a credential — there is no password in it and it is
// useless to anyone outside the account.
//
// It is a fallback, not the configuration: setting REDIS_URL in the service
// environment overrides it, which is still the better place for it because
// moving the instance then does not need a deploy.
const RENDER_KEY_VALUE_URL = 'redis://red-dajaiobm8hqs73fhlnf0:6379';

// Hosted Redis is handed over as a single URL (`redis://…`, or `rediss://…`
// when it is reached over the public internet with TLS), so REDIS_URL wins when
// it is set and the host/port/password trio stays for a local install. The
// default applies in production only, and only when nothing was set by hand —
// otherwise a developer running `redis-server` locally would be pointed at a
// hostname their machine cannot resolve.
const REDIS_URL =
  process.env.REDIS_URL || (IS_PRODUCTION && !HAS_EXPLICIT_CONFIG ? RENDER_KEY_VALUE_URL : '');

// Nothing points at a Redis anywhere, and no default filled the gap. Locally
// that is fine — a developer running `redis-server` with no env vars expects
// 127.0.0.1:6379 to be tried. In production it can only ever fail: there is no
// Redis inside the container. Attempting it anyway produced one ECONNREFUSED
// line per retry per worker, forever, which buried every other log line in the
// deploy. This is the safety net for if RENDER_KEY_VALUE_URL is ever emptied.
const IS_CONFIGURED = Boolean(REDIS_URL || HAS_EXPLICIT_CONFIG);

/** False when the app is deliberately running on its in-memory caches alone. */
function isEnabled() {
  return state.enabled;
}

// --- Throttled logging -----------------------------------------------------
// A dead Redis fails identically several times a second on every worker. Print
// the first of each distinct message, then hold the rest back and summarise how
// many arrived, so a real outage stays visible without drowning the log.
const LOG_WINDOW_MS = 60000;
const suppressed = new Map(); // message -> { until, count }

function reportRedisIssue(label, message) {
  const key = `${label}:${message}`;
  const now = Date.now();
  const entry = suppressed.get(key);

  if (entry && now < entry.until) {
    entry.count += 1;
    return;
  }

  if (entry && entry.count > 0) {
    console.warn(
      `⚠️ ${label}: ${message} (${entry.count} more in the last ${Math.round(LOG_WINDOW_MS / 1000)}s)`
    );
  } else {
    console.warn(`⚠️ ${label}: ${message}`);
  }

  suppressed.set(key, { until: now + LOG_WINDOW_MS, count: 0 });
}

function connectionOptions() {
  const common = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    enableOfflineQueue: true,
    // Backs off to half a minute rather than hammering a host that is down:
    // reconnecting twice a second buys nothing and costs a log line each time.
    retryStrategy: (times) => Math.min(times * 500, 30000),
    reconnectOnError: () => true,
  };

  if (REDIS_URL) return common;

  return {
    ...common,
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: Number(process.env.REDIS_PORT || 6379),
    password: process.env.REDIS_PASSWORD || undefined,
  };
}

/**
 * A fresh connection with the same settings — for pub/sub, which needs its own.
 * Returns null when Redis is switched off, so callers must check.
 */
function createClient(overrides = {}) {
  if (!state.enabled) return null;

  const options = { ...connectionOptions(), ...overrides };
  return REDIS_URL ? new Redis(REDIS_URL, options) : new Redis(options);
}

async function initRedis() {
  if (IS_PRODUCTION && !IS_CONFIGURED) {
    state.enabled = false;
    state.connected = false;
    console.warn(
      '⚠️ REDIS_URL is not set — running on in-memory caches only. ' +
        'Renders and timer lookups are not shared between workers and are lost on restart. ' +
        'Set REDIS_URL in the service environment to fix it.'
    );
    return;
  }

  try {
    state.client = createClient();

    state.client.on('connect', () => {
      state.connected = true;
      console.log('✅ Redis connected');
    });

    state.client.on('error', (err) => {
      const wasConnected = state.connected;
      state.connected = false;
      reportRedisIssue('Redis error', err.message);
      if (wasConnected) console.warn('⚠️ Redis connection lost — serving from in-memory caches');
    });

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 2000);

      state.client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  } catch (err) {
    console.warn('⚠️ Redis initialization failed, will use in-memory cache only:', err.message);
    state.connected = false;
  }
}

module.exports = { state, initRedis, createClient, isEnabled, reportRedisIssue };

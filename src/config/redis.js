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

const state = { client: null, connected: false };

// Hosted Redis is handed over as a single URL (`redis://…`, or `rediss://…`
// when it is reached over the public internet with TLS), so REDIS_URL wins when
// it is set and the host/port/password trio stays for a local install.
const REDIS_URL = process.env.REDIS_URL || '';

function connectionOptions() {
  const common = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 50, 2000),
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

/** A fresh connection with the same settings — for pub/sub, which needs its own. */
function createClient(overrides = {}) {
  const options = { ...connectionOptions(), ...overrides };
  return REDIS_URL ? new Redis(REDIS_URL, options) : new Redis(options);
}

async function initRedis() {
  try {
    state.client = createClient();

    state.client.on('connect', () => {
      state.connected = true;
      console.log('✅ Redis connected');
    });

    state.client.on('error', (err) => {
      state.connected = false;
      console.error('⚠️ Redis error:', err.message);
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

module.exports = { state, initRedis, createClient };

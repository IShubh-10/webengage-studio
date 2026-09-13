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

function connectionOptions() {
  return {
    host: process.env.REDIS_HOST || '127.0.0.1',
    port: process.env.REDIS_PORT || 6379,
    password: process.env.REDIS_PASSWORD || undefined,
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    enableOfflineQueue: true,
    retryStrategy: (times) => Math.min(times * 50, 2000),
    reconnectOnError: () => true,
  };
}

/** A fresh connection with the same settings — for pub/sub, which needs its own. */
function createClient(overrides = {}) {
  return new Redis({ ...connectionOptions(), ...overrides });
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

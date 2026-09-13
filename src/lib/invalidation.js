/**
 * Cross-worker cache invalidation.
 *
 * Every in-memory cache in this app is per-process, and in production the
 * server runs one process per core. So when an author saves a timer, clearing
 * the local memory cache fixes exactly one worker out of eight — the other
 * seven keep serving the old creative until their entries age out. That is the
 * bug this closes: a small message on a Redis channel, and every worker drops
 * the same entry at the same moment.
 *
 * Redis may be down, and the app is built to survive that. So this is best
 * effort by design: publishing always applies the change locally first, and the
 * memory caches that depend on it carry a TTL as the fallback.
 */

const crypto = require('crypto');

const { createClient, state: redisState, isEnabled, reportRedisIssue } = require('../config/redis');

const CHANNEL = 'we-studio:invalidate';

// Identifies this worker so it can ignore the echo of its own publish, which it
// has already applied locally.
const ORIGIN = crypto.randomBytes(8).toString('hex');

const handlers = new Map();
let subscriber = null;

/** Register a listener for an invalidation `type`. Called on every worker. */
function onInvalidate(type, handler) {
  if (!handlers.has(type)) handlers.set(type, new Set());
  handlers.get(type).add(handler);
}

function dispatch(type, payload) {
  const listeners = handlers.get(type);
  if (!listeners) return;

  listeners.forEach((handler) => {
    try {
      handler(payload);
    } catch (err) {
      console.warn(`⚠️ Invalidation handler failed (${type}):`, err.message);
    }
  });
}

/**
 * Apply an invalidation here and tell every other worker to do the same.
 *
 * Local first: if Redis is unavailable the worker that handled the write still
 * ends up consistent, which is the one a user is most likely to be looking at.
 */
function publishInvalidate(type, payload = {}) {
  dispatch(type, payload);

  if (!redisState.connected || !redisState.client) return;

  redisState.client
    .publish(CHANNEL, JSON.stringify({ origin: ORIGIN, type, payload }))
    .catch((err) => console.warn('⚠️ Invalidation publish error:', err.message));
}

/** Opens the subscriber connection. Called once per worker at startup. */
function initInvalidation() {
  if (subscriber) return subscriber;

  // No Redis means no channel to talk over. Opening the connection anyway only
  // produces a second stream of connection errors next to the client's own.
  if (!isEnabled()) return null;

  try {
    subscriber = createClient();
    if (!subscriber) return null;

    subscriber.on('error', (err) => {
      reportRedisIssue('Invalidation subscriber error', err.message);
    });

    subscriber.on('message', (channel, raw) => {
      if (channel !== CHANNEL) return;

      try {
        const message = JSON.parse(raw);
        if (!message || message.origin === ORIGIN) return;
        dispatch(message.type, message.payload || {});
      } catch (err) {
        console.warn('⚠️ Invalidation message error:', err.message);
      }
    });

    subscriber.subscribe(CHANNEL).catch((err) => {
      console.warn('⚠️ Could not subscribe to invalidation channel:', err.message);
    });
  } catch (err) {
    console.warn('⚠️ Invalidation setup failed, caches will rely on TTL only:', err.message);
    subscriber = null;
  }

  return subscriber;
}

async function closeInvalidation() {
  if (!subscriber) return;
  try {
    await subscriber.quit();
  } catch (err) {
    // Shutting down anyway.
  }
  subscriber = null;
}

module.exports = { CHANNEL, onInvalidate, publishInvalidate, initInvalidation, closeInvalidation };

/**
 * Reading a saved timer on the hot path.
 *
 * The GIF endpoint runs once per email open, and until now it began with an
 * uncached `SELECT ... FROM timers WHERE timer_id = ?`. Everything after it —
 * the creative, the palette, the sprite tiles, the finished bytes — was cached
 * in memory and in Redis; the one lookup in front of all of them was not. A
 * send of ten thousand messages was ten thousand queries.
 *
 * Three layers, in order of cost:
 *
 *   1. a short-lived in-memory copy, free, per worker
 *   2. Redis, one round trip, shared by every worker
 *   3. MySQL, and only when both miss
 *
 * with single-flight around 2 and 3 so a cold key costs one query rather than
 * one per concurrent request. Saves and deletes invalidate every worker at once
 * through the invalidation channel, so the memory TTL is a safety net for when
 * Redis is unavailable rather than the mechanism.
 */

const redisState = require('../config/redis').state;
const { LRUCache } = require('../lib/cache');
const { SingleFlight } = require('../lib/singleflight');
const { onInvalidate, publishInvalidate } = require('../lib/invalidation');
const { ensureTimerSchema } = require('../db/schema');
const { findTimer } = require('../repositories/timerRepository');
const { normalizeTimer } = require('./countdown/config');
const {
  TIMER_CONFIG_CACHE_SECONDS,
  TIMER_CONFIG_MEMORY_SECONDS,
  TIMER_CONFIG_MEMORY_SLOTS,
} = require('../config');

const INVALIDATE_TIMER = 'timer';

// A miss is cached too, and deliberately. A campaign that went out pointing at
// a deleted or mistyped timer id would otherwise put its entire audience
// straight through to the database, for a row that is never going to be there.
const MISSING = Symbol('timer-missing');
const MISSING_TTL_SECONDS = 60;

const memory = new LRUCache(TIMER_CONFIG_MEMORY_SLOTS, TIMER_CONFIG_MEMORY_SECONDS * 1000);
const inFlight = new SingleFlight();

function redisKey(timerId) {
  return `timer:config:${timerId}`;
}

function hydrate(record) {
  if (!record) return null;
  return {
    timer_id: record.timer_id,
    name: record.name,
    config: normalizeTimer(record.config),
  };
}

async function readThrough(timerId) {
  const key = redisKey(timerId);

  if (redisState.connected) {
    try {
      const cached = await redisState.client.get(key);
      if (cached === '') return MISSING;
      if (cached) {
        const record = hydrate(JSON.parse(cached));
        memory.set(timerId, record);
        return record;
      }
    } catch (err) {
      console.warn('⚠️ Redis timer config read error:', err.message);
    }
  }

  await ensureTimerSchema();
  const record = await findTimer(timerId);

  memory.set(timerId, record || MISSING);

  if (redisState.connected) {
    // An empty string is the tombstone: distinguishable from a real record and
    // from a Redis miss, and it costs nothing to store.
    redisState.client
      .set(
        key,
        record ? JSON.stringify(record) : '',
        'EX',
        record ? TIMER_CONFIG_CACHE_SECONDS : MISSING_TTL_SECONDS
      )
      .catch((err) => console.warn('⚠️ Redis timer config write error:', err.message));
  }

  return record || MISSING;
}

/**
 * The saved timer, or null. Safe to call once per request on the public GIF
 * route — that is what it is for.
 */
async function loadTimer(timerId) {
  const fromMemory = memory.get(timerId);
  if (fromMemory) return fromMemory === MISSING ? null : fromMemory;

  const result = await inFlight.run(timerId, () => readThrough(timerId));
  return result === MISSING ? null : result;
}

/** Drop this worker's copy. Invoked locally and by the invalidation channel. */
function forgetTimer(timerId) {
  if (timerId) memory.delete(timerId);
  else memory.clear();
}

/**
 * Called after a save or a delete: clears Redis, then tells every worker —
 * including this one — to drop its memory copy.
 */
async function invalidateTimer(timerId) {
  if (redisState.connected) {
    try {
      await redisState.client.del(redisKey(timerId));
    } catch (err) {
      console.warn('⚠️ Redis timer config invalidation error:', err.message);
    }
  }

  publishInvalidate(INVALIDATE_TIMER, { timerId });
}

onInvalidate(INVALIDATE_TIMER, ({ timerId }) => forgetTimer(timerId));

module.exports = { loadTimer, invalidateTimer, forgetTimer, INVALIDATE_TIMER };

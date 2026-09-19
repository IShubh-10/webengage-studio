/**
 * Counting opens without putting a write in front of one.
 *
 * `trackOpen` sits on the two hottest paths in the app — the render PNG and the
 * timer GIF, both of which are fetched once per email open — so it does no I/O
 * at all. It increments a number in a Map and returns. A timer drains the Map
 * into one batched statement every few seconds.
 *
 * What that trades away: a worker killed mid-interval loses up to
 * STATS_FLUSH_SECONDS of counts. That is the right trade for a figure whose
 * job is "which creative is working" — it is never an invoice, and making it
 * exact would mean a database round trip on every image in every inbox.
 */

const { ensureStatsSchema } = require('../db/schema');
const { recordOpenBuckets } = require('../repositories/statsRepository');
const { toMysqlUtc, toMysqlUtcHour } = require('../lib/utcTime');
const { STATS_ENABLED, STATS_FLUSH_SECONDS, STATS_BUFFER_LIMIT } = require('../config');

// MySQL takes a multi-row INSERT happily, but not an unbounded one — a flush
// after an outage could otherwise build a statement past max_allowed_packet.
const FLUSH_CHUNK_SIZE = 500;

/** key (`type|id|hour`) → the bucket being accumulated for it. */
const buffer = new Map();

let flushTimer = null;
let flushing = false;
let droppedSinceLastWarning = 0;

function startTimer() {
  if (flushTimer) return;

  flushTimer = setInterval(() => {
    flush().catch((err) => console.warn('⚠️ Open-stats flush error:', err.message));
  }, STATS_FLUSH_SECONDS * 1000);

  // Nothing should be kept alive by a counter: without this the interval alone
  // would stop the process from exiting after the server closes.
  if (typeof flushTimer.unref === 'function') flushTimer.unref();
}

/**
 * Count one fetch of a creative. Never throws and never awaits — a failure to
 * count must not become a failure to serve the image.
 *
 * @param {'template'|'timer'} assetType
 * @param {string} assetId
 */
function trackOpen(assetType, assetId) {
  if (!STATS_ENABLED || !assetId) return;

  try {
    const now = new Date();
    const bucketHour = toMysqlUtcHour(now);
    const key = `${assetType}|${assetId}|${bucketHour}`;

    const existing = buffer.get(key);
    if (existing) {
      existing.opens += 1;
      existing.lastOpenAt = toMysqlUtc(now);
      return;
    }

    /*
     * The ceiling only bites while the database is unreachable: in normal
     * running the buffer holds one entry per creative being opened right now,
     * and a flush empties it every few seconds. Dropping is better than
     * growing without bound — the images keep being served either way, and
     * the alternative is a worker that runs out of memory during an outage.
     */
    if (buffer.size >= STATS_BUFFER_LIMIT) {
      droppedSinceLastWarning += 1;
      return;
    }

    buffer.set(key, {
      assetType,
      assetId: String(assetId).slice(0, 100),
      bucketHour,
      opens: 1,
      lastOpenAt: toMysqlUtc(now),
    });

    startTimer();
  } catch (err) {
    // Counting is never worth a 500 on an image in somebody's inbox.
    console.warn('⚠️ Could not count an open:', err.message);
  }
}

/**
 * Write everything buffered so far.
 *
 * Buckets are taken out of the Map before the write, so opens arriving during
 * it accumulate into fresh entries rather than being cleared unwritten. A
 * failed chunk goes back in — the counts are still correct, just later.
 */
async function flush() {
  if (flushing || buffer.size === 0) return;
  flushing = true;

  const pending = Array.from(buffer.values());
  buffer.clear();

  if (droppedSinceLastWarning > 0) {
    console.warn(
      `⚠️ Open stats: ${droppedSinceLastWarning} bucket(s) dropped — the buffer hit ` +
        `STATS_BUFFER_LIMIT (${STATS_BUFFER_LIMIT}), which usually means MySQL has been unreachable.`
    );
    droppedSinceLastWarning = 0;
  }

  try {
    await ensureStatsSchema();

    for (let index = 0; index < pending.length; index += FLUSH_CHUNK_SIZE) {
      await recordOpenBuckets(pending.slice(index, index + FLUSH_CHUNK_SIZE));
    }
  } catch (err) {
    requeue(pending);
    throw err;
  } finally {
    flushing = false;
  }
}

/** Puts unwritten buckets back, merging with anything counted since. */
function requeue(pending) {
  pending.forEach((bucket) => {
    const key = `${bucket.assetType}|${bucket.assetId}|${bucket.bucketHour}`;
    const existing = buffer.get(key);

    if (existing) {
      existing.opens += bucket.opens;
      if (bucket.lastOpenAt > existing.lastOpenAt) existing.lastOpenAt = bucket.lastOpenAt;
      return;
    }

    if (buffer.size >= STATS_BUFFER_LIMIT) {
      droppedSinceLastWarning += 1;
      return;
    }

    buffer.set(key, bucket);
  });
}

/**
 * Drain on the way out, so a deploy does not throw away the last few seconds
 * of every creative's numbers. Called from the graceful shutdown in server.js,
 * before the pool is closed.
 */
async function flushNow() {
  try {
    await flush();
  } catch (err) {
    console.warn('⚠️ Open-stats final flush failed:', err.message);
  }
}

module.exports = { trackOpen, flush, flushNow };

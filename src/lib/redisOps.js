/**
 * Redis operations that are easy to get wrong at scale.
 */

const redisState = require('../config/redis').state;

/**
 * Delete every key matching a pattern, without `KEYS`.
 *
 * `KEYS` walks the entire keyspace in one blocking O(N) command. On a managed
 * or shared Redis that stalls *every* client for as long as it runs, including
 * the render path of this app. `SCAN` does the same walk in small slices with
 * the server free in between, and `UNLINK` frees the values on a background
 * thread rather than in the command itself.
 *
 * The cursor guarantee is weaker than `KEYS` — a key created during the scan
 * may be missed — which is exactly the right trade for cache invalidation,
 * where the worst case is one extra rebuild.
 */
async function scanDelete(pattern, { count = 500 } = {}) {
  if (!redisState.connected || !redisState.client) return 0;

  let cursor = '0';
  let deleted = 0;

  do {
    const [next, keys] = await redisState.client.scan(cursor, 'MATCH', pattern, 'COUNT', count);
    cursor = next;

    if (keys.length) {
      // UNLINK is non-blocking; very old servers only have DEL.
      deleted += await redisState.client.unlink(...keys).catch(() => redisState.client.del(...keys));
    }
  } while (cursor !== '0');

  return deleted;
}

/**
 * Run `build` under a cluster-wide lock, so only one process does expensive
 * work that every process is about to want.
 *
 * Whoever wins the lock builds. Everyone else polls `read` for the result the
 * winner is expected to publish, and falls back to building anyway if it never
 * arrives — a lock that can strand requests is worse than a duplicated build.
 *
 * Returns `{ value, built }`.
 */
async function withRedisLock(lockKey, { ttlMs = 20000, pollMs = 100, waitMs = 10000, read, build }) {
  if (!redisState.connected || !redisState.client) {
    return { value: await build(), built: true };
  }

  let acquired = false;
  try {
    acquired = Boolean(await redisState.client.set(lockKey, String(process.pid), 'PX', ttlMs, 'NX'));
  } catch (err) {
    console.warn('⚠️ Redis lock error:', err.message);
    return { value: await build(), built: true };
  }

  if (acquired) {
    try {
      return { value: await build(), built: true };
    } finally {
      redisState.client.del(lockKey).catch(() => {});
    }
  }

  const deadline = Date.now() + waitMs;
  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, pollMs));

    try {
      const value = await read();
      if (value) return { value, built: false };
    } catch (err) {
      break;
    }
  }

  // The holder died, or is slower than we are willing to wait.
  return { value: await build(), built: true };
}

module.exports = { scanDelete, withRedisLock };

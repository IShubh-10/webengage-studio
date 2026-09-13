/**
 * Single-flight: collapse concurrent work for the same key onto one promise.
 *
 * Every cache in this app has the same failure mode. A key expires, ten
 * thousand email opens arrive in the same second, all of them miss, and all of
 * them independently do the expensive thing — query MySQL, fetch a background
 * image, build a sprite bundle. The cache then gets written ten thousand times
 * with identical bytes.
 *
 * The fix is to remember that the work is already running. The first caller
 * starts it; everyone else awaits the same promise and gets the same result.
 * One database query, one outbound fetch, one build.
 *
 * This is per-process. Under cluster each worker has its own instance, so N
 * workers can still do N units of work — which is fine for a database read and
 * not fine for a 450ms CPU build, hence the Redis lock in countdown/sprites.js
 * on top of this.
 */

class SingleFlight {
  constructor() {
    this.pending = new Map();
  }

  /**
   * Runs `fn` for `key`, or joins the run already in progress.
   *
   * `fn` is invoked at most once per concurrent group. Rejections propagate to
   * every joiner, and the key is released either way so the next caller retries
   * rather than inheriting a stale failure.
   */
  run(key, fn) {
    const existing = this.pending.get(key);
    if (existing) return existing;

    let work;
    try {
      work = Promise.resolve(fn());
    } catch (err) {
      // A synchronous throw should behave like a rejected run, not poison the map.
      return Promise.reject(err);
    }

    this.pending.set(key, work);

    // Only the originator clears the entry, and only if it is still the one it
    // stored — a slow finally must not evict a newer run of the same key.
    return work.finally(() => {
      if (this.pending.get(key) === work) this.pending.delete(key);
    });
  }

  get size() {
    return this.pending.size;
  }
}

module.exports = { SingleFlight };

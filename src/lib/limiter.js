/**
 * A bounded work queue, so overload sheds instead of piling up.
 *
 * The render endpoints are CPU work on a single-threaded event loop. Without a
 * limit, a burst larger than the box can serve does not fail — it queues, and
 * the queue is invisible: latency climbs into the tens of seconds, memory grows
 * with every parked request, and the email clients at the other end have long
 * since timed out. Every one of those renders is then thrown away after being
 * paid for.
 *
 * Refusing the request immediately once the queue is deep is strictly better.
 * The caller gets a fast, honest answer, and the requests already in flight
 * still finish quickly.
 */

class Limiter {
  constructor({ concurrency = 16, queueLimit = 256, name = 'limiter' } = {}) {
    this.concurrency = Math.max(1, concurrency);
    this.queueLimit = Math.max(0, queueLimit);
    this.name = name;

    this.active = 0;
    this.queue = [];
    this.rejected = 0;
  }

  /**
   * Runs `fn` when there is room. Rejects immediately with `code:
   * 'OVERLOADED'` when the queue is already at its limit — check for that and
   * answer with a 503 rather than treating it as a render failure.
   */
  run(fn) {
    if (this.active < this.concurrency) return this.#start(fn);

    if (this.queue.length >= this.queueLimit) {
      this.rejected++;
      const err = new Error(`${this.name} is overloaded (${this.active} active, ${this.queue.length} queued)`);
      err.code = 'OVERLOADED';
      err.status = 503;
      return Promise.reject(err);
    }

    return new Promise((resolve, reject) => {
      this.queue.push({ fn, resolve, reject });
    });
  }

  #start(fn) {
    this.active++;

    return (async () => fn())().finally(() => {
      this.active--;
      this.#drain();
    });
  }

  #drain() {
    while (this.active < this.concurrency && this.queue.length > 0) {
      const { fn, resolve, reject } = this.queue.shift();
      this.#start(fn).then(resolve, reject);
    }
  }

  stats() {
    return {
      active: this.active,
      queued: this.queue.length,
      rejected: this.rejected,
      concurrency: this.concurrency,
      queueLimit: this.queueLimit,
    };
  }
}

module.exports = { Limiter };

// One limiter for every render path, because they all contend for the same
// thing: this worker's event loop. Giving the GIF and PNG endpoints separate
// budgets would let them add up to more work than the process can do.
const { RENDER_CONCURRENCY, RENDER_QUEUE_LIMIT } = require('../config');

const renderLimiter = new Limiter({
  concurrency: RENDER_CONCURRENCY,
  queueLimit: RENDER_QUEUE_LIMIT,
  name: 'render',
});

module.exports.renderLimiter = renderLimiter;

/**
 * Per-IP rate limiting.
 *
 * This sits in front of the concurrency limiter in lib/limiter.js, and the two
 * answer different questions. The concurrency limiter asks "is this process
 * already doing as much as it can?" and sheds load once it is — but it is
 * blind to who is asking, so a single client can fill the whole budget and
 * everyone else gets the 503. This asks "is this one caller taking more than
 * its share?", which is the question that matters when the traffic is hostile
 * rather than merely heavy.
 *
 * Counting happens in Redis because the app runs a cluster of workers: an
 * in-memory counter would be per-worker, and the effective limit would
 * silently be the configured one multiplied by WORKER_COUNT. If Redis is
 * unavailable the limiter **fails open** — an outage of the counting layer
 * must not become an outage of the service, and the concurrency limiter is
 * still underneath as a floor.
 *
 * Fixed windows, not a sliding log: a burst straddling a window boundary can
 * briefly get through at twice the rate, which is an acceptable trade for one
 * INCR per request and no per-caller state to expire by hand.
 */

const redisState = require('../config/redis').state;
const { RATE_LIMIT_ENABLED } = require('../config');

/**
 * The caller's real address.
 *
 * Every request arrives through Render's edge, so the socket address is a
 * proxy for all of them and is useless as an identity. `CF-Connecting-IP` is
 * set by that edge and overwritten on every request, so it cannot be forged
 * from outside; `req.ip` is the fallback and is only meaningful because
 * app.js sets `trust proxy`.
 */
function clientIp(req) {
  return req.get('cf-connecting-ip') || req.ip || req.socket.remoteAddress || 'unknown';
}

/**
 * @param {object} options
 * @param {string} options.name          bucket namespace, so two limits on one IP do not share a counter
 * @param {number} options.limit         requests allowed per window
 * @param {number} options.windowSeconds length of the window
 * @param {function} [options.onLimited] custom response; defaults to a JSON 429
 */
function rateLimit({ name, limit, windowSeconds, onLimited }) {
  const respond =
    onLimited ||
    ((req, res, retryAfter) => {
      res.setHeader('Retry-After', String(retryAfter));
      res.status(429).json({ error: 'Too many requests — slow down and try again shortly' });
    });

  // Checked per request rather than at wiring time, so the middleware is
  // always in the chain and turning the flag off changes behaviour rather
  // than route composition — one less thing to differ between a load test and
  // the real deployment.
  return async function rateLimitMiddleware(req, res, next) {
    if (!RATE_LIMIT_ENABLED) return next();

    // Nothing to count with. Better to serve the request than to refuse
    // everything because the counter is down.
    if (!redisState.connected) return next();

    const ip = clientIp(req);
    const window = Math.floor(Date.now() / 1000 / windowSeconds);
    const key = `ratelimit:${name}:${ip}:${window}`;

    let used;
    try {
      // One round trip: increment, and set the expiry on the way past. The TTL
      // is re-applied on every hit rather than only on the first, which costs
      // nothing and means a key can never outlive its window if the EXPIRE on
      // the first request was the one that failed.
      const [[, count]] = await redisState.client
        .multi()
        .incr(key)
        .expire(key, windowSeconds)
        .exec();
      used = count;
    } catch (err) {
      console.warn(`⚠️ Rate limit counter unavailable (${name}):`, err.message);
      return next();
    }

    res.setHeader('X-RateLimit-Limit', String(limit));
    res.setHeader('X-RateLimit-Remaining', String(Math.max(0, limit - used)));

    if (used > limit) {
      const retryAfter = windowSeconds - (Math.floor(Date.now() / 1000) % windowSeconds);
      console.warn(`Rate limited ${ip} on ${name}: ${used} requests in ${windowSeconds}s`);
      return respond(req, res, retryAfter);
    }

    next();
  };
}

module.exports = { rateLimit, clientIp };

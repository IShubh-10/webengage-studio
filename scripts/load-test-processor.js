/**
 * Artillery hooks for scripts/load-test.yml.
 *
 * The render endpoint reports how it served each request in `X-Cache`
 * (HIT-REDIS when the finished PNG came straight out of Redis, MISS when the
 * image was composited for this request) and how long a MISS took in
 * `X-Render-Time`. Both are turned into Artillery counters/histograms so the
 * summary states plainly how much of the load the cache absorbed.
 */

function recordCacheOutcome(req, res, context, events, next) {
  const outcome = String(res.headers['x-cache'] || 'absent').toLowerCase();

  events.emit('counter', `render.cache.${outcome}`, 1);
  events.emit('counter', 'render.responses', 1);

  const renderTime = res.headers['x-render-time'];
  if (renderTime) {
    const ms = parseFloat(String(renderTime).replace('ms', ''));
    if (!Number.isNaN(ms)) events.emit('histogram', 'render.compose_time_ms', ms);
  }

  const bytes = Number(res.headers['content-length']);
  if (!Number.isNaN(bytes) && bytes > 0) events.emit('histogram', 'render.bytes', bytes);

  return next();
}

module.exports = { recordCacheOutcome };

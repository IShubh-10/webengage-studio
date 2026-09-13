/**
 * Render counters behind /metrics.
 */

const metrics = {
  renders: 0,
  cacheHits: 0,
  cacheMisses: 0,
  avgRenderTime: 0,
  renderTimes: [],
};

function recordMetric(time) {
  metrics.renders++;
  metrics.renderTimes.push(time);
  if (metrics.renderTimes.length > 1000) {
    metrics.renderTimes.shift();
  }
  metrics.avgRenderTime =
    metrics.renderTimes.reduce((a, b) => a + b, 0) / metrics.renderTimes.length;
}

module.exports = { metrics, recordMetric };

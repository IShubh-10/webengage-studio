/**
 * Liveness and cache/render counters.
 */

const cluster = require('cluster');
const express = require('express');

const router = express.Router();

const redisState = require('../config/redis').state;
const { metrics } = require('../lib/metrics');
const { bufferCache, metadataCache, svgCache, resizedCache } = require('../lib/cache');
const { renderLimiter } = require('../lib/limiter');
const { DB_CONNECTION_LIMIT, WORKER_COUNT } = require('../config');

router.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',
    uptime: process.uptime(),
    memory: process.memoryUsage(),
    // 'disabled' means no Redis was configured, so the miss is deliberate and
    // the app is on its in-memory caches; 'disconnected' means one is configured
    // and unreachable, which is worth paging about.
    redis: redisState.enabled === false ? 'disabled' : redisState.connected ? 'connected' : 'disconnected',
    timestamp: new Date().toISOString(),
  });
});

router.get('/metrics', (req, res) => {
  const bufferStats = bufferCache.stats();
  const metadataStats = metadataCache.stats();
  const svgStats = svgCache.stats();
  const resizedStats = resizedCache.stats();

  res.json({
    renders: metrics.renders,
    avgRenderTime: metrics.avgRenderTime.toFixed(2),
    bufferCache: bufferStats,
    metadataCache: metadataStats,
    svgCache: svgStats,
    resizedCache: resizedStats,
    memory: process.memoryUsage(),
    workerId: cluster.worker?.id || 'master',
    // `rejected` climbing is the signal that this instance is undersized for
    // the send it is being asked to serve — not that anything is broken.
    renderLimiter: renderLimiter.stats(),
    pool: {
      connectionsPerWorker: DB_CONNECTION_LIMIT,
      workers: WORKER_COUNT,
      maxConnections: DB_CONNECTION_LIMIT * WORKER_COUNT,
    },
  });
});

module.exports = router;

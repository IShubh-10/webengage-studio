/**
 * The public render endpoint: composites a template's layers over its
 * background and returns a PNG. Deliberately unauthenticated — rendered images
 * have to load in emails and push notifications.
 *
 * The compositing itself lives in services/render.js, shared with the countdown
 * timer endpoint. This file owns only the cache lookup and the response.
 */

const crypto = require('crypto');
const express = require('express');

const router = express.Router();

const redisState = require('../config/redis').state;
const { collectVars, renderTemplate } = require('../services/render');
const { metrics, recordMetric } = require('../lib/metrics');
const { renderLimiter } = require('../lib/limiter');

router.get('/api/v1/render/:templateId', async (req, res) => {
  const startTime = Date.now();

  try {
    const { templateId } = req.params;
    const vars = collectVars(req.query);

    // Create render cache key with hash of variables
    const varHash = crypto.createHash('md5').update(JSON.stringify(vars)).digest('hex');
    const renderCacheKey = `render:${templateId}:${varHash}`;

    // 1. Check Redis render cache first
    if (redisState.connected) {
      try {
        const cachedPng = await redisState.client.getBuffer(renderCacheKey);
        if (cachedPng) {
          if (process.env.DEBUG_CACHE === 'true') {
            console.log(`🎯 Render cache HIT: ${renderCacheKey}`);
          }
          res.setHeader('Content-Type', 'image/png');
          res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
          res.setHeader('X-Cache', 'HIT-REDIS');
          metrics.cacheHits++;
          return res.send(cachedPng);
        }
      } catch (err) {
        console.warn('⚠️ Redis render cache error:', err.message);
      }
    }

    // 2. Composite the template, under the same budget the GIF endpoint uses —
    //    both are CPU work on this one event loop.
    const pngBuffer = await renderLimiter.run(async () => {
      const { pipeline } = await renderTemplate(templateId, vars);
      return pipeline.png({ quality: 90, compressionLevel: 6 }).toBuffer();
    });

    // 3. Cache final PNG asynchronously
    if (redisState.connected) {
      redisState.client.set(renderCacheKey, pngBuffer, 'EX', 600).catch((err) => {
        console.warn('⚠️ Redis render cache set error:', err.message);
      });
    }

    const renderTime = Date.now() - startTime;
    recordMetric(renderTime);

    if (process.env.DEBUG_TIMING === 'true') {
      console.log(`⏱️ Render completed in ${renderTime}ms`);
    }

    // Set cache headers for CDN/browser
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
    res.setHeader('X-Cache', 'MISS');
    res.setHeader('X-Render-Time', `${renderTime}ms`);

    res.send(pngBuffer);
  } catch (err) {
    if (err.code === 'OVERLOADED') {
      res.setHeader('Retry-After', '1');
      return res.status(503).json({ error: 'Render queue is full, retry shortly' });
    }
    if (err.status) {
      return res.status(err.status).json({ error: err.message });
    }
    console.error('Fatal render error:', err);
    res.status(500).json({ error: 'Failed to render image', details: err.message });
  }
});

module.exports = router;

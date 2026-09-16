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
const {
  collectVars,
  renderTemplate,
  loadTemplateSchema,
  templatePlaceholders,
  relevantVars,
} = require('../services/render');
const { metrics, recordMetric } = require('../lib/metrics');
const { renderLimiter } = require('../lib/limiter');
const { rateLimit } = require('../middleware/rateLimit');
const { RATE_LIMIT_RENDER, RATE_LIMIT_WINDOW_SECONDS } = require('../config');

/*
 * This endpoint is public and every miss is ~half a second to several seconds
 * of CPU, so it needs the same ceiling the timer GIF has. Generous for the
 * same reason: an email client fetches it on behalf of a whole campaign, and a
 * limit tight enough to inconvenience an attacker would break a real send
 * first. Refusals are JSON here rather than a blank image — unlike the timer
 * GIF this is also called by tooling that benefits from a readable error.
 */
const renderRateLimit = rateLimit({
  name: 'render',
  limit: RATE_LIMIT_RENDER,
  windowSeconds: RATE_LIMIT_WINDOW_SECONDS,
});

router.get('/api/v1/render/:templateId', renderRateLimit, async (req, res) => {
  const startTime = Date.now();

  try {
    const { templateId } = req.params;
    const vars = collectVars(req.query);

    /*
     * Key on the variables the template actually uses, not on everything that
     * arrived.
     *
     * Hashing the whole query string meant `?junk=1`, `?junk=2`, `?junk=3` were
     * three different cache entries producing three identical images — so a
     * caller could force an unbounded number of fresh composites, each one
     * seconds of CPU and 600s of Redis, simply by counting. Reducing to the
     * placeholders the creative contains is exact rather than a heuristic: a
     * variable the template never mentions cannot change a pixel of the output.
     *
     * The timer endpoint has done this since it was written (`cacheVars` in
     * services/countdown); this is the same reduction, finally applied here.
     */
    let keyVars = vars;
    try {
      const template = await loadTemplateSchema(templateId);
      if (template) keyVars = relevantVars(vars, templatePlaceholders(template));
    } catch (err) {
      // Never let key optimisation break a render: the full set is correct,
      // just less cacheable.
      console.warn('⚠️ Could not resolve template placeholders:', err.message);
    }

    const varHash = crypto.createHash('md5').update(JSON.stringify(keyVars)).digest('hex');
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

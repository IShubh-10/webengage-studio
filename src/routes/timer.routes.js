/**
 * Countdown timers: the public GIF that lives in an email, and the authenticated
 * endpoints the builder uses.
 *
 * The GIF endpoint is the whole point of the feature. HTML email has no
 * JavaScript, so a live clock can only be an image the server redraws on every
 * open — which means this route has to be reachable without a session, and has
 * to be impossible for any cache between here and the inbox to answer.
 */

const express = require('express');

const router = express.Router();

const { scanDelete } = require('../lib/redisOps');
const { renderLimiter } = require('../lib/limiter');
const { recordMetric } = require('../lib/metrics');
const { ensureTimerSchema } = require('../db/schema');
const { requireAuth, requireAdmin } = require('../middleware/guards');
const { collectVars } = require('../services/render');
const { renderTimer, BLANK_GIF } = require('../services/countdown');
const { renderStill } = require('../services/countdown/still');
const { normalizeTimer, applyQueryOverrides } = require('../services/countdown/config');
const { loadTimer, invalidateTimer } = require('../services/timers');
const {
  nextTimerId,
  listTimers,
  findTimer,
  saveTimer,
  deleteTimer,
} = require('../repositories/timerRepository');
const { NO_STORE_HEADERS } = require('../config');

// Query keys the timer itself consumes. Everything else is passed through as a
// template variable, so a creative can still be personalised per recipient.
const RESERVED_QUERY_KEYS = new Set([
  'end', 'tz', 'dur', 'uid', 'template', 'bg', 'w', 'bgcolor', 'colors', 'frames', 'loop',
  'x', 'y', 'units', 'font', 'size', 'weight', 'color', 'sep', 'sepcolor', 'gap',
  'labels', 'labelcolor', 'labelsize',
  'plate', 'platecolor', 'plateradius', 'plateopacity', 'platepadx', 'platepady',
  'expired', 'expiredmode', 'expiredcolor', 'expiredimage', 'vars',
]);

function templateVars(query) {
  const vars = collectVars(query);
  RESERVED_QUERY_KEYS.forEach((key) => delete vars[key]);
  return vars;
}

function noStore(res) {
  Object.entries(NO_STORE_HEADERS).forEach(([header, value]) => res.setHeader(header, value));
  // Gmail's proxy keys partly on the URL; varying nothing is still worth saying
  // explicitly so no shared cache decides two recipients can share a response.
  res.setHeader('Vary', '*');
}

/* ------------------------------------------------------------ the GIF */

/**
 * The image that goes in the email:
 *
 *   <img src="https://studio.example.com/api/v1/timer/TMR-01.gif" width="600" />
 *
 * `.gif` is part of the path rather than a query parameter because some email
 * clients and link scanners decide whether to fetch something by its extension.
 */
router.get('/api/v1/timer/:timerId.gif', async (req, res) => {
  const startTime = Date.now();

  try {
    // Cached in memory and in Redis: this runs once per email open, and the
    // database is the one layer that must not be on that path.
    const saved = await loadTimer(req.params.timerId);
    if (!saved) {
      // A broken image in a live campaign is worse than a blank one, and a 404
      // in an inbox cannot be fixed by the recipient.
      noStore(res);
      res.setHeader('Content-Type', 'image/gif');
      return res.status(404).send(BLANK_GIF);
    }

    const timer = applyQueryOverrides(saved.config, req.query);

    // Bounded: past the queue limit this rejects immediately rather than
    // parking the request behind work nobody is waiting for any more.
    const result = await renderLimiter.run(() =>
      renderTimer(timer, {
        vars: templateVars(req.query),
        uid: String(req.query.uid || ''),
      })
    );

    noStore(res);
    res.setHeader('Content-Type', 'image/gif');
    res.setHeader('Content-Length', result.buffer.length);
    res.setHeader('X-Timer-Expired', String(result.expired));
    res.setHeader('X-Timer-Remaining', String(result.remainingSeconds));
    res.setHeader('X-Timer-Frames', String(result.frames));
    res.setHeader('X-Timer-Loop', result.looping ? 'infinite' : 'once');
    res.setHeader('X-Cache', result.cached ? 'HIT-REDIS' : 'MISS');

    // The GIF endpoint is the busiest thing this server does, and until now it
    // was the one render path /metrics could not see.
    const renderTime = Date.now() - startTime;
    recordMetric(renderTime);
    res.setHeader('X-Render-Time', `${renderTime}ms`);

    res.send(result.buffer);
  } catch (err) {
    noStore(res);
    res.setHeader('Content-Type', 'image/gif');

    // Shedding load is a deliberate, expected answer under a burst — a 503 with
    // a Retry-After, not a stack trace on every one of them.
    if (err.code === 'OVERLOADED') {
      res.setHeader('Retry-After', '1');
      return res.status(503).send(BLANK_GIF);
    }

    console.error('Timer render error:', err);
    res.status(err.status && err.status < 500 ? err.status : 500).send(BLANK_GIF);
  }
});

/* ------------------------------------------------- builder: preview */

/**
 * A still PNG of a draft timer. The builder posts whatever is on screen, so this
 * works before anything has been saved.
 */
router.post('/api/v1/timers/preview', requireAuth, async (req, res) => {
  try {
    const timer = normalizeTimer(req.body.config || {});
    const previewSeconds =
      req.body.previewSeconds === undefined || req.body.previewSeconds === null
        ? null
        : Number(req.body.previewSeconds);

    const still = await renderStill(timer, {
      vars: req.body.vars || {},
      previewSeconds: Number.isFinite(previewSeconds) ? previewSeconds : null,
    });

    res.json({
      success: true,
      image: `data:image/png;base64,${still.buffer.toString('base64')}`,
      width: still.width,
      height: still.height,
      block: still.block,
      fits: still.fits,
      expired: still.expired,
      remainingSeconds: still.remainingSeconds,
    });
  } catch (err) {
    console.error('Timer preview error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to render preview' });
  }
});

/**
 * The animated GIF for a draft, so the builder can show the real thing — the
 * same bytes the inbox will get — before it is saved.
 */
router.post('/api/v1/timers/preview.gif', requireAuth, async (req, res) => {
  try {
    const timer = normalizeTimer(req.body.config || {});
    const result = await renderLimiter.run(() => renderTimer(timer, { vars: req.body.vars || {} }));

    res.json({
      success: true,
      image: `data:image/gif;base64,${result.buffer.toString('base64')}`,
      bytes: result.buffer.length,
      expired: result.expired,
      looping: result.looping,
      remainingSeconds: result.remainingSeconds,
      frames: result.frames,
    });
  } catch (err) {
    console.error('Timer GIF preview error:', err);
    res.status(err.status || 500).json({ error: err.message || 'Failed to render timer' });
  }
});

/* ------------------------------------------------ builder: library */

router.get('/api/v1/timers/next-id', requireAuth, async (req, res) => {
  try {
    await ensureTimerSchema();
    res.json({ nextId: await nextTimerId() });
  } catch (err) {
    console.error('Error generating timer ID:', err);
    res.json({ nextId: `TMR-${Math.floor(10 + Math.random() * 90)}` });
  }
});

router.get('/api/v1/timers', requireAuth, async (req, res) => {
  try {
    await ensureTimerSchema();
    res.json({ success: true, timers: await listTimers() });
  } catch (err) {
    console.error('Error fetching timers:', err);
    res.status(500).json({ error: 'Failed to fetch timers' });
  }
});

router.get('/api/v1/timers/:timerId', requireAuth, async (req, res) => {
  try {
    await ensureTimerSchema();

    const timer = await findTimer(req.params.timerId);
    if (!timer) return res.status(404).json({ error: 'Timer not found' });

    res.json({ success: true, timer });
  } catch (err) {
    console.error('Error fetching timer:', err);
    res.status(500).json({ error: 'Failed to fetch timer' });
  }
});

router.post('/api/v1/timers', requireAuth, async (req, res) => {
  try {
    await ensureTimerSchema();

    const { timerId, name } = req.body;
    if (!timerId || !name) {
      return res.status(400).json({ error: 'A timer needs an id and a name' });
    }

    const config = normalizeTimer(req.body.config || {});

    if (!config.source.templateId && !config.source.backgroundUrl) {
      return res.status(400).json({ error: 'Pick a creative: a studio template or an image URL' });
    }

    await saveTimer({
      timerId: String(timerId).slice(0, 100),
      name: String(name).slice(0, 190),
      config,
      createdBy: req.user ? req.user.uid : null,
    });

    // Styling changed, so every sprite bundle built from the old definition is
    // stale — including the ones sitting in other workers' memory.
    await invalidateTimerCaches(timerId);

    res.json({ success: true, timerId, message: 'Timer saved' });
  } catch (err) {
    console.error('Error saving timer:', err);
    res.status(500).json({ error: 'Failed to save timer' });
  }
});

// Deleting is destructive and permanent — any live campaign pointing at this
// timer starts serving a blank pixel — so it matches the templates rule and is
// admin-only.
router.post('/api/v1/timers/:timerId/delete', requireAdmin, async (req, res) => {
  try {
    await ensureTimerSchema();

    const { timerId } = req.params;
    if (!(await deleteTimer(timerId))) return res.status(404).json({ error: 'Timer not found' });

    await invalidateTimerCaches(timerId);

    console.log(`🗑️ Timer ${timerId} deleted by ${req.adminUser.email}`);
    res.json({ success: true, timerId, message: 'Timer deleted' });
  } catch (err) {
    console.error('Error deleting timer:', err);
    res.status(500).json({ error: 'Failed to delete timer' });
  }
});

/**
 * Sprite bundles are keyed by what they look like, not by which timer they came
 * from, so an edit cannot invalidate them by id — the safe move is to drop them
 * all. They are rebuilt lazily and there are only ever a handful.
 *
 * `invalidateTimer` does the part that has to reach every worker: it clears the
 * cached row in Redis and publishes on the invalidation channel, which is what
 * drops the in-memory copies and the sprite bundles in the other processes.
 * Before that existed, saving a timer fixed the worker that handled the request
 * and left the rest serving the old creative.
 */
async function invalidateTimerCaches(timerId) {
  await invalidateTimer(timerId);

  try {
    // SCAN, not KEYS: KEYS blocks the whole Redis server for the length of a
    // full keyspace walk, and everything in this app shares that server.
    await scanDelete('timer:sprites:*');
    await scanDelete('timer:gif:*');
  } catch (err) {
    console.warn(`⚠️ Timer cache invalidation error (${timerId}):`, err.message);
  }
}

module.exports = router;

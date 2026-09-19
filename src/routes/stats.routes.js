/**
 * Open stats: how often each rendered creative is actually being looked at.
 *
 * Reading is open to anyone signed in, the same as the libraries themselves —
 * the studio is a shared workspace, and a creative's numbers are no more
 * private than the creative. Writing is not an endpoint at all: the counts
 * come from the render paths themselves, through services/openCounter.js.
 */

const express = require('express');

const router = express.Router();

const { requireAuth } = require('../middleware/guards');
const { ensureStatsSchema } = require('../db/schema');
const { parseRange, overview, assetReport } = require('../services/openStats');

/**
 * The window comes from the browser, because the calendar does: "this month"
 * is the reader's month, and only their browser knows which one that is. The
 * server validates and snaps it — see services/openStats.js.
 */
function readRange(req) {
  return parseRange({
    from: req.query.from,
    to: req.query.to,
    unit: req.query.unit,
    tzOffset: req.query.tzOffset,
  });
}

function windowShape(range) {
  return {
    from: new Date(range.fromMs).toISOString(),
    to: new Date(range.toMs).toISOString(),
    unit: range.unit,
    tzOffset: range.offsetMinutes,
  };
}

/** Every creative, ranked by opens in the window, plus the window's shape. */
router.get('/api/v1/stats/overview', requireAuth, async (req, res) => {
  try {
    await ensureStatsSchema();

    const range = readRange(req);
    const report = await overview(range);

    res.json({ success: true, window: windowShape(range), ...report });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Error building the stats overview:', err);
    res.status(500).json({ error: 'Failed to load open stats' });
  }
});

/** One creative: the same window, plus its hour-of-day profile and lifetime. */
router.get('/api/v1/stats/asset/:assetType/:assetId', requireAuth, async (req, res) => {
  try {
    await ensureStatsSchema();

    const range = readRange(req);
    const report = await assetReport(range, req.params.assetType, req.params.assetId);

    res.json({ success: true, window: windowShape(range), ...report });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Error building the stats report:', err);
    res.status(500).json({ error: 'Failed to load open stats' });
  }
});

module.exports = router;

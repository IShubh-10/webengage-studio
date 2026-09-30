/**
 * Open stats: how often each rendered creative is actually being looked at.
 *
 * What a reader may see mirrors the libraries: a member's numbers are their
 * own creatives' numbers and nothing else, and an admin sees the whole studio
 * — either rolled up, or narrowed to one person with `?user=`. The scope is
 * resolved here and enforced in the service, never in the browser.
 *
 * Writing is not an endpoint at all: the counts come from the render paths
 * themselves, through services/openCounter.js.
 */

const express = require('express');

const router = express.Router();

const { requireAuth, isAdminUser } = require('../middleware/guards');
const { ensureAuthSchema, ensureStatsSchema } = require('../db/schema');
const { listUsers } = require('../repositories/userRepository');
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

/**
 * Whose numbers this request is allowed to return.
 *
 * A member is pinned to their own creatives, whatever `?user=` says — the
 * parameter only means anything to an admin, for whom it is the difference
 * between the studio's numbers and one person's. `?user=none` is the
 * creatives written before ownership was recorded, which belong to nobody.
 */
async function readScope(req) {
  const admin = await isAdminUser(req.user);
  if (!admin) return { viewerIsAdmin: false, scope: { createdBy: Number(req.user.uid) } };

  const requested = String(req.query.user || 'all').trim();
  if (requested === '' || requested === 'all') return { viewerIsAdmin: true, scope: { all: true } };
  if (requested === 'none') return { viewerIsAdmin: true, scope: { createdBy: null } };

  const id = Number(requested);
  if (!Number.isInteger(id) || id <= 0) {
    const err = new Error(`Not a user: ${requested}`);
    err.status = 400;
    throw err;
  }

  return { viewerIsAdmin: true, scope: { createdBy: id } };
}

/** Who an admin may narrow the page to. Nothing for anyone else to filter by. */
async function scopeOptions(viewerIsAdmin) {
  if (!viewerIsAdmin) return undefined;

  await ensureAuthSchema();
  const users = await listUsers();

  return users.map((user) => ({ id: user.id, name: user.name, role: user.role }));
}

/** What the response says about the scope it answered in. */
function scopeShape(scope) {
  if (scope.all) return 'all';
  return scope.createdBy === null ? 'none' : String(scope.createdBy);
}

function windowShape(range) {
  return {
    from: new Date(range.fromMs).toISOString(),
    to: new Date(range.toMs).toISOString(),
    unit: range.unit,
    tzOffset: range.offsetMinutes,
  };
}

/**
 * Every creative the reader may see, ranked by opens in the window, plus the
 * window's shape and — for an admin — the same total broken down by person.
 */
router.get('/api/v1/stats/overview', requireAuth, async (req, res) => {
  try {
    await ensureStatsSchema();

    const range = readRange(req);
    const { viewerIsAdmin, scope } = await readScope(req);
    const [report, users] = await Promise.all([overview(range, scope), scopeOptions(viewerIsAdmin)]);

    res.json({
      success: true,
      window: windowShape(range),
      viewerIsAdmin,
      scope: scopeShape(scope),
      users,
      ...report,
    });
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
    const { viewerIsAdmin, scope } = await readScope(req);

    /*
     * One creative is always read against the reader's own scope, never the
     * `?user=` one: an admin looking at Bhavya's page still has to be able to
     * click through to a creative, and the ownership check belongs to who is
     * asking, not to which folder they were browsing.
     */
    const report = await assetReport(
      range,
      req.params.assetType,
      req.params.assetId,
      viewerIsAdmin ? { all: true } : scope
    );

    res.json({ success: true, window: windowShape(range), viewerIsAdmin, ...report });
  } catch (err) {
    if (err.status) return res.status(err.status).json({ error: err.message });
    console.error('Error building the stats report:', err);
    res.status(500).json({ error: 'Failed to load open stats' });
  }
});

module.exports = router;

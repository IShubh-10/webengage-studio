/**
 * Route guards. Admin checks re-read the role from the database rather than
 * trusting the role baked into the session cookie, so a promotion or removal
 * takes effect on the next request instead of whenever the cookie expires.
 */

const { ensureAuthSchema } = require('../db/schema');
const { loadUserRow } = require('../repositories/userRepository');

function requireAuth(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });
  next();
}

async function resolveAdmin(req) {
  if (!req.user) return { status: 401 };
  await ensureAuthSchema();

  const row = await loadUserRow(req.user.uid);
  if (!row) return { status: 401 };
  if (row.role !== 'admin') return { status: 403, row };

  return { status: 200, row };
}

async function requireAdmin(req, res, next) {
  try {
    const { status, row } = await resolveAdmin(req);
    if (status === 401) return res.status(401).json({ error: 'Authentication required' });
    if (status === 403) return res.status(403).json({ error: 'Admin access required' });
    req.adminUser = row;
    next();
  } catch (err) {
    console.error('Error checking admin access:', err);
    res.status(500).json({ error: 'Failed to verify admin access' });
  }
}

function requireAuthPage(req, res, next) {
  if (!req.user) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
  next();
}

async function requireAdminPage(req, res, next) {
  try {
    const { status, row } = await resolveAdmin(req);
    if (status === 401) return res.redirect(`/login?next=${encodeURIComponent(req.originalUrl)}`);
    if (status === 403) return res.redirect('/tools');
    req.adminUser = row;
    next();
  } catch (err) {
    console.error('Error checking admin page access:', err);
    res.redirect('/tools');
  }
}

/**
 * Is this user allowed to change something someone else may have made?
 *
 * The rule the studio uses everywhere: the person who created it, or an admin.
 * Everyone else can look at it — nothing here restricts reading, because a
 * shared library is the point.
 *
 * The role is read from the database rather than taken from the session, for
 * the same reason `resolveAdmin` does it: a cookie issued before someone was
 * promoted — or after they were demoted — would otherwise carry the old answer
 * for up to seven days.
 *
 * A row with no `createdBy` predates ownership being recorded. It falls
 * through to the admin check rather than being treated as unowned and editable
 * by anyone, because the safe reading of "nobody claims this" is "not yours".
 */
async function canManage(user, createdBy) {
  if (!user) return false;

  if (createdBy !== null && createdBy !== undefined && Number(createdBy) === Number(user.uid)) {
    return true;
  }

  const row = await loadUserRow(user.uid);
  return Boolean(row && row.role === 'admin');
}

/** True when this user is an admin right now, per the database. */
async function isAdminUser(user) {
  if (!user) return false;
  const row = await loadUserRow(user.uid);
  return Boolean(row && row.role === 'admin');
}

module.exports = {
  requireAuth,
  requireAdmin,
  requireAuthPage,
  requireAdminPage,
  canManage,
  isAdminUser,
};

/**
 * Cross-site request forgery defence.
 *
 * The session cookie is `SameSite=None` in production, because the front end
 * is also published as a static site on GitHub Pages and has to reach this API
 * across origins (see src/services/sessions.js). That hands the browser's
 * built-in CSRF protection back: any page on the internet can now make the
 * browser POST here with the user's cookie attached, and CORS will not stop it
 * — CORS decides who may *read* the reply, not who may send the request, and a
 * form post or a `fetch` with no JSON body is a "simple" request that is not
 * preflighted at all.
 *
 * So the check moves here. Browsers set `Origin` on every state-changing
 * request and a page cannot forge it, so comparing it against the same
 * allowlist CORS uses is a complete defence for browser traffic. A request
 * with no `Origin` at all is not a browser doing a cross-site post — it is
 * curl, a health check, or a server-to-server call — and is left alone; there
 * is no cookie-bearing attack to mount from there.
 */

const { CORS_ORIGINS } = require('../config');

// GET and HEAD do not change state; OPTIONS is the preflight, answered by CORS.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

function requireTrustedOrigin(req, res, next) {
  if (SAFE_METHODS.has(req.method)) return next();

  const origin = req.get('origin');
  if (!origin) return next();

  if (CORS_ORIGINS.includes(origin)) return next();

  console.warn(`Blocked ${req.method} ${req.path} from untrusted origin ${origin}`);
  res.status(403).json({ error: 'Request origin not allowed' });
}

module.exports = { requireTrustedOrigin };

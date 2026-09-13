/**
 * Resolves the session cookie on every request, before anything is served, so
 * both APIs and page routes can read req.user.
 *
 * The no-cookie case finishes synchronously on purpose. This runs in front of
 * the public render endpoints too — the GIF in an email carries no cookie and
 * is the busiest thing this server does — so a request without a token must not
 * pay for a Redis round trip, or even for an await.
 */

const { SESSION_COOKIE } = require('../config');
const { parseCookies, verifySessionToken, isSessionRevoked } = require('../services/sessions');

function attachUserFromSession(req, res, next) {
  const bearer = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  const token = parseCookies(req)[SESSION_COOKIE] || bearer;

  if (!token) {
    req.user = null;
    return next();
  }

  const payload = verifySessionToken(token);

  if (!payload) {
    req.user = null;
    return next();
  }

  // Only a request that presented a valid token reaches Redis, and only to ask
  // whether it has since been withdrawn.
  isSessionRevoked(payload)
    .then((revoked) => {
      req.user = revoked ? null : payload;
      next();
    })
    .catch(() => {
      // isSessionRevoked already fails open; this is belt and braces.
      req.user = payload;
      next();
    });
}

module.exports = { attachUserFromSession };

/**
 * Sessions: an encrypted, authenticated token in an httpOnly cookie, plus a
 * revocation list in Redis.
 *
 * Stateless by design. There is no session table and no session row in Redis on
 * the read path, so any cluster worker can establish who is calling from the
 * cookie alone — with four workers behind one port a request can land anywhere,
 * and a shared session store would put a lookup on every authenticated request.
 *
 * Two properties the first version did not have:
 *
 *   - the payload is *encrypted*, not merely signed. It was previously plain
 *     base64, so anything holding the cookie — a proxy log, a HAR file attached
 *     to a support ticket, a screenshot of devtools — exposed the account's
 *     email, name and role in readable form.
 *
 *   - sessions can be revoked. Signing out used to clear the cookie in the
 *     browser and nothing more, so a token that had already leaked stayed valid
 *     for its full seven days and a deleted account kept working until then.
 *
 * AES-256-GCM gives confidentiality and integrity in one pass: a tampered token
 * fails to decrypt, so there is no separate signature to check.
 */

const crypto = require('crypto');

const redisState = require('../config/redis').state;
const {
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  SESSION_SECRET,
} = require('../config');

// Version prefix. Tokens issued by the signed-only scheme do not carry it and
// are rejected, which is harmless: this ships alongside a SESSION_SECRET change,
// and that signs everyone out regardless.
const TOKEN_VERSION = 'v2';

// SESSION_SECRET is an arbitrary-length passphrase; AES needs exactly 32 bytes.
// HKDF is the right tool rather than hashing the secret directly, and the info
// string keeps this key distinct from anything else the secret might key later.
const KEY = Buffer.from(
  crypto.hkdfSync('sha256', Buffer.from(SESSION_SECRET, 'utf8'), Buffer.alloc(0), 'we-studio-session-v2', 32)
);

function createSessionToken(user) {
  const now = Math.floor(Date.now() / 1000);

  const payload = {
    uid: user.id,
    email: user.email,
    name: user.name,
    role: user.role,
    // A token id, so one session can be revoked without touching the others.
    jti: crypto.randomBytes(12).toString('base64url'),
    iat: now,
    // Issued-at in milliseconds as well. "Sign out everywhere" has to separate
    // tokens minted before the revoke from ones minted after it, and at
    // one-second resolution those two are indistinguishable inside the second
    // the revoke happens — which is exactly the second a user signs back in.
    ms: Date.now(),
    exp: now + SESSION_TTL_SECONDS,
  };

  // 96-bit nonce is what GCM is specified for, and it is fresh per token.
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', KEY, iv);

  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(payload), 'utf8'),
    cipher.final(),
  ]);

  return [
    TOKEN_VERSION,
    iv.toString('base64url'),
    ciphertext.toString('base64url'),
    cipher.getAuthTag().toString('base64url'),
  ].join('.');
}

/**
 * Decrypts and validates a token. Returns the payload, or null for anything
 * that is malformed, tampered with, or expired.
 *
 * Synchronous and pure: no I/O. Revocation is a separate, async check so the
 * public render endpoints — which carry no cookie — never pay for it.
 */
function verifySessionToken(token) {
  if (!token || typeof token !== 'string') return null;

  const parts = token.split('.');
  if (parts.length !== 4 || parts[0] !== TOKEN_VERSION) return null;

  try {
    const iv = Buffer.from(parts[1], 'base64url');
    const ciphertext = Buffer.from(parts[2], 'base64url');
    const tag = Buffer.from(parts[3], 'base64url');

    if (iv.length !== 12 || tag.length !== 16) return null;

    const decipher = crypto.createDecipheriv('aes-256-gcm', KEY, iv);
    decipher.setAuthTag(tag);

    // final() throws if the tag does not match, which is the integrity check.
    const plaintext = Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
    const payload = JSON.parse(plaintext);

    if (!payload.exp || payload.exp < Math.floor(Date.now() / 1000)) return null;
    if (!payload.uid) return null;

    return payload;
  } catch (err) {
    // Wrong key, tampered ciphertext, or not a token at all.
    return null;
  }
}

/* ------------------------------------------------------------ revocation */

const revokedKey = (jti) => `session:revoked:${jti}`;
const epochKey = (uid) => `session:epoch:${uid}`;

/**
 * Whether this token has been withdrawn since it was issued — either
 * individually (signed out) or as part of every session for the account
 * (password reset, account deleted, signed out everywhere).
 *
 * Fails *open* when Redis is unavailable, matching how the rest of the app
 * treats Redis as an accelerator rather than a dependency. The alternative is
 * that a Redis blip signs out every user at once, which is a worse outcome than
 * briefly honouring a revoked token — a cookie only reaches here after
 * decrypting correctly under the server's key.
 */
async function isSessionRevoked(payload) {
  if (!payload || !redisState.connected || !redisState.client) return false;

  try {
    const [revoked, epoch] = await redisState.client.mget(
      revokedKey(payload.jti || ''),
      epochKey(payload.uid)
    );

    if (revoked) return true;

    // Every token issued before the epoch is dead, which is how "sign out
    // everywhere" works without enumerating the sessions. Compared in
    // milliseconds so a session created immediately after the revoke — someone
    // signing back in — is cleanly newer rather than a coin flip.
    if (epoch) {
      const issuedMs = Number(payload.ms || (payload.iat || 0) * 1000);
      if (issuedMs < Number(epoch)) return true;
    }

    return false;
  } catch (err) {
    console.warn('⚠️ Could not check session revocation:', err.message);
    return false;
  }
}

/** Withdraw one session. The entry only has to outlive the token it blocks. */
async function revokeSession(payload) {
  if (!payload || !payload.jti || !redisState.connected) return;

  const remaining = Math.max(1, Number(payload.exp || 0) - Math.floor(Date.now() / 1000));

  try {
    await redisState.client.set(revokedKey(payload.jti), '1', 'EX', remaining);
  } catch (err) {
    console.warn('⚠️ Could not revoke session:', err.message);
  }
}

/**
 * Withdraw every session for an account, current and outstanding. Used when an
 * account is deleted and available to the user as "sign out everywhere".
 */
async function revokeAllSessions(uid) {
  if (!uid || !redisState.connected) return;

  try {
    // Milliseconds, to match the `ms` claim in the token. Everything issued
    // before this instant dies; everything issued after it — including the
    // login the user is about to make — lives. At second resolution those two
    // cases collide inside the revoke's own second, and whichever way that was
    // resolved was wrong: round up and a fresh login is dead on arrival, round
    // down and a session being revoked survives for up to a second.
    await redisState.client.set(
      epochKey(uid),
      String(Date.now()),
      'EX',
      SESSION_TTL_SECONDS + 60
    );
  } catch (err) {
    console.warn('⚠️ Could not revoke account sessions:', err.message);
  }
}

/* ---------------------------------------------------------------- cookies */

function parseCookies(req) {
  const header = req.headers.cookie;
  const cookies = {};
  if (!header) return cookies;

  header.split(';').forEach((pair) => {
    const idx = pair.indexOf('=');
    if (idx < 0) return;
    const key = pair.slice(0, idx).trim();
    if (!key) return;
    const raw = pair.slice(idx + 1).trim();
    try {
      cookies[key] = decodeURIComponent(raw);
    } catch (err) {
      cookies[key] = raw;
    }
  });

  return cookies;
}

function setSessionCookie(res, user) {
  res.cookie(SESSION_COOKIE, createSessionToken(user), {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    maxAge: SESSION_TTL_SECONDS * 1000,
    path: '/',
  });
}

function clearSessionCookie(res) {
  res.clearCookie(SESSION_COOKIE, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.NODE_ENV === 'production',
    path: '/',
  });
}

function publicUser(row) {
  return {
    id: row.id || row.uid,
    name: row.name,
    email: row.email,
    phone: row.phone || null,
    role: row.role,
  };
}

module.exports = {
  createSessionToken,
  verifySessionToken,
  isSessionRevoked,
  revokeSession,
  revokeAllSessions,
  parseCookies,
  setSessionCookie,
  clearSessionCookie,
  publicUser,
};

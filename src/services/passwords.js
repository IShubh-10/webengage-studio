/**
 * Password hashing with scrypt from node:crypto — no extra dependency, and a
 * password is never stored or logged in readable form.
 */

const crypto = require('crypto');

function scryptDerive(password, salt, N, r, pCost) {
  return new Promise((resolve, reject) => {
    crypto.scrypt(
      password,
      salt,
      64,
      { N, r, p: pCost, maxmem: 128 * 1024 * 1024 },
      (err, derivedKey) => (err ? reject(err) : resolve(derivedKey))
    );
  });
}

async function hashPassword(password) {
  const N = 16384;
  const r = 8;
  const pCost = 1;
  const salt = crypto.randomBytes(16);
  const derived = await scryptDerive(password, salt, N, r, pCost);
  return ['scrypt', N, r, pCost, salt.toString('hex'), derived.toString('hex')].join('$');
}

async function verifyPassword(password, stored) {
  const parts = String(stored || '').split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;

  const N = parseInt(parts[1], 10);
  const r = parseInt(parts[2], 10);
  const pCost = parseInt(parts[3], 10);
  if (!N || !r || !pCost) return false;

  try {
    const salt = Buffer.from(parts[4], 'hex');
    const expected = Buffer.from(parts[5], 'hex');
    const derived = await scryptDerive(password, salt, N, r, pCost);
    return derived.length === expected.length && crypto.timingSafeEqual(derived, expected);
  } catch (err) {
    console.warn('⚠️ Password verification error:', err.message);
    return false;
  }
}

// --- Stateless session token (HMAC signed, so any cluster worker can verify) -

module.exports = { hashPassword, verifyPassword };

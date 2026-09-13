/**
 * One-time codes for phone verification. Codes are held as HMAC digests with a
 * TTL in Redis, so a look at the store hands out no live codes; the in-memory
 * map is a single-worker development fallback only.
 */

const crypto = require('crypto');

const redisState = require('../config/redis').state;
const {
  PHONE_COUNTRY_CODE,
  PHONE_REGEX,
  SESSION_SECRET,
  OTP_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
} = require('../config');

const otpMemory = new Map();

// Accepts what people actually type: spaces, dashes, a leading 0, or +91 already
// pasted in. Returns the bare 10 digits, or null when it is not a valid number.
function normalizePhone(raw) {
  const digits = String(raw || '').replace(/\D/g, '');
  let local = digits;

  if (local.length === 12 && local.startsWith('91')) local = local.slice(2);
  else if (local.length === 11 && local.startsWith('0')) local = local.slice(1);

  return PHONE_REGEX.test(local) ? local : null;
}

function maskPhone(phone) {
  return `${PHONE_COUNTRY_CODE} ${'•'.repeat(6)}${phone.slice(-4)}`;
}

// The code is stored as a digest so a peek at Redis does not hand out live OTPs
function hashOtp(phone, code) {
  return crypto.createHmac('sha256', SESSION_SECRET).update(`${phone}:${code}`).digest('hex');
}

function otpKey(phone) {
  return `otp:register:${phone}`;
}

async function otpSave(phone, record) {
  const payload = JSON.stringify(record);

  if (redisState.connected) {
    try {
      await redisState.client.set(otpKey(phone), payload, 'EX', OTP_TTL_SECONDS);
      return;
    } catch (err) {
      console.warn('⚠️ Redis OTP write failed, falling back to memory:', err.message);
    }
  }

  otpMemory.set(phone, { record, expiresAt: Date.now() + OTP_TTL_SECONDS * 1000 });
}

async function otpLoad(phone) {
  if (redisState.connected) {
    try {
      const raw = await redisState.client.get(otpKey(phone));
      if (raw) return JSON.parse(raw);
    } catch (err) {
      console.warn('⚠️ Redis OTP read failed:', err.message);
    }
  }

  const entry = otpMemory.get(phone);
  if (!entry) return null;

  if (entry.expiresAt < Date.now()) {
    otpMemory.delete(phone);
    return null;
  }

  return entry.record;
}

async function otpClear(phone) {
  if (redisState.connected) {
    try {
      await redisState.client.del(otpKey(phone));
    } catch (err) {
      console.warn('⚠️ Redis OTP delete failed:', err.message);
    }
  }
  otpMemory.delete(phone);
}

// Sends the code through the WebEngage transactional campaign. Without an API

async function verifyOtp({ phone, email, code }) {
  const record = await otpLoad(phone);
  if (!record) return { error: 'That code has expired — request a new one' };

  if (record.email !== email) {
    return { error: 'This code was sent for a different email address' };
  }

  if (record.attempts >= OTP_MAX_ATTEMPTS) {
    await otpClear(phone);
    return { error: 'Too many incorrect attempts — request a new code' };
  }

  const given = Buffer.from(hashOtp(phone, code));
  const wanted = Buffer.from(record.codeHash);
  const matches = given.length === wanted.length && crypto.timingSafeEqual(given, wanted);

  if (!matches) {
    record.attempts += 1;
    await otpSave(phone, record);
    const left = OTP_MAX_ATTEMPTS - record.attempts;
    return {
      error: left > 0 ? `Incorrect code — ${left} attempt${left === 1 ? '' : 's'} left` : 'Too many incorrect attempts — request a new code',
    };
  }

  await otpClear(phone);
  return null;
}

module.exports = { normalizePhone, maskPhone, hashOtp, otpSave, otpLoad, otpClear, verifyOtp };

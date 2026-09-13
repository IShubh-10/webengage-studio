/**
 * Accounts: sign-up (with phone verification), sign-in, the session endpoint,
 * and the admin member directory.
 */

const crypto = require('crypto');
const express = require('express');

const router = express.Router();

const { ensureAuthSchema } = require('../db/schema');
const { requireAdmin } = require('../middleware/guards');
const { hashPassword, verifyPassword } = require('../services/passwords');
const {
  setSessionCookie,
  clearSessionCookie,
  revokeSession,
  revokeAllSessions,
  publicUser,
} = require('../services/sessions');
const {
  normalizePhone,
  maskPhone,
  hashOtp,
  otpLoad,
  otpSave,
  otpClear,
  verifyOtp,
} = require('../services/otp');
const { sendOtpMessage } = require('../services/webengage');
const {
  loadUserRow,
  countAdmins,
  countUsers,
  listUsers,
  findByEmail,
  findByPhone,
  insertUser,
  updateRole,
  deleteUser,
  touchLastLogin,
} = require('../repositories/userRepository');
const {
  ALLOWED_EMAIL_DOMAIN,
  EMAIL_REGEX,
  MIN_PASSWORD_LENGTH,
  PHONE_COUNTRY_CODE,
  OTP_LENGTH,
  OTP_TTL_SECONDS,
  OTP_RESEND_COOLDOWN_SECONDS,
  WEBENGAGE_API_KEY,
} = require('../config');

router.get('/api/v1/auth/status', async (req, res) => {
  try {
    await ensureAuthSchema();
    const total = await countUsers();
    res.json({
      success: true,
      hasUsers: total > 0,
      firstUserBecomesAdmin: total === 0,
      allowedEmailDomain: ALLOWED_EMAIL_DOMAIN || null,
      authenticated: Boolean(req.user),
      phoneVerification: {
        countryCode: PHONE_COUNTRY_CODE,
        digits: 10,
        otpLength: OTP_LENGTH,
        resendIn: OTP_RESEND_COOLDOWN_SECONDS,
        smsConfigured: Boolean(WEBENGAGE_API_KEY),
      },
    });
  } catch (err) {
    console.error('Error reading auth status:', err);
    res.status(500).json({ error: 'Failed to read auth status' });
  }
});

async function validateRegistration({ name, email, phone }) {
  if (name.length < 2) return { error: 'Please enter your full name' };
  if (!EMAIL_REGEX.test(email)) return { error: 'Please enter a valid email address' };
  if (!phone) return { error: 'Enter a 10 digit mobile number' };
  if (ALLOWED_EMAIL_DOMAIN && !email.endsWith(`@${ALLOWED_EMAIL_DOMAIN}`)) {
    return { error: `Only @${ALLOWED_EMAIL_DOMAIN} email addresses can register`, status: 403 };
  }

  const existingEmail = await findByEmail(email);
  if (existingEmail) {
    return { error: 'An account with this email already exists', status: 409 };
  }

  const existingPhone = await findByPhone(phone);
  if (existingPhone) {
    return { error: 'An account with this mobile number already exists', status: 409 };
  }

  return null;
}

router.post('/api/v1/auth/otp/send', async (req, res) => {
  try {
    await ensureAuthSchema();

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const phone = normalizePhone(req.body.phone);

    const problem = await validateRegistration({ name, email, phone });
    if (problem) return res.status(problem.status || 400).json({ error: problem.error });

    // Don't let the endpoint be used to spam one number
    const existing = await otpLoad(phone);
    if (existing) {
      const waited = Math.floor((Date.now() - existing.sentAt) / 1000);
      if (waited < OTP_RESEND_COOLDOWN_SECONDS) {
        return res.status(429).json({
          error: `Please wait ${OTP_RESEND_COOLDOWN_SECONDS - waited}s before requesting another code`,
          resendIn: OTP_RESEND_COOLDOWN_SECONDS - waited,
        });
      }
    }

    const code = String(crypto.randomInt(0, 10 ** OTP_LENGTH)).padStart(OTP_LENGTH, '0');

    await otpSave(phone, {
      codeHash: hashOtp(phone, code),
      email,
      name,
      attempts: 0,
      sentAt: Date.now(),
    });

    const delivery = await sendOtpMessage({ phone, name, code });

    res.json({
      success: true,
      phone: maskPhone(phone),
      expiresIn: OTP_TTL_SECONDS,
      resendIn: OTP_RESEND_COOLDOWN_SECONDS,
      delivered: delivery.delivered,
      // Surfaced so a misconfigured key is obvious instead of looking like a
      // silent failure. The code itself is never returned.
      note: delivery.delivered ? undefined : delivery.reason,
    });
  } catch (err) {
    console.error('Error sending OTP:', err);
    res.status(500).json({ error: 'Could not send the verification code' });
  }
});

router.post('/api/v1/auth/register', async (req, res) => {
  try {
    await ensureAuthSchema();

    const name = String(req.body.name || '').trim();
    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');
    const phone = normalizePhone(req.body.phone);
    const code = String(req.body.otp || '').trim();

    const problem = await validateRegistration({ name, email, phone });
    if (problem) return res.status(problem.status || 400).json({ error: problem.error });

    if (password.length < MIN_PASSWORD_LENGTH) {
      return res
        .status(400)
        .json({ error: `Password must be at least ${MIN_PASSWORD_LENGTH} characters` });
    }

    if (!new RegExp(`^\\d{${OTP_LENGTH}}$`).test(code)) {
      return res.status(400).json({ error: `Enter the ${OTP_LENGTH} digit code sent to your mobile` });
    }

    // The number has to be proven before the account exists
    const otpProblem = await verifyOtp({ phone, email, code });
    if (otpProblem) return res.status(400).json({ error: otpProblem.error });

    // The very first account owns the studio, everyone after joins as a member
    const role = (await countUsers()) === 0 ? 'admin' : 'member';

    const passwordHash = await hashPassword(password);

    let userId;
    try {
      userId = await insertUser({ name, email, passwordHash, phone, role });
    } catch (err) {
      if (err.code === 'ER_DUP_ENTRY') {
        return res.status(409).json({
          error: String(err.message).includes('uniq_users_phone')
            ? 'An account with this mobile number already exists'
            : 'An account with this email already exists',
        });
      }
      throw err;
    }

    const user = { id: userId, name, email, phone, role };
    setSessionCookie(res, user);

    res.status(201).json({ success: true, user: publicUser(user) });
  } catch (err) {
    console.error('Error registering user:', err);
    res.status(500).json({ error: 'Failed to create account' });
  }
});

router.post('/api/v1/auth/login', async (req, res) => {
  try {
    await ensureAuthSchema();

    const email = String(req.body.email || '').trim().toLowerCase();
    const password = String(req.body.password || '');

    if (!email || !password) {
      return res.status(400).json({ error: 'Email and password are required' });
    }

    const row = await findByEmail(email);

    // Same message either way so the endpoint does not reveal which emails exist
    const invalid = { error: 'Invalid email or password' };
    if (!row) return res.status(401).json(invalid);
    const ok = await verifyPassword(password, row.password_hash);
    if (!ok) return res.status(401).json(invalid);

    touchLastLogin(row.id);

    setSessionCookie(res, row);
    res.json({ success: true, user: publicUser(row) });
  } catch (err) {
    console.error('Error logging in:', err);
    res.status(500).json({ error: 'Failed to sign in' });
  }
});

/**
 * Signing out withdraws the token as well as clearing the cookie.
 *
 * Clearing the cookie only tells *this browser* to forget it. A copy that had
 * already leaked — into a proxy log, a shared machine, a HAR file — stayed
 * valid for the rest of its seven days, because nothing on the server had any
 * record of it. Now the token id goes on a deny-list until it would have
 * expired anyway.
 */
router.post('/api/v1/auth/logout', async (req, res) => {
  await revokeSession(req.user);
  clearSessionCookie(res);
  res.json({ success: true });
});

/** Signs the account out of every browser it is currently signed in on. */
router.post('/api/v1/auth/logout-all', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  await revokeAllSessions(req.user.uid);
  clearSessionCookie(res);
  res.json({ success: true, message: 'Signed out of all devices' });
});

router.get('/api/v1/auth/me', async (req, res) => {
  if (!req.user) return res.status(401).json({ error: 'Authentication required' });

  try {
    await ensureAuthSchema();
    const row = await loadUserRow(req.user.uid);

    // Account deleted while the cookie was still valid
    if (!row) {
      clearSessionCookie(res);
      return res.status(401).json({ error: 'Authentication required' });
    }

    return res.json({ success: true, user: publicUser(row) });
  } catch (err) {
    // If the lookup fails, fall back to the signed cookie rather than logging the user out
    console.warn('⚠️ Could not refresh user from database:', err.message);
    return res.json({ success: true, user: publicUser(req.user) });
  }
});

router.get('/api/v1/auth/users', requireAdmin, async (req, res) => {
  try {
    const rows = await listUsers();

    res.json({
      success: true,
      currentUserId: req.adminUser.id,
      counts: {
        total: rows.length,
        admins: rows.filter((row) => row.role === 'admin').length,
        members: rows.filter((row) => row.role === 'member').length,
      },
      users: rows,
    });
  } catch (err) {
    console.error('Error listing users:', err);
    res.status(500).json({ error: 'Failed to list members' });
  }
});

router.post('/api/v1/auth/users/:id/role', requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    const role = String(req.body.role || '').trim().toLowerCase();

    if (!targetId) return res.status(400).json({ error: 'Invalid member id' });
    if (role !== 'admin' && role !== 'member') {
      return res.status(400).json({ error: "Role must be either 'admin' or 'member'" });
    }
    if (targetId === req.adminUser.id) {
      return res.status(400).json({ error: 'You cannot change your own role' });
    }

    const target = await loadUserRow(targetId);
    if (!target) return res.status(404).json({ error: 'Member not found' });
    if (target.role === role) return res.json({ success: true, user: publicUser(target) });

    // Never leave the studio without an admin
    if (target.role === 'admin' && (await countAdmins()) <= 1) {
      return res.status(400).json({ error: 'At least one admin must remain' });
    }

    await updateRole(targetId, role);
    res.json({ success: true, user: { ...publicUser(target), role } });
  } catch (err) {
    console.error('Error updating member role:', err);
    res.status(500).json({ error: 'Failed to update role' });
  }
});

router.post('/api/v1/auth/users/:id/delete', requireAdmin, async (req, res) => {
  try {
    const targetId = parseInt(req.params.id, 10);
    if (!targetId) return res.status(400).json({ error: 'Invalid member id' });
    if (targetId === req.adminUser.id) {
      return res.status(400).json({ error: 'You cannot remove your own account' });
    }

    const target = await loadUserRow(targetId);
    if (!target) return res.status(404).json({ error: 'Member not found' });

    if (target.role === 'admin' && (await countAdmins()) <= 1) {
      return res.status(400).json({ error: 'At least one admin must remain' });
    }

    await deleteUser(targetId);

    // Their cookie decrypts fine and requireAuth only checks that a session
    // exists, so without this a removed member could keep saving templates and
    // timers until their token expired.
    await revokeAllSessions(targetId);

    res.json({ success: true, removed: publicUser(target) });
  } catch (err) {
    console.error('Error removing member:', err);
    res.status(500).json({ error: 'Failed to remove member' });
  }
});

module.exports = router;

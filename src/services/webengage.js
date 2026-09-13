/**
 * WebEngage transactional campaign client. Without an API key configured the
 * code is logged instead of sent, so local development still works.
 */

const {
  PHONE_COUNTRY_CODE,
  WEBENGAGE_API_KEY,
  WEBENGAGE_OTP_URL,
  WEBENGAGE_OTP_TTL,
  WEBENGAGE_OTP_USER_ID,
} = require('../config');

async function sendOtpMessage({ phone, name, code }) {
  const e164 = `${PHONE_COUNTRY_CODE}${phone}`;

  if (!WEBENGAGE_API_KEY) {
    console.warn(
      `⚠️ WEBENGAGE_API_KEY is not set — OTP for ${e164} not sent. Code for local testing: ${code}`
    );
    return { delivered: false, reason: 'WEBENGAGE_API_KEY is not configured' };
  }

  try {
    const response = await fetch(WEBENGAGE_OTP_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${WEBENGAGE_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        ttl: WEBENGAGE_OTP_TTL,
        overrideData: {
          context: {
            token: {
              name,
              otp: code,
            },
          },
          phone: e164,
        },
        userId: WEBENGAGE_OTP_USER_ID,
      }),
    });

    if (!response.ok) {
      const detail = await response.text().catch(() => '');
      console.error(`❌ WebEngage OTP send failed (${response.status}): ${detail.slice(0, 300)}`);
      return { delivered: false, reason: `WebEngage responded ${response.status}` };
    }

    return { delivered: true };
  } catch (err) {
    console.error('❌ WebEngage OTP send error:', err.message);
    return { delivered: false, reason: 'Could not reach WebEngage' };
  }
}

module.exports = { sendOtpMessage };

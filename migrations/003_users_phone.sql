-- ============================================================================
-- Webengage Creative Studio — verified mobile number on accounts
-- ----------------------------------------------------------------------------
-- Registration now takes a 10 digit Indian mobile number and proves it with a
-- 4 digit OTP sent through the WebEngage transactional campaign before the
-- account row is written. Only the bare 10 digits are stored; the country code
-- (+91) is added when the SMS goes out.
--
-- The server applies this on boot (ensureAuthSchema() in server.js), so this
-- file is for review and for applying by hand:
--
--   mysql -u root -p personalize_studio < sql/003_users_phone.sql
--
-- UNIQUE allows many NULLs in MySQL, so accounts created before phone
-- verification existed keep working with phone = NULL.
-- ============================================================================

ALTER TABLE users ADD COLUMN phone VARCHAR(10) NULL DEFAULT NULL AFTER password_hash;
ALTER TABLE users ADD UNIQUE KEY uniq_users_phone (phone);

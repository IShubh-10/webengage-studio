-- ============================================================================
-- Webengage Creative Studio — accounts table
-- ----------------------------------------------------------------------------
-- The server also creates this table automatically on boot (ensureAuthSchema()
-- in server.js), so this file exists to keep the schema reviewable and to let
-- you apply it by hand:
--
--   mysql -u root -p personalize_studio < sql/001_users.sql
--
-- Roles: the first account to register becomes 'admin'; everyone after joins
-- as 'member'. Promote someone later from the /admin page, or with:
--
--   UPDATE users SET role = 'admin' WHERE email = 'someone@webengage.com';
-- ============================================================================

CREATE TABLE IF NOT EXISTS users (
  id            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  name          VARCHAR(120) NOT NULL,
  email         VARCHAR(190) NOT NULL,
  -- scrypt digest, stored as: scrypt$N$r$p$salt_hex$hash_hex (never plain text)
  password_hash VARCHAR(255) NOT NULL,
  role          ENUM('admin', 'member') NOT NULL DEFAULT 'member',
  created_at    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_login_at TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uniq_users_email (email)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

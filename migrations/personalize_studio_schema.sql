-- MySQL dump — schema only
--
-- Webengage Creative Studio — full database schema (`personalize_studio`)
-- ----------------------------------------------------------------------------
-- Structure only, no rows. This is the same schema the server guarantees on
-- boot (src/db/schema.js), collected into one file you can import in MySQL
-- Workbench: Server ▸ Data Import ▸ Import from Self-Contained File, or
--
--   mysql -u root -p < migrations/personalize_studio_schema.sql
--
-- Requires MySQL 5.7.8+ for the JSON columns (8.0 recommended).
--
-- Every CREATE is `IF NOT EXISTS`, so running this against a database that is
-- already set up is a no-op rather than a data loss. A strict mysqldump would
-- put `DROP TABLE IF EXISTS <name>;` before each CREATE — add those only if you
-- deliberately want to rebuild the tables empty.
--
-- Server version: 8.0
-- ============================================================================

-- Session settings for the import. A real mysqldump saves the old values into
-- @OLD_* user variables and restores them at the end; that is left out here on
-- purpose, because those variables are session-scoped and running only part of
-- the file (selecting a few statements in the Workbench SQL editor, say) then
-- fails with "Variable 'sql_mode' can't be set to the value of 'NULL'". These
-- three settings affect nothing beyond the connection doing the import.

SET NAMES utf8mb4;
SET SESSION sql_mode = 'NO_AUTO_VALUE_ON_ZERO';
SET SESSION foreign_key_checks = 0;

--
-- Database: `personalize_studio`
-- Override the name here (and in DB_NAME in .env) if you host it elsewhere.
--

CREATE DATABASE IF NOT EXISTS `personalize_studio`
  DEFAULT CHARACTER SET utf8mb4;
USE `personalize_studio`;

-- ----------------------------------------------------------------------------
-- Table `users` — accounts (migrations/001_users.sql, 003_users_phone.sql)
--
-- The first account to register becomes 'admin'; everyone after joins as
-- 'member'. Promote someone later from the /admin page, or with:
--   UPDATE users SET role = 'admin' WHERE email = 'someone@webengage.com';
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `users` (
  `id`            INT UNSIGNED NOT NULL AUTO_INCREMENT,
  `name`          VARCHAR(120) NOT NULL,
  `email`         VARCHAR(190) NOT NULL,
  -- scrypt digest, stored as: scrypt$N$r$p$salt_hex$hash_hex (never plain text)
  `password_hash` VARCHAR(255) NOT NULL,
  -- 10 digits, no country code; NULL until the account adds one
  `phone`         VARCHAR(10) NULL DEFAULT NULL,
  `role`          ENUM('admin','member') NOT NULL DEFAULT 'member',
  `created_at`    TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `last_login_at` TIMESTAMP NULL DEFAULT NULL,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uniq_users_email` (`email`),
  -- UNIQUE over a nullable column still allows many NULLs in MySQL, which is
  -- what lets accounts without a phone number coexist.
  UNIQUE KEY `uniq_users_phone` (`phone`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Table `templates` — creatives (migrations/002_templates_single_table.sql)
--
-- One row per template. `elements` is the layer list in draw order, stored in
-- exactly the shape the builder edits and the renderer reads, so nothing has to
-- be mapped on either side:
--
--   [ { "type": "text",  "x": 120, "y": 240, "text": "{{first_name}}",
--       "fontSize": 42, "fontWeight": "bold", "fontFamily": "Arial",
--       "color": "#ffffff" },
--     { "type": "image", "x": 0, "y": 0, "src": "https://…",
--       "width": 600, "height": 200 } ]
--
-- NULL is only possible on a row written before the column existed; the server
-- backfills those from the retired `template_elements` child table on boot.
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `templates` (
  `template_id`    VARCHAR(100) NOT NULL,
  `background_url` TEXT NOT NULL,
  `elements`       JSON NULL,
  `created_at`     TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at`     TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`template_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Table `timers` — countdown timers (migrations/004_timers.sql)
--
-- A saved timer is a creative plus the styling of the clock drawn on it. The
-- creative is either a studio template (`source.templateId`) or a plain image
-- URL, and the whole definition lives in `config`:
--
--   { "source":   { "templateId": "WEB-04", "backgroundUrl": "" },
--     "endAt":    "2026-12-31 23:59:59",
--     "timezone": "Asia/Kolkata",
--     "evergreenSeconds": 0, "canvasWidth": 600, "background": "#ffffff",
--     "colors": 256, "frames": 60,
--     "style":   { … }, "expired": { … } }
--
-- The deadline is stored as written rather than as a UTC instant, because it is
-- meaningful together with `timezone` ("midnight, wherever the sale is running").
--
-- `created_by` points at users.id but carries no foreign key on purpose: a timer
-- outlives the account that made it, and deleting a user must not cascade into
-- live campaign assets. Add the constraint below only if you want the opposite.
--   ALTER TABLE `timers` ADD CONSTRAINT `fk_timers_created_by`
--     FOREIGN KEY (`created_by`) REFERENCES `users` (`id`) ON DELETE SET NULL;
-- ----------------------------------------------------------------------------

CREATE TABLE IF NOT EXISTS `timers` (
  `timer_id`   VARCHAR(100) NOT NULL,
  `name`       VARCHAR(190) NOT NULL,
  `config`     JSON NOT NULL,
  `created_by` INT UNSIGNED NULL DEFAULT NULL,
  `created_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (`timer_id`),
  KEY `idx_timers_created_at` (`created_at`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ----------------------------------------------------------------------------
-- Retired: `template_elements`
--
-- Templates used to keep one row per layer in a child table. That table is
-- dropped by migrations/002_templates_single_table.sql after its rows are
-- folded into `templates.elements`, so a fresh database never creates it.
-- ----------------------------------------------------------------------------

SET SESSION foreign_key_checks = 1;

-- Dump completed

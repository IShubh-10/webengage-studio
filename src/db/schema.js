/**
 * Schema the server guarantees on boot: the accounts table, the templates table
 * with its JSON elements column, and the countdown timers table. All of them are
 * idempotent, so a fresh clone or another environment upgrades itself on start.
 *
 * The matching SQL lives in migrations/ for review and manual runs.
 */

const db = require('../config/db');

let authSchemaReady = false;
let templateSchemaReady = false;
let timerSchemaReady = false;

async function ensureAuthSchema() {
  if (authSchemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS users (
      id INT UNSIGNED NOT NULL AUTO_INCREMENT,
      name VARCHAR(120) NOT NULL,
      email VARCHAR(190) NOT NULL,
      password_hash VARCHAR(255) NOT NULL,
      phone VARCHAR(10) NULL DEFAULT NULL,
      role ENUM('admin', 'member') NOT NULL DEFAULT 'member',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      last_login_at TIMESTAMP NULL DEFAULT NULL,
      PRIMARY KEY (id),
      UNIQUE KEY uniq_users_email (email),
      UNIQUE KEY uniq_users_phone (phone)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Databases created before phone verification existed
  const [phoneColumn] = await db.query("SHOW COLUMNS FROM users LIKE 'phone'");
  if (phoneColumn.length === 0) {
    await db.query('ALTER TABLE users ADD COLUMN phone VARCHAR(10) NULL DEFAULT NULL AFTER password_hash');
    await db.query('ALTER TABLE users ADD UNIQUE KEY uniq_users_phone (phone)');
    console.log('🔧 Added users.phone column');
  }

  authSchemaReady = true;
}

// --- Password hashing (scrypt from node:crypto — no extra dependency) --------

async function ensureTemplateSchema() {
  if (templateSchemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS templates (
      template_id    VARCHAR(100) NOT NULL,
      background_url TEXT NOT NULL,
      elements       JSON NULL,
      created_at     TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at     TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (template_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  // Older databases have the table without the JSON column
  const [columns] = await db.query("SHOW COLUMNS FROM templates LIKE 'elements'");
  if (columns.length === 0) {
    await db.query('ALTER TABLE templates ADD COLUMN elements JSON NULL AFTER background_url');
    console.log('🔧 Added templates.elements JSON column');
  }

  /*
   * Who made it, so the same owner-or-admin rule that governs timers can
   * govern templates. Nullable, and deliberately not backfilled: rows written
   * before this column existed have no recoverable author, and inventing one
   * would hand somebody edit rights nobody granted. `canManage` treats a null
   * owner as admin-only — see src/middleware/guards.js.
   */
  const [ownerColumn] = await db.query("SHOW COLUMNS FROM templates LIKE 'created_by'");
  if (ownerColumn.length === 0) {
    await db.query('ALTER TABLE templates ADD COLUMN created_by INT UNSIGNED NULL DEFAULT NULL');
    console.log('🔧 Added templates.created_by column');
  }

  await backfillElementsFromLegacyTable();
  templateSchemaReady = true;
}

// Copies any rows still living in the old template_elements table into the JSON
// column. Idempotent: it only touches templates whose elements are still NULL,
// and it never drops the legacy table (see scripts/migrate-templates-to-json.js).
async function backfillElementsFromLegacyTable() {
  const [legacy] = await db.query("SHOW TABLES LIKE 'template_elements'");
  if (legacy.length === 0) return;

  const [pending] = await db.query('SELECT template_id FROM templates WHERE elements IS NULL');
  if (pending.length === 0) return;

  const [rows] = await db.query(
    'SELECT * FROM template_elements ORDER BY template_id ASC, layer_order ASC'
  );

  const grouped = new Map();
  rows.forEach((row) => {
    if (!grouped.has(row.template_id)) grouped.set(row.template_id, []);
    grouped.get(row.template_id).push(elementFromLegacyRow(row));
  });

  for (const { template_id: templateId } of pending) {
    const elements = grouped.get(templateId) || [];
    await db.query('UPDATE templates SET elements = ? WHERE template_id = ?', [
      JSON.stringify(elements),
      templateId,
    ]);
  }

  console.log(`🔧 Backfilled elements JSON for ${pending.length} template(s) from template_elements`);
}

function elementFromLegacyRow(row) {
  return {
    type: row.element_type,
    x: row.pos_x,
    y: row.pos_y,
    text: row.text_content,
    fontSize: row.font_size,
    fontWeight: row.font_weight,
    fontFamily: row.font_family,
    color: row.color,
    src: row.image_src,
    width: row.width,
    height: row.height,
  };
}

/**
 * Countdown timers. Like templates, the whole definition lives in one JSON
 * column in exactly the shape the builder edits and the GIF renderer reads.
 */
async function ensureTimerSchema() {
  if (timerSchemaReady) return;

  await db.query(`
    CREATE TABLE IF NOT EXISTS timers (
      timer_id   VARCHAR(100) NOT NULL,
      name       VARCHAR(190) NOT NULL,
      config     JSON NOT NULL,
      created_by INT UNSIGNED NULL DEFAULT NULL,
      created_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP,
      updated_at TIMESTAMP NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
      PRIMARY KEY (timer_id),
      KEY idx_timers_created_at (created_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4
  `);

  timerSchemaReady = true;
}

module.exports = { ensureAuthSchema, ensureTemplateSchema, ensureTimerSchema };

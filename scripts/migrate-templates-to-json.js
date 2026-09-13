/**
 * Moves template layers out of the `template_elements` table and into the
 * `templates.elements` JSON column, then verifies every template before the old
 * table is parked out of the way.
 *
 *   node scripts/migrate-templates-to-json.js            # backfill + verify
 *   node scripts/migrate-templates-to-json.js --retire   # also drop the old table
 *   node scripts/migrate-templates-to-json.js --force    # rewrite elements that already exist
 *
 * Safe to run more than once: without --force it only fills templates whose
 * elements column is still NULL, and it drops nothing unless you ask.
 *
 * --retire leaves the database with a single templates table. The old rows are
 * written to backups/ as JSON first, so the copy lives as a file instead of as
 * a leftover table in the schema.
 */

const fs = require('fs');
const path = require('path');

// Same .env the server reads, so DB_* and friends apply here as well
require('../src/config/env');
const mysql = require('mysql2/promise');

const RETIRE = process.argv.includes('--retire');
const FORCE = process.argv.includes('--force');
const LEGACY_TABLE = 'template_elements';
const BACKUP_DIR = path.join(__dirname, '..', 'backups');

function elementFromRow(row) {
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

async function tableExists(db, name) {
  const [rows] = await db.query('SHOW TABLES LIKE ?', [name]);
  return rows.length > 0;
}

(async () => {
  const db = await mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'qwer1234',
    database: process.env.DB_NAME || 'personalize_studio',
  });

  console.log(`→ database: ${db.config.database}`);

  // 1. Make sure the JSON column is there
  const [columns] = await db.query("SHOW COLUMNS FROM templates LIKE 'elements'");
  if (columns.length === 0) {
    await db.query('ALTER TABLE templates ADD COLUMN elements JSON NULL AFTER background_url');
    console.log('✓ added templates.elements JSON column');
  } else {
    console.log('· templates.elements already exists');
  }

  const hasLegacy = await tableExists(db, LEGACY_TABLE);
  if (!hasLegacy) {
    console.log(`· ${LEGACY_TABLE} is already gone — nothing to migrate`);
    await db.end();
    return;
  }

  // 2. Backfill
  const [legacyRows] = await db.query(
    `SELECT * FROM ${LEGACY_TABLE} ORDER BY template_id ASC, layer_order ASC`
  );

  const grouped = new Map();
  legacyRows.forEach((row) => {
    if (!grouped.has(row.template_id)) grouped.set(row.template_id, []);
    grouped.get(row.template_id).push(elementFromRow(row));
  });

  const [targets] = await db.query(
    FORCE
      ? 'SELECT template_id FROM templates'
      : 'SELECT template_id FROM templates WHERE elements IS NULL'
  );

  for (const { template_id: templateId } of targets) {
    const elements = grouped.get(templateId) || [];
    await db.query('UPDATE templates SET elements = ? WHERE template_id = ?', [
      JSON.stringify(elements),
      templateId,
    ]);
    console.log(`✓ ${templateId}: ${elements.length} layer(s) written to JSON`);
  }

  if (targets.length === 0) console.log('· every template already has its elements JSON');

  // 3. Verify: JSON layer counts must match the legacy row counts exactly
  const [check] = await db.query(`
    SELECT t.template_id,
           COALESCE(JSON_LENGTH(t.elements), -1) AS json_layers,
           (SELECT COUNT(*) FROM ${LEGACY_TABLE} e WHERE e.template_id = t.template_id) AS legacy_layers
    FROM templates t
    ORDER BY t.template_id
  `);

  const mismatches = check.filter((row) => row.json_layers !== row.legacy_layers);
  check.forEach((row) => {
    const mark = row.json_layers === row.legacy_layers ? '✓' : '✗';
    console.log(`${mark} ${row.template_id}: json=${row.json_layers} legacy=${row.legacy_layers}`);
  });

  const [orphans] = await db.query(
    `SELECT DISTINCT e.template_id FROM ${LEGACY_TABLE} e
      LEFT JOIN templates t ON t.template_id = e.template_id
      WHERE t.template_id IS NULL`
  );
  orphans.forEach((row) => console.log(`! ${row.template_id}: elements with no template row`));

  if (mismatches.length > 0) {
    console.error(`\n✗ ${mismatches.length} template(s) do not match — nothing was retired.`);
    await db.end();
    process.exit(1);
  }

  console.log(`\n✓ all ${check.length} template(s) verified`);

  // 4. Optionally retire the old table: back it up to a file, then drop it, so
  //    the database is left holding one table
  if (RETIRE) {
    const [createRow] = await db.query(`SHOW CREATE TABLE ${LEGACY_TABLE}`);

    fs.mkdirSync(BACKUP_DIR, { recursive: true });
    const file = path.join(BACKUP_DIR, `${LEGACY_TABLE}-${new Date().toISOString().slice(0, 10)}.json`);
    fs.writeFileSync(
      file,
      JSON.stringify(
        {
          exported_at: new Date().toISOString(),
          note: `Pre-JSON-migration copy of ${LEGACY_TABLE}. The live data now lives in templates.elements.`,
          create_table: createRow[0]['Create Table'],
          rows: legacyRows,
        },
        null,
        2
      )
    );
    console.log(`✓ ${legacyRows.length} legacy row(s) backed up to ${path.relative(process.cwd(), file)}`);

    await db.query(`DROP TABLE ${LEGACY_TABLE}`);
    console.log(`✓ dropped ${LEGACY_TABLE} — templates is now the only template table`);
  } else {
    console.log(`· ${LEGACY_TABLE} left untouched — re-run with --retire to back it up and drop it`);
  }

  await db.end();
})().catch((err) => {
  console.error('✗ migration failed:', err.message);
  process.exit(1);
});

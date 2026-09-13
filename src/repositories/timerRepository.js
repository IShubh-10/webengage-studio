/**
 * Countdown timer reads and writes. The whole definition lives in the
 * timers.config JSON column in the shape the builder edits and the renderer
 * reads, so there is no column mapping on either side — the same arrangement
 * templates.elements uses.
 */

const db = require('../config/db');

const { normalizeTimer } = require('../services/countdown/config');

function parseConfig(value) {
  if (!value) return normalizeTimer({});
  if (typeof value === 'object') return normalizeTimer(value);

  try {
    return normalizeTimer(JSON.parse(value));
  } catch (err) {
    console.warn('⚠️ Could not parse timer config JSON:', err.message);
    return normalizeTimer({});
  }
}

async function nextTimerId() {
  const [rows] = await db.query(
    "SELECT timer_id FROM timers WHERE timer_id REGEXP '^TMR-[0-9]+$' ORDER BY CAST(SUBSTRING(timer_id, 5) AS UNSIGNED) DESC LIMIT 1"
  );

  if (rows.length === 0) return 'TMR-01';

  const number = parseInt(rows[0].timer_id.replace('TMR-', ''), 10) + 1;
  return `TMR-${String(number).padStart(2, '0')}`;
}

async function listTimers() {
  const [rows] = await db.query(
    'SELECT timer_id, name, config, created_at, updated_at FROM timers ORDER BY created_at DESC'
  );

  return rows.map((row) => ({
    timer_id: row.timer_id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    config: parseConfig(row.config),
  }));
}

async function findTimer(timerId) {
  const [rows] = await db.query('SELECT timer_id, name, config FROM timers WHERE timer_id = ?', [
    timerId,
  ]);

  if (rows.length === 0) return null;

  return {
    timer_id: rows[0].timer_id,
    name: rows[0].name,
    config: parseConfig(rows[0].config),
  };
}

async function saveTimer({ timerId, name, config, createdBy = null }) {
  await db.query(
    `INSERT INTO timers (timer_id, name, config, created_by)
       VALUES (?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         name = VALUES(name),
         config = VALUES(config)`,
    [timerId, name, JSON.stringify(normalizeTimer(config)), createdBy]
  );
}

async function deleteTimer(timerId) {
  const [result] = await db.query('DELETE FROM timers WHERE timer_id = ?', [timerId]);
  return result.affectedRows > 0;
}

module.exports = { parseConfig, nextTimerId, listTimers, findTimer, saveTimer, deleteTimer };

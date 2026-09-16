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

/*
 * The creator comes back with every row because the library needs it twice:
 * to say whose timer this is, and to decide whether this viewer may change it.
 * LEFT JOIN rather than an inner one — a timer outlives the account that made
 * it, and a deleted colleague must not make their timers disappear from
 * everyone else's library.
 */
async function listTimers() {
  const [rows] = await db.query(
    `SELECT t.timer_id, t.name, t.config, t.created_at, t.updated_at, t.created_by,
            u.name AS created_by_name
       FROM timers t
       LEFT JOIN users u ON u.id = t.created_by
      ORDER BY t.created_at DESC`
  );

  return rows.map((row) => ({
    timer_id: row.timer_id,
    name: row.name,
    created_at: row.created_at,
    updated_at: row.updated_at,
    created_by: row.created_by,
    created_by_name: row.created_by_name,
    config: parseConfig(row.config),
  }));
}

/**
 * Who owns a timer, for the permission check before a write.
 *
 * Returns `null` when there is no such row, so a caller can tell "you may not
 * touch this" apart from "this does not exist" and answer 403 or 404
 * accordingly. `createdBy` is null for rows written before ownership was
 * recorded.
 */
async function timerOwner(timerId) {
  const [rows] = await db.query('SELECT created_by FROM timers WHERE timer_id = ?', [timerId]);
  if (rows.length === 0) return null;
  return { createdBy: rows[0].created_by };
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

module.exports = {
  parseConfig,
  nextTimerId,
  listTimers,
  findTimer,
  timerOwner,
  saveTimer,
  deleteTimer,
};

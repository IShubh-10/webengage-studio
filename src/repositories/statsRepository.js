/**
 * Every query behind the open-stats page, and the one write that feeds it.
 *
 * Two conventions hold throughout this file:
 *
 *   1. Instants are UTC strings, never Date objects. The pool has no `timezone`
 *      set, so mysql2 would otherwise round-trip a DATETIME through the
 *      *process's* local zone — see lib/utcTime.js.
 *
 *   2. The reader's calendar is applied here, not in the browser. "This month"
 *      means the month where the person looking at the page lives, so every
 *      grouping query shifts the stored UTC bucket by the offset their browser
 *      sent and groups on the result. One stored row therefore serves a reader
 *      in any timezone, and nothing has to be re-counted per region.
 */

const db = require('../config/db');

// How a bucket is grouped, per unit of the series. The expression is
// interpolated rather than bound, so it is picked from this table and never
// from anything a caller sent.
const GROUP_FORMATS = {
  hour: '%Y-%m-%d %H:00:00',
  day: '%Y-%m-%d',
  month: '%Y-%m',
};

/*
 * `bucket_hour` is a UTC hour, and a reader in a half-hour zone (IST is +5:30)
 * has day boundaries that fall inside one. The whole bucket is attributed to
 * the local day its *start* falls in, which is the same rule the range filter
 * uses, so a day's total and the sum of its hours always agree. At most half an
 * hour of opens lands on the neighbouring day in those zones; nothing is lost
 * or double-counted.
 */
function localBucket(offsetMinutes) {
  return `DATE_ADD(bucket_hour, INTERVAL ${Number(offsetMinutes) || 0} MINUTE)`;
}

/**
 * Add a batch of counted opens to the hourly buckets.
 *
 * One statement for the whole batch: this runs on a timer behind the render
 * endpoints, and a send worth counting is many creatives at once. `opens`
 * accumulates and `last_open_at` moves forward only — GREATEST rather than
 * VALUES() because two workers flush the same bucket and the later write is
 * not necessarily the later open.
 */
async function recordOpenBuckets(buckets) {
  if (!buckets.length) return;

  const values = buckets.map((bucket) => [
    bucket.assetType,
    bucket.assetId,
    bucket.bucketHour,
    bucket.opens,
    bucket.lastOpenAt,
  ]);

  await db.query(
    `INSERT INTO asset_opens (asset_type, asset_id, bucket_hour, opens, last_open_at)
       VALUES ?
       ON DUPLICATE KEY UPDATE
         opens = opens + VALUES(opens),
         last_open_at = GREATEST(last_open_at, VALUES(last_open_at))`,
    [values]
  );
}

/** Opens per creative for one window, busiest first. */
async function totalsByAsset({ from, to }) {
  const [rows] = await db.query(
    `SELECT asset_type,
            asset_id,
            SUM(opens) AS opens,
            DATE_FORMAT(MAX(last_open_at), '%Y-%m-%d %H:%i:%s') AS last_open_at,
            DATE_FORMAT(MIN(bucket_hour), '%Y-%m-%d %H:%i:%s') AS first_bucket
       FROM asset_opens
      WHERE bucket_hour >= ? AND bucket_hour < ?
      GROUP BY asset_type, asset_id
      ORDER BY opens DESC`,
    [from, to]
  );

  return rows.map((row) => ({
    assetType: row.asset_type,
    assetId: row.asset_id,
    opens: Number(row.opens) || 0,
    lastOpenAt: row.last_open_at,
    firstBucket: row.first_bucket,
  }));
}

/**
 * One number for a window — the whole studio, one type, or one creative.
 *
 * Used for the headline figure and, run a second time over the window before
 * it, for the change against the previous period.
 */
async function totalOpens({ from, to, assetType = null, assetId = null }) {
  const filters = ['bucket_hour >= ?', 'bucket_hour < ?'];
  const params = [from, to];

  if (assetType) {
    filters.push('asset_type = ?');
    params.push(assetType);
  }
  if (assetId) {
    filters.push('asset_id = ?');
    params.push(assetId);
  }

  const [rows] = await db.query(
    `SELECT COALESCE(SUM(opens), 0) AS opens FROM asset_opens WHERE ${filters.join(' AND ')}`,
    params
  );

  // An aggregate with no GROUP BY always answers with one row, but a missing
  // one must read as "nothing counted" rather than throw on a page whose whole
  // job is to be looked at.
  return rows.length ? Number(rows[0].opens) || 0 : 0;
}

/**
 * The shape of a window over time: opens per hour, per day or per month in the
 * reader's own calendar.
 *
 * Only buckets that actually have opens come back — the quiet stretches are
 * filled in by the caller, which knows the window's boundaries and does not
 * need the database to send a row of zero for every empty hour of a year.
 */
async function openSeries({ from, to, unit, offsetMinutes, assetType = null, assetId = null }) {
  const format = GROUP_FORMATS[unit] || GROUP_FORMATS.day;

  const filters = ['bucket_hour >= ?', 'bucket_hour < ?'];
  const params = [from, to];

  if (assetType) {
    filters.push('asset_type = ?');
    params.push(assetType);
  }
  if (assetId) {
    filters.push('asset_id = ?');
    params.push(assetId);
  }

  const [rows] = await db.query(
    `SELECT DATE_FORMAT(${localBucket(offsetMinutes)}, '${format}') AS bucket,
            SUM(opens) AS opens
       FROM asset_opens
      WHERE ${filters.join(' AND ')}
      GROUP BY bucket
      ORDER BY bucket ASC`,
    params
  );

  return rows.map((row) => ({ bucket: row.bucket, opens: Number(row.opens) || 0 }));
}

/**
 * Which hours of the day a creative is opened in, summed across the window.
 *
 * The answer a campaign actually acts on — a send time — and the one thing the
 * plain series cannot show once the window is longer than a couple of days.
 */
async function openByHourOfDay({ from, to, offsetMinutes, assetType = null, assetId = null }) {
  const filters = ['bucket_hour >= ?', 'bucket_hour < ?'];
  const params = [from, to];

  if (assetType) {
    filters.push('asset_type = ?');
    params.push(assetType);
  }
  if (assetId) {
    filters.push('asset_id = ?');
    params.push(assetId);
  }

  const [rows] = await db.query(
    `SELECT HOUR(${localBucket(offsetMinutes)}) AS hour_of_day, SUM(opens) AS opens
       FROM asset_opens
      WHERE ${filters.join(' AND ')}
      GROUP BY hour_of_day
      ORDER BY hour_of_day ASC`,
    params
  );

  const hours = new Array(24).fill(0);
  rows.forEach((row) => {
    hours[Number(row.hour_of_day)] = Number(row.opens) || 0;
  });

  return hours;
}

/**
 * Everything ever counted for one creative, whatever window is on screen.
 * Shown beside the windowed figure so a quiet month cannot be mistaken for a
 * creative nobody has ever opened.
 */
async function assetLifetime({ assetType, assetId }) {
  const [rows] = await db.query(
    `SELECT COALESCE(SUM(opens), 0) AS opens,
            DATE_FORMAT(MIN(bucket_hour), '%Y-%m-%d %H:%i:%s') AS first_bucket,
            DATE_FORMAT(MAX(last_open_at), '%Y-%m-%d %H:%i:%s') AS last_open_at
       FROM asset_opens
      WHERE asset_type = ? AND asset_id = ?`,
    [assetType, assetId]
  );

  if (!rows.length) return { opens: 0, firstBucket: null, lastOpenAt: null };

  return {
    opens: Number(rows[0].opens) || 0,
    firstBucket: rows[0].first_bucket,
    lastOpenAt: rows[0].last_open_at,
  };
}

/** Lifetime totals for every creative, for the library badges. */
async function lifetimeTotals() {
  const [rows] = await db.query(
    `SELECT asset_type,
            asset_id,
            SUM(opens) AS opens,
            DATE_FORMAT(MAX(last_open_at), '%Y-%m-%d %H:%i:%s') AS last_open_at
       FROM asset_opens
      GROUP BY asset_type, asset_id`
  );

  return rows.map((row) => ({
    assetType: row.asset_type,
    assetId: row.asset_id,
    opens: Number(row.opens) || 0,
    lastOpenAt: row.last_open_at,
  }));
}

/** Drops everything counted for a creative, for when the creative is deleted. */
async function deleteAssetOpens(assetType, assetId) {
  await db.query('DELETE FROM asset_opens WHERE asset_type = ? AND asset_id = ?', [
    assetType,
    assetId,
  ]);
}

module.exports = {
  recordOpenBuckets,
  totalsByAsset,
  totalOpens,
  openSeries,
  openByHourOfDay,
  assetLifetime,
  lifetimeTotals,
  deleteAssetOpens,
};

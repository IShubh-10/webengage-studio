/**
 * UTC timestamps as MySQL strings.
 *
 * The pool does not set a `timezone`, so mysql2 serialises a JS Date using the
 * *process's* local zone and reads a DATETIME back the same way. That is
 * consistent on one machine and wrong the moment a deployment's TZ differs
 * from a developer's — the same row would mean two different instants.
 *
 * So nothing on the stats path ever hands the driver a Date. Instants go in as
 * explicit UTC strings and come back out through DATE_FORMAT as strings, and
 * the only place a timezone is applied is the query that groups by the
 * reader's own day, from the offset their browser sent.
 */

function pad(value, width = 2) {
  return String(value).padStart(width, '0');
}

/** `2026-09-19 14:32:07` — the instant, in UTC, as MySQL wants it written. */
function toMysqlUtc(date) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:${pad(date.getUTCMinutes())}:${pad(date.getUTCSeconds())}`
  );
}

/** The same instant truncated to the hour it falls in: `2026-09-19 14:00:00`. */
function toMysqlUtcHour(date) {
  return (
    `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())} ` +
    `${pad(date.getUTCHours())}:00:00`
  );
}

/**
 * A MySQL UTC string back to an ISO instant the browser can parse.
 * `2026-09-19 14:00:00` → `2026-09-19T14:00:00Z`. Returns null for null, so a
 * row with no timestamp stays absent rather than becoming the epoch.
 */
function mysqlUtcToIso(value) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  return `${String(value).replace(' ', 'T')}Z`;
}

module.exports = { toMysqlUtc, toMysqlUtcHour, mysqlUtcToIso };

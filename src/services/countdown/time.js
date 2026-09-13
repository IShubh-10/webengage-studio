/**
 * Working out how much time is left, at the moment the email is opened.
 *
 * There is no clock in an email, so everything here is anchored to the server's
 * `Date.now()` at request time. The only recipient-specific input available is
 * whatever the sender merged into the URL — which is why a timezone can be
 * passed per recipient (`tz={{user.timezone}}`) and why evergreen timers key
 * off an explicit `uid` rather than anything about the connection: Gmail's image
 * proxy fetches the image, so the IP and user agent belong to Google, not to
 * the person reading.
 */

const OFFSET_PATTERN = /^([+-])(\d{1,2}):?(\d{2})?$/;

/** True if the runtime recognises this IANA zone name. */
function isValidTimeZone(timeZone) {
  if (!timeZone) return false;
  try {
    new Intl.DateTimeFormat('en-US', { timeZone }).format(new Date());
    return true;
  } catch (err) {
    return false;
  }
}

/**
 * The UTC offset a zone was actually running at a given instant, in
 * milliseconds. Reading it back out of Intl is the only way to get this right
 * across daylight-saving changes without shipping a timezone database.
 */
function zoneOffsetMs(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  })
    .formatToParts(instant)
    .reduce((acc, part) => {
      acc[part.type] = part.value;
      return acc;
    }, {});

  const asIfUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour) % 24,
    Number(parts.minute),
    Number(parts.second)
  );

  return asIfUtc - instant.getTime();
}

/**
 * Turns a wall-clock reading with no offset ("2026-12-31 23:59:59") into a real
 * instant, as if that clock were hanging on a wall in `timeZone`.
 *
 * Two passes: the first guesses the offset from the naive value, the second
 * corrects it if that guess landed on the wrong side of a DST transition.
 */
function fromZonedNaive(naiveUtcMs, timeZone) {
  let instant = naiveUtcMs - zoneOffsetMs(new Date(naiveUtcMs), timeZone);
  instant = naiveUtcMs - zoneOffsetMs(new Date(instant), timeZone);
  return instant;
}

/** A fixed offset written as "+05:30" / "-0800" / "330" (minutes), in minutes. */
function parseFixedOffsetMinutes(value) {
  const raw = String(value).trim();

  const match = raw.match(OFFSET_PATTERN);
  if (match) {
    const sign = match[1] === '-' ? -1 : 1;
    return sign * (Number(match[2]) * 60 + Number(match[3] || 0));
  }

  if (/^-?\d{1,4}$/.test(raw)) return Number(raw);

  return null;
}

/**
 * Resolves the deadline to a UTC millisecond timestamp.
 *
 * Accepts, in order of how unambiguous they are:
 *   - epoch seconds or milliseconds  ("1770000000")
 *   - an ISO string carrying its own offset  ("2026-12-31T23:59:59+05:30")
 *   - a wall-clock string plus `timeZone`  ("2026-12-31 23:59:59", "Asia/Kolkata")
 *
 * Returns null when the value cannot be read as a date at all.
 */
function resolveDeadline(value, timeZone) {
  if (value === undefined || value === null || value === '') return null;

  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.getTime();

  const raw = String(value).trim();

  if (/^\d{13,}$/.test(raw)) return Number(raw);
  if (/^\d{9,12}$/.test(raw)) return Number(raw) * 1000;

  // An explicit offset (or a trailing Z) already pins the instant down.
  if (/[zZ]$|[+-]\d{2}:?\d{2}$/.test(raw)) {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const match = raw.match(
    /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{1,2}):(\d{2})(?::(\d{2}))?)?$/
  );
  if (!match) {
    const parsed = Date.parse(raw);
    return Number.isNaN(parsed) ? null : parsed;
  }

  const naiveUtc = Date.UTC(
    Number(match[1]),
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4] || 0),
    Number(match[5] || 0),
    Number(match[6] || 0)
  );

  if (timeZone && isValidTimeZone(timeZone)) return fromZonedNaive(naiveUtc, timeZone);

  const fixedOffset = timeZone ? parseFixedOffsetMinutes(timeZone) : null;
  if (fixedOffset !== null) return naiveUtc - fixedOffset * 60000;

  // No zone given: read the wall clock as UTC rather than as the server's own
  // local time, so the same URL means the same instant on every machine.
  return naiveUtc;
}

/** Whole days/hours/minutes/seconds left, never negative. */
function breakdown(remainingMs) {
  const totalSeconds = Math.max(0, Math.floor(remainingMs / 1000));

  return {
    totalSeconds,
    days: Math.floor(totalSeconds / 86400),
    hours: Math.floor((totalSeconds % 86400) / 3600),
    minutes: Math.floor((totalSeconds % 3600) / 60),
    seconds: totalSeconds % 60,
  };
}

module.exports = {
  isValidTimeZone,
  zoneOffsetMs,
  fromZonedNaive,
  parseFixedOffsetMinutes,
  resolveDeadline,
  breakdown,
};

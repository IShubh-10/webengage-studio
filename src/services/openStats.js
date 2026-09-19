/**
 * Reading the open counters back: windows, series and the per-creative report.
 *
 * The calendar belongs to whoever is looking at the page. "This month" in
 * Mumbai and "this month" in Lisbon are different windows over the same stored
 * rows, so the browser sends the two ends of the window it means, plus its UTC
 * offset, and everything here works in those terms. Nothing about a reader's
 * region is stored.
 */

const {
  totalsByAsset,
  totalOpens,
  openSeries,
  openByHourOfDay,
  assetLifetime,
} = require('../repositories/statsRepository');
const { listTemplateNames } = require('../repositories/templateRepository');
const { listTimerNames } = require('../repositories/timerRepository');
const { toMysqlUtc, mysqlUtcToIso } = require('../lib/utcTime');
const { STATS_MAX_RANGE_DAYS } = require('../config');

const DAY_MS = 24 * 3600 * 1000;

const ASSET_TYPES = ['template', 'timer'];

/* --------------------------------------------------------------- the window */

/**
 * Turn `?from=&to=&unit=&tzOffset=` into a validated window.
 *
 * The ends are kept exactly as they arrived, and deliberately not rounded to
 * whole hours. A bucket belongs to the local day its *start* falls in, so
 * `bucket_hour >= from` already selects precisely the buckets the reader means
 * — and in a half-hour zone (IST is +5:30) rounding breaks that. Local
 * midnight on 21 August is 18:30 the day before in UTC; snapping it back to
 * 18:00 pulls in the bucket whose local time is 23:30 on the 20th, and the
 * chart grows a stray column for a day the reader did not ask about.
 */
function parseRange(query) {
  const now = Date.now();

  const offsetMinutes = clampOffset(query.tzOffset);

  let to = parseInstant(query.to, now);
  let from = parseInstant(query.from, to - 30 * DAY_MS);

  if (!(from < to)) {
    const err = new Error('The start of the range has to come before the end');
    err.status = 400;
    throw err;
  }

  if (to - from > STATS_MAX_RANGE_DAYS * DAY_MS) {
    const err = new Error(`A range may cover at most ${STATS_MAX_RANGE_DAYS} days`);
    err.status = 400;
    throw err;
  }

  const unit = pickUnit(query.unit, to - from);

  return {
    fromMs: from,
    toMs: to,
    from: toMysqlUtc(new Date(from)),
    to: toMysqlUtc(new Date(to)),
    // The window of the same length immediately before this one, for the
    // "vs previous period" figure. Same length, so the comparison is fair
    // even for an odd custom range.
    previousFrom: toMysqlUtc(new Date(from - (to - from))),
    previousTo: toMysqlUtc(new Date(from)),
    unit,
    offsetMinutes,
  };
}

function parseInstant(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;

  const parsed = Date.parse(value);
  if (Number.isNaN(parsed)) {
    const err = new Error(`Not a date: ${value}`);
    err.status = 400;
    throw err;
  }

  return parsed;
}

// Every real zone is within ±14 hours of UTC; anything else is a typo or a
// probe, and letting it through would shift a whole report by days.
function clampOffset(value) {
  const minutes = Number(value);
  if (!Number.isFinite(minutes)) return 0;
  return Math.max(-840, Math.min(840, Math.round(minutes)));
}

/**
 * How finely to slice the window.
 *
 * A caller may ask, but the span decides what is sensible: an hourly series
 * over a year is 8,760 points, which is neither drawable nor readable.
 */
function pickUnit(requested, spanMs) {
  const asked = String(requested || '').toLowerCase();
  const allowed = asked === 'hour' || asked === 'day' || asked === 'month' ? asked : null;

  if (allowed === 'hour' && spanMs <= 7 * DAY_MS) return 'hour';
  if (allowed === 'month' && spanMs >= 60 * DAY_MS) return 'month';
  if (allowed === 'day' && spanMs <= 400 * DAY_MS) return 'day';

  if (spanMs <= 2 * DAY_MS) return 'hour';
  if (spanMs <= 120 * DAY_MS) return 'day';
  return 'month';
}

/* -------------------------------------------------------------- the series */

/**
 * A point for every slot in the window, including the empty ones.
 *
 * The database only returns buckets that have opens — a year of a quiet
 * creative is one row, not 8,760 of zero — so the gaps are filled here, where
 * the window's own boundaries are known. A chart with holes in it reads as
 * missing data rather than as nothing happening.
 */
function fillSeries(rows, { fromMs, toMs, unit, offsetMinutes }) {
  const counts = new Map(rows.map((row) => [row.bucket, row.opens]));
  const slots = enumerateBuckets(fromMs, toMs, unit, offsetMinutes);

  return slots.map((bucket) => ({ bucket, opens: counts.get(bucket) || 0 }));
}

/**
 * Every bucket key between the two ends, in the reader's calendar.
 *
 * The keys have to match what MySQL's DATE_FORMAT produced for the same
 * instants, so they are built from the same shifted clock: add the offset and
 * then read the UTC fields, which is the wall time where the reader is.
 */
function enumerateBuckets(fromMs, toMs, unit, offsetMinutes) {
  const shift = offsetMinutes * 60 * 1000;
  const start = new Date(fromMs + shift);
  const endMs = toMs + shift;

  const buckets = [];
  let year = start.getUTCFullYear();
  let month = start.getUTCMonth();
  let day = start.getUTCDate();
  let hour = start.getUTCHours();

  // A window can be a year of months, and a custom one could be longer still;
  // the cap is a guard against a loop that cannot terminate, not a real limit.
  for (let guard = 0; guard < 20000; guard += 1) {
    const cursor =
      unit === 'month'
        ? Date.UTC(year, month, 1)
        : unit === 'day'
          ? Date.UTC(year, month, day)
          : Date.UTC(year, month, day, hour);

    if (cursor >= endMs) break;

    /*
     * The slot the window opens inside is kept even when the window starts
     * part-way through it. A reader asking for a period that begins at midday
     * still has opens in that day, and they are counted in the total above the
     * chart — leaving the slot out would make the columns disagree with it.
     */
    buckets.push(formatBucket(new Date(cursor), unit));

    if (unit === 'month') {
      month += 1;
    } else if (unit === 'day') {
      day += 1;
    } else {
      hour += 1;
    }

    // Date.UTC normalises overflow (month 12 → January of the next year), so
    // the fields are re-read from it rather than carried by hand.
    const normalised = new Date(Date.UTC(year, month, day, hour));
    year = normalised.getUTCFullYear();
    month = normalised.getUTCMonth();
    day = normalised.getUTCDate();
    hour = normalised.getUTCHours();
  }

  return buckets;
}

function pad(value) {
  return String(value).padStart(2, '0');
}

function formatBucket(date, unit) {
  const ymd = `${date.getUTCFullYear()}-${pad(date.getUTCMonth() + 1)}-${pad(date.getUTCDate())}`;

  if (unit === 'month') return ymd.slice(0, 7);
  if (unit === 'day') return ymd;
  return `${ymd} ${pad(date.getUTCHours())}:00:00`;
}

/* ------------------------------------------------------------- the reports */

/** Every creative in the studio, whether or not it has ever been opened. */
async function listAssets() {
  const [templates, timers] = await Promise.all([listTemplateNames(), listTimerNames()]);

  return [
    ...templates.map((row) => ({ ...row, type: 'template' })),
    ...timers.map((row) => ({ ...row, type: 'timer' })),
  ];
}

function assetKey(type, id) {
  return `${type}|${id}`;
}

/**
 * The studio-wide report: one headline number, the shape of the window, and a
 * row per creative.
 *
 * Creatives with no opens in the window are listed too, at zero. A creative
 * nobody opened is the most actionable row on the page, and leaving it out
 * would make it the one thing the page cannot tell you.
 */
async function overview(range) {
  const { from, to, previousFrom, previousTo, unit, offsetMinutes } = range;

  const [assets, totals, seriesRows, previous] = await Promise.all([
    listAssets(),
    totalsByAsset({ from, to }),
    openSeries({ from, to, unit, offsetMinutes }),
    totalOpens({ from: previousFrom, to: previousTo }),
  ]);

  const byAsset = new Map(totals.map((row) => [assetKey(row.assetType, row.assetId), row]));
  const windowTotal = totals.reduce((sum, row) => sum + row.opens, 0);

  const rows = assets.map((asset) => {
    const counted = byAsset.get(assetKey(asset.type, asset.id));
    const opens = counted ? counted.opens : 0;

    return {
      assetType: asset.type,
      assetId: asset.id,
      name: asset.name,
      createdByName: asset.createdByName,
      opens,
      share: windowTotal > 0 ? opens / windowTotal : 0,
      lastOpenAt: counted ? mysqlUtcToIso(counted.lastOpenAt) : null,
    };
  });

  /*
   * Counted rows whose creative has since been deleted still matter: the opens
   * happened, and dropping them here would make the rows below disagree with
   * the headline above them.
   */
  totals.forEach((row) => {
    const known = assets.some((asset) => asset.type === row.assetType && asset.id === row.assetId);
    if (known) return;

    rows.push({
      assetType: row.assetType,
      assetId: row.assetId,
      name: row.assetId,
      createdByName: null,
      deleted: true,
      opens: row.opens,
      share: windowTotal > 0 ? row.opens / windowTotal : 0,
      lastOpenAt: mysqlUtcToIso(row.lastOpenAt),
    });
  });

  rows.sort((a, b) => b.opens - a.opens || String(a.assetId).localeCompare(String(b.assetId)));

  return {
    total: windowTotal,
    previousTotal: previous,
    unit,
    series: fillSeries(seriesRows, range),
    assets: rows,
  };
}

/** The same window, narrowed to one creative, plus its lifetime figures. */
async function assetReport(range, assetType, assetId) {
  if (!ASSET_TYPES.includes(assetType)) {
    const err = new Error(`Unknown asset type: ${assetType}`);
    err.status = 400;
    throw err;
  }

  const { from, to, previousFrom, previousTo, unit, offsetMinutes } = range;
  const scope = { assetType, assetId };

  const [total, previous, seriesRows, hours, lifetime, assets] = await Promise.all([
    totalOpens({ from, to, ...scope }),
    totalOpens({ from: previousFrom, to: previousTo, ...scope }),
    openSeries({ from, to, unit, offsetMinutes, ...scope }),
    openByHourOfDay({ from, to, offsetMinutes, ...scope }),
    assetLifetime(scope),
    listAssets(),
  ]);

  const asset = assets.find((row) => row.type === assetType && row.id === assetId);

  return {
    assetType,
    assetId,
    name: asset ? asset.name : assetId,
    createdByName: asset ? asset.createdByName : null,
    deleted: !asset,
    total,
    previousTotal: previous,
    unit,
    series: fillSeries(seriesRows, range),
    hourOfDay: hours,
    lifetime: {
      opens: lifetime.opens,
      firstOpenAt: mysqlUtcToIso(lifetime.firstBucket),
      lastOpenAt: mysqlUtcToIso(lifetime.lastOpenAt),
    },
  };
}

module.exports = { parseRange, overview, assetReport, fillSeries, enumerateBuckets, pickUnit };

/**
 * The shape of a timer, and the one place it gets validated.
 *
 * Everything a countdown URL can express also has to be storable as a saved
 * timer, so the same normaliser runs over a database row and over raw query
 * parameters. Anything unrecognised falls back to a default rather than
 * failing: the endpoint sits inside an `<img>` tag in someone's inbox, where a
 * 400 shows up as a broken image.
 */

const { UNIT_KEYS, DEFAULT_LABELS, sanitizeColor, sanitizeFontFamily } = require('./layout');
const { TIMER_MAX_FRAMES, TIMER_MAX_CANVAS_WIDTH } = require('../../config');

function clamp(value, min, max, fallback) {
  const number = Number(value);
  if (!Number.isFinite(number)) return fallback;
  return Math.min(max, Math.max(min, number));
}

function bool(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback;
  if (typeof value === 'boolean') return value;
  return ['1', 'true', 'yes', 'on'].includes(String(value).toLowerCase());
}

function parseUnits(value) {
  if (!value) return null;

  const list = Array.isArray(value) ? value : String(value).split(/[,|]/);
  const units = list
    .map((unit) => String(unit).trim().toLowerCase())
    .map((unit) => {
      if (['d', 'day', 'days'].includes(unit)) return 'days';
      if (['h', 'hour', 'hours', 'hrs'].includes(unit)) return 'hours';
      if (['m', 'min', 'mins', 'minute', 'minutes'].includes(unit)) return 'minutes';
      if (['s', 'sec', 'secs', 'second', 'seconds'].includes(unit)) return 'seconds';
      return null;
    })
    .filter(Boolean);

  // Keep them in descending magnitude however they were listed, and drop
  // duplicates — "seconds,days" is a typo, not a layout.
  const ordered = UNIT_KEYS.filter((unit) => units.includes(unit));
  return ordered.length ? ordered : null;
}

const DEFAULT_STYLE = {
  x: 0.5,
  y: 0.5,
  units: ['days', 'hours', 'minutes', 'seconds'],
  fontFamily: 'Arial',
  fontSize: 48,
  fontWeight: 'bold',
  color: '#ffffff',
  separator: ':',
  separatorColor: '#ffffff',
  gap: 10,
  showLabels: true,
  labels: { ...DEFAULT_LABELS },
  labelFontFamily: '',
  labelFontSize: 13,
  labelFontWeight: 'bold',
  labelColor: '#ffffff',
  labelGap: 8,
  labelTracking: 1,
  plate: {
    // 'none' | 'block' (one panel behind the whole clock) | 'unit' (a tile each)
    mode: 'none',
    color: '#000000',
    opacity: 0.45,
    radius: 10,
    padX: 18,
    padY: 14,
    // Whether the plate reaches down over the labels or stops at the digits.
    // True keeps the shape every timer had before this was configurable.
    coverLabels: true,
  },
};

const DEFAULT_EXPIRED = {
  mode: 'message',
  text: 'SALE ENDED',
  color: '#ffffff',
  fontFamily: '',
  fontSize: 42,
  fontWeight: 'bold',
  imageUrl: '',
};

const PLATE_MODES = ['none', 'block', 'unit'];

/**
 * Plates used to be a boolean. Timers saved before per-unit tiles existed carry
 * `enabled` instead of `mode`, so read whichever is there — no migration needed,
 * and an old row keeps rendering exactly as it did.
 */
function plateMode(plate) {
  if (PLATE_MODES.includes(plate.mode)) return plate.mode;
  if (plate.enabled !== undefined) return bool(plate.enabled, false) ? 'block' : 'none';
  return DEFAULT_STYLE.plate.mode;
}

function normalizeStyle(raw = {}) {
  const style = raw || {};
  const plate = style.plate || {};
  const digitColor = sanitizeColor(style.color, DEFAULT_STYLE.color);

  return {
    x: clamp(style.x, -1, 2, DEFAULT_STYLE.x),
    y: clamp(style.y, -1, 2, DEFAULT_STYLE.y),
    units: parseUnits(style.units) || DEFAULT_STYLE.units,
    fontFamily: sanitizeFontFamily(style.fontFamily || DEFAULT_STYLE.fontFamily),
    fontSize: Math.round(clamp(style.fontSize, 8, 400, DEFAULT_STYLE.fontSize)),
    fontWeight: /^(normal|bold|[1-9]00)$/.test(String(style.fontWeight))
      ? String(style.fontWeight)
      : DEFAULT_STYLE.fontWeight,
    color: digitColor,
    separator: String(style.separator === undefined ? DEFAULT_STYLE.separator : style.separator).slice(0, 3),
    // Separators match the digits unless they are given a colour of their own.
    separatorColor: sanitizeColor(style.separatorColor, digitColor),
    gap: Math.round(clamp(style.gap, 0, 200, DEFAULT_STYLE.gap)),
    showLabels: bool(style.showLabels, DEFAULT_STYLE.showLabels),
    labels: UNIT_KEYS.reduce((acc, unit) => {
      const provided = style.labels && style.labels[unit];
      acc[unit] = String(provided === undefined || provided === null ? DEFAULT_LABELS[unit] : provided).slice(0, 12);
      return acc;
    }, {}),
    labelFontFamily: style.labelFontFamily ? sanitizeFontFamily(style.labelFontFamily) : '',
    labelFontSize: Math.round(clamp(style.labelFontSize, 6, 120, DEFAULT_STYLE.labelFontSize)),
    labelFontWeight: /^(normal|bold|[1-9]00)$/.test(String(style.labelFontWeight))
      ? String(style.labelFontWeight)
      : DEFAULT_STYLE.labelFontWeight,
    labelColor: sanitizeColor(style.labelColor, DEFAULT_STYLE.labelColor),
    labelGap: Math.round(clamp(style.labelGap, 0, 120, DEFAULT_STYLE.labelGap)),
    labelTracking: clamp(style.labelTracking, 0, 20, DEFAULT_STYLE.labelTracking),
    plate: {
      mode: plateMode(plate),
      color: sanitizeColor(plate.color, DEFAULT_STYLE.plate.color),
      opacity: clamp(plate.opacity, 0, 1, DEFAULT_STYLE.plate.opacity),
      radius: Math.round(clamp(plate.radius, 0, 200, DEFAULT_STYLE.plate.radius)),
      padX: Math.round(clamp(plate.padX, 0, 400, DEFAULT_STYLE.plate.padX)),
      padY: Math.round(clamp(plate.padY, 0, 400, DEFAULT_STYLE.plate.padY)),
      coverLabels: bool(plate.coverLabels, DEFAULT_STYLE.plate.coverLabels),
    },
  };
}

function normalizeExpired(raw = {}) {
  const expired = raw || {};
  const mode = ['message', 'hide', 'image', 'freeze'].includes(expired.mode)
    ? expired.mode
    : DEFAULT_EXPIRED.mode;

  return {
    mode,
    text: String(expired.text === undefined ? DEFAULT_EXPIRED.text : expired.text).slice(0, 80),
    color: sanitizeColor(expired.color, DEFAULT_EXPIRED.color),
    fontFamily: expired.fontFamily ? sanitizeFontFamily(expired.fontFamily) : '',
    fontSize: Math.round(clamp(expired.fontSize, 8, 400, DEFAULT_EXPIRED.fontSize)),
    fontWeight: /^(normal|bold|[1-9]00)$/.test(String(expired.fontWeight))
      ? String(expired.fontWeight)
      : DEFAULT_EXPIRED.fontWeight,
    imageUrl: String(expired.imageUrl || '').slice(0, 2048),
  };
}

/** A complete, safe timer definition from anything resembling one. */
function normalizeTimer(raw = {}) {
  const source = raw.source || {};

  return {
    source: {
      templateId: String(source.templateId || '').slice(0, 100),
      backgroundUrl: String(source.backgroundUrl || '').slice(0, 2048),
    },
    endAt: raw.endAt ? String(raw.endAt).slice(0, 64) : '',
    timezone: raw.timezone ? String(raw.timezone).slice(0, 64) : '',
    evergreenSeconds: Math.round(clamp(raw.evergreenSeconds, 0, 90 * 86400, 0)),
    canvasWidth: Math.round(clamp(raw.canvasWidth, 0, TIMER_MAX_CANVAS_WIDTH, 0)),
    background: sanitizeColor(raw.background, '#ffffff'),
    colors: Math.round(clamp(raw.colors, 8, 256, 256)),
    frames: Math.round(clamp(raw.frames, 1, TIMER_MAX_FRAMES, 60)),
    // Loop mode always runs exactly one 60-frame seconds cycle, so `frames` is
    // ignored while it is on.
    loop: bool(raw.loop, false),
    style: normalizeStyle(raw.style),
    expired: normalizeExpired(raw.expired),
  };
}

/**
 * Query parameters onto a timer, so a URL can override a saved timer. Only keys
 * that are actually present override, which keeps `?end=...` from resetting
 * someone's styling.
 *
 * `allowSource` gates the two parameters that choose what gets fetched. The GIF
 * endpoint is public — it has to be, it lives in an `<img>` tag — so on that
 * path the creative is whatever the signed-in author saved, and a URL cannot
 * point the server at an arbitrary host. Overriding `template` stays available
 * because template ids are already public through /api/v1/render/:id.
 */
function applyQueryOverrides(timer, query = {}, { allowSource = false } = {}) {
  const has = (key) => query[key] !== undefined && query[key] !== '';
  const merged = JSON.parse(JSON.stringify(timer));

  if (has('template')) {
    merged.source.templateId = query.template;
    merged.source.backgroundUrl = '';
  }
  if (allowSource && has('bg')) merged.source.backgroundUrl = query.bg;
  if (has('end')) merged.endAt = query.end;
  if (has('tz')) merged.timezone = query.tz;
  if (has('dur')) merged.evergreenSeconds = query.dur;
  if (has('w')) merged.canvasWidth = query.w;
  if (has('bgcolor')) merged.background = query.bgcolor;
  if (has('colors')) merged.colors = query.colors;
  if (has('frames')) merged.frames = query.frames;
  if (query.loop !== undefined) merged.loop = query.loop;

  if (has('x')) merged.style.x = query.x;
  if (has('y')) merged.style.y = query.y;
  if (has('units')) merged.style.units = query.units;
  if (has('font')) merged.style.fontFamily = query.font;
  if (has('size')) merged.style.fontSize = query.size;
  if (has('weight')) merged.style.fontWeight = query.weight;
  if (has('color')) merged.style.color = query.color;
  if (has('sep')) merged.style.separator = query.sep;
  if (has('sepcolor')) merged.style.separatorColor = query.sepcolor;
  if (has('gap')) merged.style.gap = query.gap;
  if (query.labels !== undefined) merged.style.showLabels = query.labels;
  if (has('labelcolor')) merged.style.labelColor = query.labelcolor;
  if (has('labelsize')) merged.style.labelFontSize = query.labelsize;
  // ?plate= takes a mode, or a boolean for URLs written before tiles existed.
  if (has('plate')) {
    merged.style.plate.mode = PLATE_MODES.includes(String(query.plate))
      ? String(query.plate)
      : (bool(query.plate, false) ? 'block' : 'none');
  }
  if (has('platelabels')) merged.style.plate.coverLabels = query.platelabels;
  if (has('platecolor')) merged.style.plate.color = query.platecolor;
  if (has('plateradius')) merged.style.plate.radius = query.plateradius;
  if (has('plateopacity')) merged.style.plate.opacity = query.plateopacity;
  if (has('platepadx')) merged.style.plate.padX = query.platepadx;
  if (has('platepady')) merged.style.plate.padY = query.platepady;

  if (has('expired')) merged.expired.text = query.expired;
  if (has('expiredmode')) merged.expired.mode = query.expiredmode;
  if (has('expiredcolor')) merged.expired.color = query.expiredcolor;
  if (has('expiredimage')) merged.expired.imageUrl = query.expiredimage;

  return normalizeTimer(merged);
}

module.exports = {
  PLATE_MODES,
  DEFAULT_STYLE,
  DEFAULT_EXPIRED,
  normalizeStyle,
  normalizeExpired,
  normalizeTimer,
  applyQueryOverrides,
};

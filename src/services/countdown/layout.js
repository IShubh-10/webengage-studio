/**
 * Where every digit sits, and how wide it is.
 *
 * The countdown is drawn as a grid of fixed-width slots rather than as a string
 * of text. Two reasons: proportional fonts would make the numbers jitter as a
 * "1" replaced an "8", and — more importantly — a fixed slot is a fixed
 * rectangle, which is what lets a frame update just the pixels of the digit that
 * changed.
 *
 * Glyph metrics come from rendering once through sharp and reading the trimmed
 * bounding box back, so the layout is correct for whatever fonts the host
 * actually has rather than for a guessed em ratio.
 */

const sharp = require('sharp');

const { LRUCache } = require('../../lib/cache');
const { escapeXml } = require('../render');

// Metrics depend only on the font, so they survive across templates and
// requests. A miss costs one small sharp render.
const metricsCache = new LRUCache(128);

const UNIT_KEYS = ['days', 'hours', 'minutes', 'seconds'];

const DEFAULT_LABELS = {
  days: 'DAYS',
  hours: 'HOURS',
  minutes: 'MINS',
  seconds: 'SECS',
};

/** Font families reach librsvg as-is, so keep the value to something inert. */
function sanitizeFontFamily(value) {
  const cleaned = String(value || 'Arial')
    .replace(/[^A-Za-z0-9 ,._-]/g, '')
    .trim();
  return cleaned || 'Arial';
}

function sanitizeColor(value, fallback) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) return raw;
  if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(raw)) return raw;
  if (/^[a-zA-Z]{3,20}$/.test(raw)) return raw;
  return fallback;
}

function fontStyleKey(font) {
  return `${font.fontFamily}|${font.fontSize}|${font.fontWeight}`;
}

/**
 * Ink box of a string, measured by rendering it and trimming the transparent
 * border away.
 *
 * Returns the advance width per character too — digits in virtually every font
 * are tabular, so dividing the ink width of "0123456789" by ten gives the exact
 * cell width the layout needs.
 */
async function measureText(text, font) {
  const fontFamily = sanitizeFontFamily(font.fontFamily);
  const fontSize = Math.max(4, Math.round(font.fontSize));
  const fontWeight = /^(normal|bold|[1-9]00)$/.test(String(font.fontWeight))
    ? String(font.fontWeight)
    : 'normal';

  const pad = Math.ceil(fontSize * 0.8);
  const baseline = Math.ceil(fontSize * 1.6);
  const canvasWidth = Math.ceil(fontSize * 1.4 * (text.length + 1)) + pad * 2;
  const canvasHeight = Math.ceil(fontSize * 2.6);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">
    <text x="${pad}" y="${baseline}" font-family="${escapeXml(fontFamily)}" font-size="${fontSize}"
          font-weight="${fontWeight}" fill="#ffffff" xml:space="preserve">${escapeXml(text)}</text>
  </svg>`;

  try {
    const { info } = await sharp(Buffer.from(svg))
      .trim({ threshold: 1 })
      .toBuffer({ resolveWithObject: true });

    // trimOffsetLeft/Top are negative: how far into the canvas the ink starts.
    const leftBearing = Math.max(0, -info.trimOffsetLeft - pad);

    return {
      width: info.width,
      height: info.height,
      leftBearing,
      // Distance from the top of the ink down to the baseline, which is how the
      // glyph gets positioned inside a cell of exactly `height` pixels.
      baselineFromInkTop: baseline + info.trimOffsetTop,
      advance: text.length ? (info.width + leftBearing * 2) / text.length : 0,
    };
  } catch (err) {
    // An empty string, or a glyph the font cannot draw, trims to nothing.
    return { width: 0, height: 0, leftBearing: 0, baselineFromInkTop: 0, advance: 0 };
  }
}

async function measureDigits(font) {
  const key = `digits:${fontStyleKey(font)}`;
  const cached = metricsCache.get(key);
  if (cached) return cached;

  const measured = await measureText('0123456789', font);

  // A font with no digits at all would collapse the layout; fall back to the
  // usual 0.55em advance so the timer still renders.
  const metrics = {
    advance: measured.advance || Math.round(font.fontSize * 0.55),
    height: measured.height || Math.round(font.fontSize * 0.72),
    baselineFromInkTop: measured.baselineFromInkTop || Math.round(font.fontSize * 0.72),
  };

  metricsCache.set(key, metrics);
  return metrics;
}

async function measureSeparator(text, font) {
  if (!text) return { width: 0, height: 0, baselineFromInkTop: 0 };

  const key = `sep:${text}:${fontStyleKey(font)}`;
  const cached = metricsCache.get(key);
  if (cached) return cached;

  const measured = await measureText(text, font);
  metricsCache.set(key, measured);
  return measured;
}

/**
 * Every unit gets two slots except the largest one shown, which has to absorb
 * everything above it: a timer configured for hours only shows "72" for three
 * days, and one running past 99 days needs a third slot.
 */
function digitCountFor(isLeadUnit, leadDigits) {
  return isLeadUnit ? Math.max(2, leadDigits) : 2;
}

/**
 * Builds the full geometry of the timer block: one entry per digit slot, plus
 * the static furniture (separators, labels, backing plate) that gets baked into
 * the background because it never changes while the clock runs.
 *
 * Positions come in as fractions of the canvas so the block stays put when the
 * creative is re-rendered at a different size, and it is anchored on its centre
 * so changing the font size grows the block outwards rather than dragging it.
 */
async function buildLayout({ style, canvasWidth, canvasHeight, leadDigits = 2 }) {
  const digitFont = {
    fontFamily: style.fontFamily,
    fontSize: style.fontSize,
    fontWeight: style.fontWeight,
  };
  const labelFont = {
    fontFamily: style.labelFontFamily || style.fontFamily,
    fontSize: style.labelFontSize,
    fontWeight: style.labelFontWeight,
  };

  const digits = await measureDigits(digitFont);
  const separator = await measureSeparator(style.separator, {
    ...digitFont,
    fontSize: Math.round(style.fontSize * 0.9),
  });

  const digitWidth = Math.max(1, Math.ceil(digits.advance));
  const digitHeight = Math.max(1, digits.height);

  const units = style.units.filter((unit) => UNIT_KEYS.includes(unit));
  const groups = units.map((unit, index) => ({
    unit,
    digits: digitCountFor(index === 0, leadDigits),
    label: style.showLabels ? style.labels[unit] || DEFAULT_LABELS[unit] : '',
  }));

  const labelMetrics = style.showLabels
    ? await measureText(
        groups.map((group) => group.label).join('') || 'X',
        labelFont
      )
    : { height: 0, baselineFromInkTop: 0 };

  const separatorSpan = separator.width ? separator.width + style.gap * 2 : style.gap;

  let blockWidth = 0;
  groups.forEach((group, i) => {
    if (i > 0) blockWidth += separatorSpan;
    group.width = group.digits * digitWidth;
    blockWidth += group.width;
  });

  const labelBand = style.showLabels ? style.labelGap + labelMetrics.height : 0;
  const blockHeight = digitHeight + labelBand;

  const left = Math.round(style.x * canvasWidth - blockWidth / 2);
  const top = Math.round(style.y * canvasHeight - blockHeight / 2);

  // Slots and separator positions, walking the block left to right.
  const slots = [];
  const separators = [];
  let cursor = left;

  groups.forEach((group, groupIndex) => {
    if (groupIndex > 0) {
      if (separator.width) {
        separators.push({
          centerX: cursor + separatorSpan / 2,
          baselineY: top + digits.baselineFromInkTop,
        });
      }
      cursor += separatorSpan;
    }

    group.left = cursor;

    for (let position = 0; position < group.digits; position++) {
      slots.push({
        unit: group.unit,
        // 0 is the most significant digit of this unit.
        position,
        power: 10 ** (group.digits - 1 - position),
        left: cursor,
        top,
        width: digitWidth,
        height: digitHeight,
      });
      cursor += digitWidth;
    }
  });

  return {
    left,
    top,
    width: blockWidth,
    height: blockHeight,
    // Distance from the end of one group to the start of the next, which is what
    // limits how wide a per-unit plate can be before two of them touch.
    groupSpacing: separatorSpan,
    digitWidth,
    digitHeight,
    baselineFromInkTop: digits.baselineFromInkTop,
    groups,
    slots,
    separators,
    separatorText: separator.width ? style.separator : '',
    separatorFontSize: Math.round(style.fontSize * 0.9),
    labelBaselineY: top + digitHeight + style.labelGap + labelMetrics.baselineFromInkTop,
    labelHeight: labelMetrics.height,
    fonts: { digit: digitFont, label: labelFont },
  };
}

/**
 * The rectangles the backing plate is drawn as.
 *
 * `block` puts one panel behind the whole clock; `unit` gives each of days,
 * hours, minutes and seconds its own tile, which is the flip-clock look. A tile
 * wraps its group's digits and that group's label, so turning labels off leaves
 * bare number tiles.
 *
 * Per-unit horizontal padding is clamped to half the space between two groups,
 * so tiles can never overlap however wide the padding is set — widen the gap
 * (or drop the separator) to get fatter tiles.
 *
 * Shared by the GIF renderer, the expired card and the builder preview, so all
 * three agree on the shape.
 */
function plateRects(layout, style, { forceBlock = false } = {}) {
  const plate = style.plate;
  if (plate.mode === 'none') return [];

  if (plate.mode === 'unit' && !forceBlock && layout.groups.length > 0) {
    const padX = Math.min(plate.padX, Math.max(0, Math.floor((layout.groupSpacing - 1) / 2)));

    return layout.groups.map((group) => ({
      x: group.left - padX,
      y: layout.top - plate.padY,
      width: group.width + padX * 2,
      height: layout.height + plate.padY * 2,
    }));
  }

  return [
    {
      x: layout.left - plate.padX,
      y: layout.top - plate.padY,
      width: layout.width + plate.padX * 2,
      height: layout.height + plate.padY * 2,
    },
  ];
}

function plateSvg(rects, style) {
  return rects.map(
    (rect) =>
      `<rect x="${rect.x}" y="${rect.y}" width="${rect.width}" height="${rect.height}" ` +
      `rx="${style.plate.radius}" ry="${style.plate.radius}" fill="${style.plate.color}" ` +
      `fill-opacity="${style.plate.opacity}"/>`
  );
}

/**
 * The parts of the timer that never change while it runs — backing plate,
 * separators and unit labels — as one SVG that gets composited into the
 * background before anything is quantised.
 */
function staticOverlaySvg(layout, style, canvasWidth, canvasHeight) {
  const parts = plateSvg(plateRects(layout, style), style);

  if (layout.separatorText) {
    const family = escapeXml(sanitizeFontFamily(layout.fonts.digit.fontFamily));
    layout.separators.forEach(({ centerX, baselineY }) => {
      parts.push(
        `<text x="${centerX}" y="${baselineY}" text-anchor="middle" font-family="${family}" ` +
          `font-size="${layout.separatorFontSize}" font-weight="${layout.fonts.digit.fontWeight}" ` +
          `fill="${style.separatorColor}">${escapeXml(layout.separatorText)}</text>`
      );
    });
  }

  if (style.showLabels) {
    const family = escapeXml(sanitizeFontFamily(layout.fonts.label.fontFamily));
    layout.groups.forEach((group) => {
      if (!group.label) return;
      parts.push(
        `<text x="${group.left + group.width / 2}" y="${layout.labelBaselineY}" text-anchor="middle" ` +
          `font-family="${family}" font-size="${layout.fonts.label.fontSize}" ` +
          `font-weight="${layout.fonts.label.fontWeight}" letter-spacing="${style.labelTracking}" ` +
          `fill="${style.labelColor}">${escapeXml(group.label)}</text>`
      );
    });
  }

  if (parts.length === 0) return null;

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">${parts.join('')}</svg>`
  );
}

/**
 * A strip of the ten digits, each centred in its own cell, rendered once and
 * then sliced into per-slot tiles.
 */
function digitAtlasSvg(layout, style) {
  const family = escapeXml(sanitizeFontFamily(layout.fonts.digit.fontFamily));
  const cells = [];

  for (let digit = 0; digit <= 9; digit++) {
    cells.push(
      `<text x="${digit * layout.digitWidth + layout.digitWidth / 2}" y="${layout.baselineFromInkTop}" ` +
        `text-anchor="middle" font-family="${family}" font-size="${layout.fonts.digit.fontSize}" ` +
        `font-weight="${layout.fonts.digit.fontWeight}" fill="${style.color}">${digit}</text>`
    );
  }

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${layout.digitWidth * 10}" height="${layout.digitHeight}">${cells.join('')}</svg>`
  );
}

module.exports = {
  UNIT_KEYS,
  DEFAULT_LABELS,
  sanitizeFontFamily,
  sanitizeColor,
  measureText,
  measureDigits,
  buildLayout,
  plateRects,
  plateSvg,
  staticOverlaySvg,
  digitAtlasSvg,
};

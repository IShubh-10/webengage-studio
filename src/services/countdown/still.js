/**
 * A single PNG frame of a timer, for the builder's live preview.
 *
 * The GIF path quantises to 256 colours and pre-renders every digit tile, which
 * is the right trade for something served thousands of times but the wrong one
 * for something re-rendered on every drag of a slider. This draws the same
 * layout in one pass at full colour: composite the creative, put the furniture
 * and the digits on it, done.
 */

const sharp = require('sharp');

const { escapeXml } = require('../render');
const { buildLayout, staticOverlaySvg, sanitizeFontFamily, plateRects, plateSvg } = require('./layout');
const { renderTemplate, renderBackgroundOnly } = require('../render');
const { loadImageBuffer } = require('../images');
const { resolveDeadline } = require('./time');
const { unitValues, leadDigitsFor, UNIT_SECONDS } = require('./index');
const { TIMER_MAX_CANVAS_WIDTH } = require('../../config');

/** The digits themselves, each centred in its slot exactly as the GIF draws them. */
function digitsSvg(layout, style, values, canvasWidth, canvasHeight) {
  const family = escapeXml(sanitizeFontFamily(layout.fonts.digit.fontFamily));

  const glyphs = layout.slots.map((slot) => {
    const digit = Math.floor((values[slot.unit] || 0) / slot.power) % 10;
    return (
      `<text x="${slot.left + slot.width / 2}" y="${slot.top + layout.baselineFromInkTop}" ` +
      `text-anchor="middle" font-family="${family}" font-size="${layout.fonts.digit.fontSize}" ` +
      `font-weight="${layout.fonts.digit.fontWeight}" fill="${style.color}">${digit}</text>`
    );
  });

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">${glyphs.join('')}</svg>`
  );
}

function expiredSvg(timer, layout, canvasWidth, canvasHeight) {
  const family = escapeXml(
    sanitizeFontFamily(timer.expired.fontFamily || timer.style.fontFamily)
  );

  return Buffer.from(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">` +
      `<text x="${layout.left + layout.width / 2}" y="${layout.top + layout.height / 2}" ` +
      `text-anchor="middle" dominant-baseline="central" font-family="${family}" ` +
      `font-size="${timer.expired.fontSize}" font-weight="${timer.expired.fontWeight}" ` +
      `fill="${timer.expired.color}">${escapeXml(timer.expired.text)}</text></svg>`
  );
}

/**
 * Renders the timer as it would look `now`, or at an explicit `previewSeconds`
 * remaining so the builder can show a realistic clock before a deadline is set.
 */
async function renderStill(timer, { vars = {}, now = Date.now(), previewSeconds = null } = {}) {
  const composed = timer.source.templateId
    ? await renderTemplate(timer.source.templateId, vars)
    : await renderBackgroundOnly(timer.source.backgroundUrl, vars);

  // Layers are positioned against the creative's own resolution, and sharp
  // resizes before it composites — so the scale has to be applied to the
  // finished picture rather than to the pipeline that draws it.
  const drawn = await composed.pipeline.raw().toBuffer({ resolveWithObject: true });

  let pipeline = sharp(drawn.data, {
    raw: { width: drawn.info.width, height: drawn.info.height, channels: drawn.info.channels },
  });

  const targetWidth = Math.min(timer.canvasWidth || drawn.info.width, TIMER_MAX_CANVAS_WIDTH);
  if (targetWidth !== drawn.info.width) {
    pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: false });
  }

  const { data, info } = await pipeline
    .flatten({ background: timer.background })
    .png()
    .toBuffer({ resolveWithObject: true });

  const canvasWidth = info.width;
  const canvasHeight = info.height;

  let remainingSeconds;
  if (previewSeconds !== null) {
    remainingSeconds = Math.max(0, Math.floor(previewSeconds));
  } else if (timer.evergreenSeconds > 0) {
    remainingSeconds = timer.evergreenSeconds;
  } else {
    const deadline = resolveDeadline(timer.endAt, timer.timezone);
    remainingSeconds = deadline === null ? null : Math.max(0, Math.floor((deadline - now) / 1000));
  }

  // Nothing to count down to yet: show a plausible clock rather than zeros, so
  // the layout can be positioned before the campaign date is decided.
  if (remainingSeconds === null) remainingSeconds = 2 * 86400 + 3 * 3600 + 25 * 60 + 39;

  const expired = remainingSeconds <= 0 && timer.expired.mode !== 'freeze';

  const layout = await buildLayout({
    style: timer.style,
    canvasWidth,
    canvasHeight,
    leadDigits: leadDigitsFor(remainingSeconds, timer.style.units),
  });

  const overlays = [];

  if (expired && timer.expired.mode === 'image' && timer.expired.imageUrl) {
    const buffer = await loadImageBuffer(timer.expired.imageUrl);
    if (buffer) {
      overlays.push({
        input: await sharp(buffer)
          .resize({
            width: canvasWidth,
            height: canvasHeight,
            fit: sharp.fit.cover,
            position: sharp.position.centre,
          })
          .png()
          .toBuffer(),
        top: 0,
        left: 0,
      });
    }
  } else if (expired && timer.expired.mode === 'hide') {
    // Nothing at all: the live endpoint returns a transparent pixel here.
  } else if (expired) {
    // Same single panel the GIF's expired card uses, so the preview matches.
    const plate = plateSvg(plateRects(layout, timer.style, { forceBlock: true }), timer.style);
    if (plate.length) {
      overlays.push({
        input: Buffer.from(
          `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">${plate.join('')}</svg>`
        ),
        top: 0,
        left: 0,
      });
    }
    overlays.push({ input: expiredSvg(timer, layout, canvasWidth, canvasHeight), top: 0, left: 0 });
  } else {
    const furniture = staticOverlaySvg(layout, timer.style, canvasWidth, canvasHeight);
    if (furniture) overlays.push({ input: furniture, top: 0, left: 0 });
    overlays.push({
      input: digitsSvg(
        layout,
        timer.style,
        unitValues(remainingSeconds, timer.style.units),
        canvasWidth,
        canvasHeight
      ),
      top: 0,
      left: 0,
    });
  }

  const buffer = await sharp(data)
    .composite(overlays)
    .png({ compressionLevel: 6 })
    .toBuffer();

  return {
    buffer,
    width: canvasWidth,
    height: canvasHeight,
    expired,
    remainingSeconds,
    // Everything the builder needs to draw its drag handle over the preview.
    block: {
      left: layout.left,
      top: layout.top,
      width: layout.width,
      height: layout.height,
    },
    fits:
      layout.left >= 0 &&
      layout.top >= 0 &&
      layout.left + layout.width <= canvasWidth &&
      layout.top + layout.height <= canvasHeight,
  };
}

module.exports = { renderStill, UNIT_SECONDS };

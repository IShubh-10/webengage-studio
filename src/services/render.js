/**
 * The template compositor, lifted out of the render route so more than one
 * endpoint can draw a user's creative.
 *
 * The countdown GIF needs exactly the same picture the PNG renderer produces —
 * the same background, the same layers, the same placeholder substitution —
 * before it paints digits on top. Keeping the compositing here means a creative
 * looks identical whether it is served as a still or as a timer.
 *
 * Routes still own their own caching and response headers; this returns an
 * unconsumed sharp pipeline so a caller can finish it as a PNG or as raw
 * pixels.
 */

const sharp = require('sharp');

const redisState = require('../config/redis').state;
const { ensureTemplateSchema } = require('../db/schema');
const { findTemplate } = require('../repositories/templateRepository');
const { loadImageBuffer, loadImageMetadata, parseDimension } = require('./images');
const { svgCache, resizedCache, LRUCache } = require('../lib/cache');
const { SingleFlight } = require('../lib/singleflight');
const { onInvalidate } = require('../lib/invalidation');
const {
  PLACEHOLDER_REGEX,
  TEMPLATE_MEMORY_SECONDS,
  TEMPLATE_MEMORY_SLOTS,
  TEMPLATE_CACHE_SECONDS,
} = require('../config');

// Sizing modes an image overlay can ask for. 'contain' is the default and the
// only behaviour that existed before, so templates saved without a fit render
// byte-identically.
const FIT_MODES = {
  contain: sharp.fit.inside,
  cover: sharp.fit.cover,
  fill: sharp.fit.fill,
};

/** Merge query parameters with an optional JSON `vars` blob. */
function collectVars(queryParams = {}) {
  let vars = { ...queryParams };

  if (queryParams.vars) {
    try {
      const parsed = JSON.parse(queryParams.vars);
      if (parsed && typeof parsed === 'object') vars = { ...vars, ...parsed };
    } catch (err) {
      // A malformed vars blob should not fail the render; the query parameters
      // that came alongside it are still usable.
    }
  }

  return vars;
}

function applyVars(value, vars) {
  return String(value).replace(PLACEHOLDER_REGEX, (match, name) => {
    const replacement = vars[name];
    return replacement !== undefined && replacement !== null ? String(replacement) : match;
  });
}

function escapeXml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/* ----------------------------------- layer styling, shared with the studio

   docs/index.html applies these same rules to the 300px preview. They are
   deliberately written twice rather than shared, because there is no build step
   between the two — but a change to one without the other is a change to what
   the studio shows and not to what lands in the inbox.
*/

/** Degrees clockwise about a layer's own centre, normalised to (-180, 180]. */
function normalizeRotation(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) return 0;

  let angle = Math.round(number) % 360;
  if (angle > 180) angle -= 360;
  if (angle <= -180) angle += 360;
  return angle;
}

/*
 * These reach librsvg inside an SVG attribute, so they are whitelisted rather
 * than escaped: a colour is either a colour or it is the default, and a value
 * that is neither never reaches the document at all.
 */
function sanitizeColor(value, fallback) {
  const raw = String(value || '').trim();
  if (/^#[0-9a-fA-F]{3,8}$/.test(raw)) return raw;
  if (/^rgba?\(\s*[\d.]+\s*,\s*[\d.]+\s*,\s*[\d.]+\s*(,\s*[\d.]+\s*)?\)$/.test(raw)) return raw;
  if (/^[a-zA-Z]{3,20}$/.test(raw)) return raw;
  return fallback;
}

function sanitizeFontFamily(value) {
  const cleaned = String(value || 'Arial')
    .replace(/[^A-Za-z0-9 ,._-]/g, '')
    .trim();
  return cleaned || 'Arial';
}

function sanitizeFontWeight(value) {
  const raw = String(value || 'normal');
  return /^(normal|bold|bolder|lighter|[1-9]00)$/.test(raw) ? raw : 'normal';
}

const BORDER_STYLES = ['solid', 'dashed', 'dotted', 'double'];

function clampInt(value, min, max, fallback) {
  const number = parseInt(value, 10);
  return Number.isFinite(number) ? Math.max(min, Math.min(max, number)) : fallback;
}

/** The border box of a text layer, or null when it has none. */
function textBorderOf(element) {
  if (!element || !BORDER_STYLES.includes(element.borderStyle)) return null;

  // Layers written before horizontal and vertical padding were separated
  // carry a single `padding`; it stands in for both axes.
  const legacyPadding = clampInt(element.padding, 0, 200, 8);

  return {
    style: element.borderStyle,
    width: clampInt(element.borderWidth, 1, 40, 1),
    color: sanitizeColor(element.borderColor, '#000000'),
    radius: clampInt(element.borderRadius, 0, 200, 10),
    paddingX: clampInt(element.paddingX, 0, 200, legacyPadding),
    paddingY: clampInt(element.paddingY, 0, 200, legacyPadding),
  };
}

/*
 * Measured strings, keyed by the text and the face it is set in.
 *
 * This depends on nothing but the font and the characters, so unlike the SVG
 * and resize caches it survives a template edit and is never invalidated.
 */
const textInkCache = new LRUCache(1024);

// A canvas ceiling, so a pathologically long string cannot ask sharp for a
// hundred-megapixel scratch buffer. A string wider than this measures as this
// wide, which caps the border rather than the render.
const MAX_MEASURE_WIDTH = 8000;

/**
 * How wide a string actually draws, measured with the renderer that will draw
 * it: set the text on a transparent canvas, trim the empty margin away, and
 * read the width back.
 *
 * This has to happen here, on the substituted text, rather than in the studio
 * on the text the designer typed. A layer reading `Hello, {{name}}` is 198px
 * wide in the studio and 242px wide once `{{name}}` becomes `enter_name` —
 * and wider still for a longer name. A box measured at design time fits the
 * placeholder and nothing else, which is the opposite of what a personalised
 * creative needs.
 *
 * Measuring through librsvg also means the number is right even when the host
 * does not have the requested face: whatever it substitutes is what gets
 * measured and what gets drawn.
 */
async function measureTextInk(text, { fontSize, fontWeight, fontFamily }) {
  if (!text) return 0;

  const key = `${fontFamily}|${fontSize}|${fontWeight}|${text}`;
  const cached = textInkCache.get(key);
  if (cached !== null && cached !== undefined) return cached;

  // Room for the widest plausible face, plus a margin on each side so the trim
  // finds transparent pixels rather than the edge of the canvas.
  const margin = Math.ceil(fontSize);
  const canvasWidth = Math.min(
    MAX_MEASURE_WIDTH,
    Math.ceil(fontSize * 1.4 * (text.length + 1)) + margin * 2
  );
  const canvasHeight = Math.ceil(fontSize * 3);

  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${canvasWidth}" height="${canvasHeight}">
    <text x="${margin}" y="${Math.round(canvasHeight / 2)}" font-family="${fontFamily}"
          font-size="${fontSize}" font-weight="${fontWeight}" fill="#ffffff"
          xml:space="preserve">${escapeXml(text)}</text>
  </svg>`;

  let inkWidth;

  try {
    const { info } = await sharp(Buffer.from(svg))
      .trim({ threshold: 1 })
      .toBuffer({ resolveWithObject: true });
    inkWidth = info.width;
  } catch (err) {
    // sharp refuses to trim an image it finds uniform — a string that drew
    // nothing at all. Roughly 0.55em per character is the fallback, and a
    // box a few pixels out beats no creative.
    inkWidth = Math.round(text.length * fontSize * 0.55);
  }

  textInkCache.set(key, inkWidth);
  return inkWidth;
}

/**
 * The box a text layer occupies, in image pixels.
 *
 * Only a layer that is boxed or turned needs one; an upright, unboxed layer is
 * drawn from its top-left corner and never asks how wide it is.
 */
async function textLayoutBox(text, font, border, scaleX, scaleY) {
  const inkWidth = await measureTextInk(text, font);

  const strokeWidth = border ? Math.max(1, Math.round(border.width * scaleY)) : 0;
  const insetX = border ? Math.round((border.width + border.paddingX) * scaleX) : 0;
  const insetY = border ? Math.round((border.width + border.paddingY) * scaleY) : 0;

  return {
    width: Math.max(1, inkWidth + 2 * insetX),
    /*
     * The height comes from the font, not from this particular string. The
     * studio sets text at `line-height: 1.0`, so the line box is exactly the
     * font size tall — and deriving it that way keeps the border a constant
     * height, where measuring the ink would make the box jump the moment a
     * name happened to contain a descender.
     */
    height: Math.max(1, font.fontSize + 2 * insetY),
    insetX,
    insetY,
    strokeWidth,
  };
}

/**
 * The border rectangles for a text layer.
 *
 * SVG centres a stroke on its path where CSS draws a border inside the box, so
 * every rectangle is inset by half its own stroke — without that the studio's
 * preview and the rendered image disagree by half a border width on all four
 * sides. 'double' is drawn the way CSS draws it: two lines a third of the
 * width each, a third of the width apart.
 */
function borderRectsSvg(border, box) {
  const { x, y, width, height, strokeWidth, radius } = box;

  const rect = (inset, stroke, extra = '') => {
    const rectWidth = Math.max(1, width - 2 * inset);
    const rectHeight = Math.max(1, height - 2 * inset);
    const corner = Math.max(0, radius - inset);

    return (
      `<rect x="${x + inset}" y="${y + inset}" width="${rectWidth}" height="${rectHeight}" ` +
      `rx="${corner}" ry="${corner}" fill="none" stroke="${border.color}" ` +
      `stroke-width="${stroke}"${extra} />`
    );
  };

  if (border.style === 'double') {
    const thin = Math.max(1, strokeWidth / 3);
    return rect(thin / 2, thin) + rect(strokeWidth - thin / 2, thin);
  }

  if (border.style === 'dashed') {
    return rect(
      strokeWidth / 2,
      strokeWidth,
      ` stroke-dasharray="${strokeWidth * 3} ${strokeWidth * 2}"`
    );
  }

  if (border.style === 'dotted') {
    // A zero-length dash under a round cap is how SVG draws a round dot.
    return rect(
      strokeWidth / 2,
      strokeWidth,
      ` stroke-linecap="round" stroke-dasharray="0.01 ${strokeWidth * 1.8}"`
    );
  }

  return rect(strokeWidth / 2, strokeWidth);
}

/* ------------------------------------------------- the template row */

// Redis was already in front of the database here, but a Redis read is still a
// network round trip on a path that runs once per email open. A short memory
// copy makes the common case free, and the invalidation channel drops it on
// every worker the moment a template is saved.
const templateMemory = new LRUCache(TEMPLATE_MEMORY_SLOTS, TEMPLATE_MEMORY_SECONDS * 1000);
const templateInFlight = new SingleFlight();

const MISSING_TEMPLATE = Symbol('template-missing');

onInvalidate('template', ({ templateId }) => {
  if (templateId) templateMemory.delete(templateId);
  else templateMemory.clear();

  // Both are derived from template content, so an edit retires them as well.
  svgCache.clear();
  resizedCache.clear();
});

async function readTemplateThrough(templateId) {
  const cacheKey = `template_schema:${templateId}`;

  if (redisState.connected) {
    try {
      const cached = await redisState.client.get(cacheKey);
      if (cached) {
        const parsed = JSON.parse(cached);
        templateMemory.set(templateId, parsed);
        return parsed;
      }
    } catch (err) {
      console.warn('⚠️ Redis schema fetch error:', err.message);
    }
  }

  await ensureTemplateSchema();
  const templateData = await findTemplate(templateId);

  if (!templateData) {
    // Remembered briefly so a campaign pointing at a deleted template does not
    // send its whole audience through to MySQL.
    templateMemory.set(templateId, MISSING_TEMPLATE);
    return null;
  }

  templateMemory.set(templateId, templateData);

  if (redisState.connected) {
    redisState.client
      .set(cacheKey, JSON.stringify(templateData), 'EX', TEMPLATE_CACHE_SECONDS)
      .catch((err) => {
        console.warn('⚠️ Redis schema cache error:', err.message);
      });
  }

  return templateData;
}

/** Template row from memory, then Redis, then the database. */
async function loadTemplateSchema(templateId) {
  const fromMemory = templateMemory.get(templateId);
  if (fromMemory) return fromMemory === MISSING_TEMPLATE ? null : fromMemory;

  // One database read per template per burst, however many requests are waiting.
  return templateInFlight.run(templateId, () => readTemplateThrough(templateId));
}

/* ------------------------------------------------------ placeholders */

/**
 * The placeholder names a creative actually uses.
 *
 * This is what makes caching work for a personalised send. Cache keys
 * downstream are built from the variables in the URL, and a URL carries
 * everything the campaign happened to append — recipient ids, UTM tags,
 * tracking parameters. Keyed on all of that, no two recipients ever share a
 * cache entry, so a 256-colour palette and a full sprite bundle get rebuilt per
 * person even when the picture is byte-identical for all of them.
 *
 * Only `{{name}}` placeholders that appear in the creative can change a pixel.
 * Everything else is noise, and dropping it from the key collapses an entire
 * send back onto one entry.
 */
function placeholdersIn(value, into = new Set()) {
  if (!value) return into;

  // A local regex: PLACEHOLDER_REGEX is global and shared, and exec() advances
  // its lastIndex.
  const pattern = new RegExp(PLACEHOLDER_REGEX.source, 'g');
  let match;
  while ((match = pattern.exec(String(value))) !== null) into.add(match[1]);

  return into;
}

function templatePlaceholders(templateData) {
  const names = new Set();
  if (!templateData) return names;

  placeholdersIn(templateData.background_url, names);

  const elements = Array.isArray(templateData.elements) ? templateData.elements : [];
  elements.forEach((element) => {
    if (!element || typeof element !== 'object') return;
    placeholdersIn(element.text, names);
    placeholdersIn(element.src, names);
  });

  return names;
}

/**
 * `vars` reduced to the ones that can change the output, with keys in a fixed
 * order.
 *
 * The ordering matters as much as the filtering: `JSON.stringify` preserves
 * insertion order, so the same two parameters arriving in a different order in
 * the query string used to hash to two different cache keys.
 */
function relevantVars(vars = {}, names) {
  const out = {};
  [...names]
    .filter((name) => vars[name] !== undefined && vars[name] !== null)
    .sort()
    .forEach((name) => {
      out[name] = String(vars[name]);
    });
  return out;
}

/**
 * Composites a template's layers over its background.
 *
 * Returns the sharp pipeline unconsumed along with the background's pixel size,
 * so the caller decides the output format.
 */
async function composeTemplate(templateData, vars = {}) {
  const backgroundUrl = applyVars(templateData.background_url, vars);
  const backgroundBuffer = await loadImageBuffer(backgroundUrl);

  if (!backgroundBuffer) {
    const error = new Error('Failed to fetch background image');
    error.status = 400;
    throw error;
  }

  const metadata = await loadImageMetadata(backgroundUrl, backgroundBuffer);

  // Cheap to construct — sharp does no work until the pipeline is consumed.
  const image = sharp(backgroundBuffer);
  const origWidth = metadata.width;
  const origHeight = metadata.height;

  // The studio lays layers out against a 300px-tall preview, so a saved
  // coordinate is in preview pixels and has to be scaled up to the real image.
  const frontendHeight = 300;
  const frontendWidth = (origWidth / origHeight) * frontendHeight;
  const scaleX = origWidth / frontendWidth;
  const scaleY = origHeight / frontendHeight;

  const elements = Array.isArray(templateData.elements) ? templateData.elements : [];

  const compositeOps = await Promise.all(
    elements.map(async (element, i) => {
      if (!element || typeof element !== 'object') return null;

      const type = element.type || 'text';

      try {
        const left = Math.round((parseFloat(element.x) || 0) * scaleX);
        const top = Math.round((parseFloat(element.y) || 0) * scaleY);

        if (type === 'image') {
          const src = applyVars(element.src || '', vars);
          const imgBuffer = await loadImageBuffer(src);
          if (!imgBuffer) return null;

          // 'contain' keeps the historic behaviour (scale to fit inside the
          // box); 'cover' fills the box and crops the overflow; 'fill'
          // stretches.
          const fitMode = FIT_MODES[element.fit] || sharp.fit.inside;
          const rotation = normalizeRotation(element.rotation);

          let targetWidth = parseDimension(element.width, origWidth, scaleX);
          let targetHeight = parseDimension(element.height, origHeight, scaleY);

          /*
           * A shortfall smaller than a single canvas pixel is the studio's
           * rounding, never intent: snap it to the background edge so a layer
           * dragged to the edge covers it instead of leaving a hairline strip.
           *
           * Upright layers only. Once a layer is turned, the distance from its
           * `left` to the canvas edge says nothing about how much room it
           * needs — the turned box is a different width, and it is meant to be
           * able to hang over the edge. Resizing it to fit would shrink a
           * diagonal caption the moment it approached a corner. The overhang
           * is cropped further down instead, which is also what keeps sharp
           * from being handed an input bigger than the base image.
           */
          if (!rotation && targetWidth) {
            const maxWidth = Math.max(1, origWidth - Math.max(0, left));
            if (targetWidth >= maxWidth - Math.ceil(scaleX)) targetWidth = maxWidth;
            targetWidth = Math.min(targetWidth, maxWidth);
          }

          if (!rotation && targetHeight) {
            const maxHeight = Math.max(1, origHeight - Math.max(0, top));
            if (targetHeight >= maxHeight - Math.ceil(scaleY)) targetHeight = maxHeight;
            targetHeight = Math.min(targetHeight, maxHeight);
          }

          // Key on the resolved pixel size, not the element's own values: the
          // same box over a differently sized background resolves differently.
          // The angle joins the key because what is cached is the turned bytes.
          const resizeCacheKey = `resized:${src}:${targetWidth}x${targetHeight}:${fitMode}:${rotation}`;
          let prepared = resizedCache.get(resizeCacheKey);

          if (!prepared) {
            let buffer = imgBuffer;

            if (targetWidth || targetHeight) {
              const resizeOpts = {
                width: targetWidth || undefined,
                height: targetHeight || undefined,
                fit: fitMode,
              };

              // Only 'cover' crops, so only 'cover' needs a crop position.
              if (fitMode === sharp.fit.cover) resizeOpts.position = sharp.position.centre;

              buffer = await sharp(imgBuffer).resize(resizeOpts).toBuffer();
            }

            // The box the layer occupies before it is turned. Measured rather
            // than assumed: 'contain' can return something smaller than the box
            // it was handed, and 'auto' asks for no resize at all.
            const placed = await sharp(buffer).metadata();

            if (rotation) {
              /*
               * sharp turns an image about its centre and grows the canvas to
               * fit the corners, leaving the original centred inside a larger
               * transparent frame. PNG rather than raw, so the alpha that
               * expansion introduces survives into the composite.
               */
              const turned = await sharp(buffer)
                .rotate(rotation, { background: { r: 0, g: 0, b: 0, alpha: 0 } })
                .png()
                .toBuffer({ resolveWithObject: true });

              prepared = {
                buffer: turned.data,
                width: turned.info.width,
                height: turned.info.height,
                boxWidth: placed.width,
                boxHeight: placed.height,
              };
            } else {
              prepared = {
                buffer,
                width: placed.width,
                height: placed.height,
                boxWidth: placed.width,
                boxHeight: placed.height,
              };
            }

            resizedCache.set(resizeCacheKey, prepared);
          }

          /*
           * A rotation leaves exactly one point alone — the centre — so the
           * expanded frame is placed with its centre where the upright box's
           * centre would have been. At zero degrees the two boxes are the same
           * size and this reduces to (left, top), so an existing template
           * renders byte-identically.
           */
          let placeLeft = Math.round(left + (prepared.boxWidth - prepared.width) / 2);
          let placeTop = Math.round(top + (prepared.boxHeight - prepared.height) / 2);

          let input = prepared.buffer;

          /*
           * A turned layer can hang off the edge of the picture, and sharp
           * accepts neither a negative offset nor an input running past the
           * canvas. The overhang is cropped away rather than the layer being
           * nudged back inside, because nudging would silently move a creative
           * the studio showed hanging off the edge.
           */
          const overhangs =
            placeLeft < 0 ||
            placeTop < 0 ||
            placeLeft + prepared.width > origWidth ||
            placeTop + prepared.height > origHeight;

          if (overhangs) {
            const cropLeft = Math.max(0, -placeLeft);
            const cropTop = Math.max(0, -placeTop);
            const cropWidth = Math.min(prepared.width - cropLeft, origWidth - Math.max(0, placeLeft));
            const cropHeight = Math.min(prepared.height - cropTop, origHeight - Math.max(0, placeTop));

            // Entirely outside the picture — there is nothing left to draw.
            if (cropWidth <= 0 || cropHeight <= 0) return null;

            input = await sharp(input)
              .extract({ left: cropLeft, top: cropTop, width: cropWidth, height: cropHeight })
              .png()
              .toBuffer();

            placeLeft = Math.max(0, placeLeft);
            placeTop = Math.max(0, placeTop);
          }

          return { input, left: placeLeft, top: placeTop };
        }

        const text = applyVars(element.text || '', vars);
        const fontSize = Math.round((parseInt(element.fontSize, 10) || 24) * scaleY);
        const fontWeight = sanitizeFontWeight(element.fontWeight);
        const color = sanitizeColor(element.color, '#000000');
        const fontFamily = sanitizeFontFamily(element.fontFamily);

        const rotation = normalizeRotation(element.rotation);
        const border = textBorderOf(element);

        /*
         * Deliberately not clamped to the canvas. A turned layer legitimately
         * sits partly outside it — running a caption off the edge of a
         * vertical creative is the point — and SVG clips at the viewport just
         * as the studio's canvas does. Clamping here would drag such a layer
         * back inside and disagree with the preview.
         */
        const boxLeft = left;
        const boxTop = top;

        /*
         * Only a boxed or turned layer needs to know its own size, and working
         * it out costs a measuring render. An upright, unboxed layer skips all
         * of it and is drawn from its corner exactly as it always was.
         */
        const box =
          border || rotation
            ? await textLayoutBox(text, { fontSize, fontWeight, fontFamily }, border, scaleX, scaleY)
            : null;

        const boxWidth = box ? box.width : 0;
        const boxHeight = box ? box.height : 0;

        const borderKey = border
          ? `${border.style},${border.width},${border.color},${border.radius},` +
            `${border.paddingX},${border.paddingY}`
          : 'none';

        const svgCacheKey =
          `svg:${i}:${text}:${fontSize}:${fontWeight}:${fontFamily}:${color}:` +
          `${origWidth}x${origHeight}:${boxLeft},${boxTop}:` +
          `${rotation}:${borderKey}:${boxWidth}x${boxHeight}`;

        let svgBuffer = svgCache.get(svgCacheKey);

        if (!svgBuffer) {
          const rects = border
            ? borderRectsSvg(border, {
                x: boxLeft,
                y: boxTop,
                width: boxWidth,
                height: boxHeight,
                strokeWidth: box.strokeWidth,
                radius: Math.round(border.radius * scaleX),
              })
            : '';

          /*
           * Inside a border the text is centred in the box rather than set
           * from its left edge. The box is built around the measured string,
           * so centring is what makes the padding read as even on both sides
           * whatever value was substituted in — and it absorbs the left side
           * bearing, which a start-anchored string would push to one side.
           */
          const anchor = border
            ? `x="${boxLeft + boxWidth / 2}" text-anchor="middle"`
            : `x="${boxLeft}"`;

          /*
           * The whole layer turns together — the border box and the text
           * inside it — about the box centre, which is the point the studio's
           * `transform-origin: 50% 50%` uses. An unrotated layer gets no
           * transform at all, so its output is unchanged from before rotation
           * existed.
           */
          const transform = rotation
            ? ` transform="rotate(${rotation} ${boxLeft + boxWidth / 2} ${boxTop + boxHeight / 2})"`
            : '';

          svgBuffer = Buffer.from(`
            <svg width="${origWidth}" height="${origHeight}" xmlns="http://www.w3.org/2000/svg">
              <g${transform}>
                ${rects}
                <text
                  ${anchor}
                  y="${boxTop + (box ? box.insetY : 0)}"
                  dy="0.85em"
                  font-size="${fontSize}"
                  font-weight="${fontWeight}"
                  font-family="${fontFamily}"
                  fill="${color}"
                >${escapeXml(text)}</text>
              </g>
            </svg>
          `);
          svgCache.set(svgCacheKey, svgBuffer);
        }

        return { input: svgBuffer, blend: 'over' };
      } catch (elementErr) {
        console.warn(`Element rendering warning ${i}:`, elementErr.message);
        return null;
      }
    })
  );

  const validOps = compositeOps.filter((op) => op !== null);

  return {
    pipeline: validOps.length > 0 ? image.composite(validOps) : image,
    width: origWidth,
    height: origHeight,
  };
}

/** Loads a template and composites it in one step. Throws a 404-tagged error if it is gone. */
async function renderTemplate(templateId, vars = {}) {
  const templateData = await loadTemplateSchema(templateId);

  if (!templateData) {
    const error = new Error('Template not found');
    error.status = 404;
    throw error;
  }

  return composeTemplate(templateData, vars);
}

/** A bare background image with no layers — for creatives that are a single flat file. */
async function renderBackgroundOnly(backgroundUrl, vars = {}) {
  return composeTemplate({ background_url: backgroundUrl, elements: [] }, vars);
}

module.exports = {
  collectVars,
  applyVars,
  escapeXml,
  loadTemplateSchema,
  placeholdersIn,
  templatePlaceholders,
  relevantVars,
  composeTemplate,
  renderTemplate,
  renderBackgroundOnly,
};

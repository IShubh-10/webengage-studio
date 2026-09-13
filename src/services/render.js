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

          let targetWidth = parseDimension(element.width, origWidth, scaleX);
          let targetHeight = parseDimension(element.height, origHeight, scaleY);

          // A shortfall smaller than a single canvas pixel is the studio's
          // rounding, never intent: snap it to the background edge so a layer
          // dragged to the edge covers it instead of leaving a hairline strip.
          // Oversize boxes are clamped because sharp refuses to composite an
          // input larger than the base image.
          if (targetWidth) {
            const maxWidth = Math.max(1, origWidth - Math.max(0, left));
            if (targetWidth >= maxWidth - Math.ceil(scaleX)) targetWidth = maxWidth;
            targetWidth = Math.min(targetWidth, maxWidth);
          }

          if (targetHeight) {
            const maxHeight = Math.max(1, origHeight - Math.max(0, top));
            if (targetHeight >= maxHeight - Math.ceil(scaleY)) targetHeight = maxHeight;
            targetHeight = Math.min(targetHeight, maxHeight);
          }

          // Key on the resolved pixel size, not the element's own values: the
          // same box over a differently sized background resolves differently.
          const resizeCacheKey = `resized:${src}:${targetWidth}x${targetHeight}:${fitMode}`;
          let inputBuffer = resizedCache.get(resizeCacheKey);

          if (!inputBuffer) {
            if (targetWidth || targetHeight) {
              const resizeOpts = {
                width: targetWidth || undefined,
                height: targetHeight || undefined,
                fit: fitMode,
              };

              // Only 'cover' crops, so only 'cover' needs a crop position.
              if (fitMode === sharp.fit.cover) resizeOpts.position = sharp.position.centre;

              inputBuffer = await sharp(imgBuffer).resize(resizeOpts).toBuffer();
            } else {
              inputBuffer = imgBuffer;
            }

            resizedCache.set(resizeCacheKey, inputBuffer);
          }

          return { input: inputBuffer, left: Math.max(0, left), top: Math.max(0, top) };
        }

        const text = applyVars(element.text || '', vars);
        const fontSize = Math.round((parseInt(element.fontSize, 10) || 24) * scaleY);
        const fontWeight = element.fontWeight || 'normal';
        const color = element.color || '#000000';
        const fontFamily = element.fontFamily || 'Arial';

        const svgCacheKey = `svg:${i}:${text}:${fontSize}:${fontWeight}:${fontFamily}:${color}:${origWidth}x${origHeight}:${left},${top}`;
        let svgBuffer = svgCache.get(svgCacheKey);

        if (!svgBuffer) {
          svgBuffer = Buffer.from(`
            <svg width="${origWidth}" height="${origHeight}" xmlns="http://www.w3.org/2000/svg">
              <text
                x="${Math.max(0, left)}"
                y="${Math.max(0, top)}"
                dy="0.85em"
                font-size="${fontSize}"
                font-weight="${fontWeight}"
                font-family="${fontFamily}"
                fill="${color}"
              >${escapeXml(text)}</text>
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

/**
 * The expensive half of a countdown, done once and then reused.
 *
 * Rendering a creative, choosing a 256-colour palette and rasterising glyphs
 * costs a few hundred milliseconds. Doing that per email open would not survive
 * a real send. But none of it depends on the time: the artwork is fixed, and
 * there are only ten possible pictures for any one digit position. So this
 * builds, once per (creative + styling) combination:
 *
 *   - the background as palette indices, with the plate, separators and labels
 *     already baked in, because none of those change while the clock runs
 *   - for every digit slot, ten small tiles — that slot's patch of background
 *     with a 0..9 drawn over it, already quantised against the same palette
 *   - the expired card, pre-encoded as a ready-to-append GIF frame
 *
 * Serving a request is then index copying and LZW, with no colour work at all.
 * The bundle lives in an in-process LRU and in Redis, so a cold worker pays the
 * build cost once rather than every restart.
 */

const crypto = require('crypto');
const sharp = require('sharp');

const redisState = require('../../config/redis').state;
const { LRUCache } = require('../../lib/cache');
const { SingleFlight } = require('../../lib/singleflight');
const { withRedisLock } = require('../../lib/redisOps');
const { onInvalidate } = require('../../lib/invalidation');
const { encodeFrameBlock } = require('../../lib/gif');
const { ColorHistogram, buildPalette } = require('../../lib/quantize');
const { renderTemplate, renderBackgroundOnly, escapeXml } = require('../render');
const { loadImageBuffer } = require('../images');
const {
  buildLayout,
  staticOverlaySvg,
  digitAtlasSvg,
  sanitizeFontFamily,
  plateRects,
  plateSvg,
} = require('./layout');
const {
  TIMER_MAX_CANVAS_WIDTH,
  TIMER_SPRITE_TTL_SECONDS,
  TIMER_SPRITE_MEMORY_SLOTS,
  TIMER_SPRITE_LOCK_MS,
  TIMER_SPRITE_LOCK_WAIT_MS,
} = require('../../config');

const memoryBundles = new LRUCache(TIMER_SPRITE_MEMORY_SLOTS);

/** Alpha-composite `src` RGBA over `dst` RGBA in place. Both are the same size. */
function compositeOver(dst, src) {
  for (let i = 0; i < dst.length; i += 4) {
    const alpha = src[i + 3];
    if (alpha === 0) continue;

    if (alpha === 255) {
      dst[i] = src[i];
      dst[i + 1] = src[i + 1];
      dst[i + 2] = src[i + 2];
      continue;
    }

    const a = alpha / 255;
    const inverse = 1 - a;
    dst[i] = Math.round(src[i] * a + dst[i] * inverse);
    dst[i + 1] = Math.round(src[i + 1] * a + dst[i + 1] * inverse);
    dst[i + 2] = Math.round(src[i + 2] * a + dst[i + 2] * inverse);
  }
}

/** Copy a rectangle out of a full-canvas RGBA buffer. */
function cropRGBA(source, canvasWidth, rect) {
  const out = new Uint8Array(rect.width * rect.height * 4);

  for (let y = 0; y < rect.height; y++) {
    const from = ((rect.top + y) * canvasWidth + rect.left) * 4;
    out.set(source.subarray(from, from + rect.width * 4), y * rect.width * 4);
  }

  return out;
}

/** Copy one cell out of the ten-digit atlas. */
function cropAtlasCell(atlas, atlasWidth, digit, cellWidth, cellHeight) {
  return cropRGBA(atlas, atlasWidth, {
    left: digit * cellWidth,
    top: 0,
    width: cellWidth,
    height: cellHeight,
  });
}

function hexToRgb(color) {
  const match = /^#?([0-9a-fA-F]{6})$/.exec(String(color).replace('#', '#'));
  if (match) {
    const value = parseInt(match[1], 16);
    return { r: (value >> 16) & 255, g: (value >> 8) & 255, b: value & 255 };
  }

  const short = /^#?([0-9a-fA-F]{3})$/.exec(String(color));
  if (short) {
    const [r, g, b] = short[1].split('');
    return { r: parseInt(r + r, 16), g: parseInt(g + g, 16), b: parseInt(b + b, 16) };
  }

  return null;
}

/** The creative itself, as RGBA at the size the GIF will be. */
async function renderCreative(timer, vars) {
  const { templateId, backgroundUrl } = timer.source;

  const composed = templateId
    ? await renderTemplate(templateId, vars)
    : await renderBackgroundOnly(backgroundUrl, vars);

  // sharp resizes before it composites whatever the call order, so scaling the
  // creative has to happen to the finished picture: draw the layers at their
  // own resolution first, then scale the result.
  const drawn = await composed.pipeline.raw().toBuffer({ resolveWithObject: true });

  let pipeline = sharp(drawn.data, {
    raw: { width: drawn.info.width, height: drawn.info.height, channels: drawn.info.channels },
  });

  const requested = timer.canvasWidth || drawn.info.width;
  const targetWidth = Math.min(requested, TIMER_MAX_CANVAS_WIDTH);

  if (targetWidth !== drawn.info.width) {
    pipeline = pipeline.resize({ width: targetWidth, withoutEnlargement: false });
  }

  const { data, info } = await pipeline
    // GIF has one transparency slot and email clients disagree about it, so the
    // creative is flattened onto a solid colour the sender picks.
    .flatten({ background: timer.background })
    .ensureAlpha()
    .raw()
    .toBuffer({ resolveWithObject: true });

  return { pixels: new Uint8Array(data.buffer, data.byteOffset, data.length), width: info.width, height: info.height };
}

/** The picture shown once the deadline has passed. */
async function renderExpiredCanvas(timer, creative, layout) {
  const { width, height } = creative;
  const canvas = new Uint8Array(creative.pixels);

  if (timer.expired.mode === 'image' && timer.expired.imageUrl) {
    const buffer = await loadImageBuffer(timer.expired.imageUrl);
    if (buffer) {
      const { data } = await sharp(buffer)
        .resize({ width, height, fit: sharp.fit.cover, position: sharp.position.centre })
        .flatten({ background: timer.background })
        .ensureAlpha()
        .raw()
        .toBuffer({ resolveWithObject: true });
      canvas.set(new Uint8Array(data.buffer, data.byteOffset, data.length));
      return canvas;
    }
    // Fall through to the message if the image cannot be fetched, rather than
    // showing a live-looking timer that has already run out.
  }

  const family = escapeXml(
    sanitizeFontFamily(timer.expired.fontFamily || timer.style.fontFamily)
  );
  const centerX = layout.left + layout.width / 2;
  const centerY = layout.top + layout.height / 2;

  // The expired message spans the whole block, so it always sits on a single
  // panel — four unit tiles behind one headline would read as leftover
  // furniture from the clock that is no longer there.
  const parts = plateSvg(plateRects(layout, timer.style, { forceBlock: true }), timer.style);

  parts.push(
    `<text x="${centerX}" y="${centerY}" text-anchor="middle" dominant-baseline="central" ` +
      `font-family="${family}" font-size="${timer.expired.fontSize}" ` +
      `font-weight="${timer.expired.fontWeight}" fill="${timer.expired.color}">${escapeXml(timer.expired.text)}</text>`
  );

  const { data } = await sharp(
    Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${width}" height="${height}">${parts.join('')}</svg>`)
  )
    .raw()
    .toBuffer({ resolveWithObject: true });

  compositeOver(canvas, new Uint8Array(data.buffer, data.byteOffset, data.length));
  return canvas;
}

/**
 * Builds everything the frame assembler needs.
 *
 * `leadDigits` is a parameter rather than something derived here because it
 * changes the geometry: a timer showing 5 days and one showing 120 days need
 * different slot counts, and each gets its own bundle.
 */
async function buildBundle(timer, vars, leadDigits) {
  const creative = await renderCreative(timer, vars);

  const layout = await buildLayout({
    style: timer.style,
    canvasWidth: creative.width,
    canvasHeight: creative.height,
    leadDigits,
  });

  // Anything drawn outside the canvas would corrupt neighbouring rows when the
  // tiles are blitted, so the block has to actually fit.
  const fits =
    layout.left >= 0 &&
    layout.top >= 0 &&
    layout.left + layout.width <= creative.width &&
    layout.top + layout.height <= creative.height;

  if (!fits) {
    const error = new Error(
      'The timer block falls outside the creative — move it, or reduce the font size'
    );
    error.status = 400;
    throw error;
  }

  // 1. Bake the parts that never change into the background.
  const background = new Uint8Array(creative.pixels);
  const overlay = staticOverlaySvg(layout, timer.style, creative.width, creative.height);

  if (overlay) {
    const { data } = await sharp(overlay).raw().toBuffer({ resolveWithObject: true });
    compositeOver(background, new Uint8Array(data.buffer, data.byteOffset, data.length));
  }

  // 2. Rasterise the ten digits once.
  const atlasWidth = layout.digitWidth * 10;
  const { data: atlasData } = await sharp(digitAtlasSvg(layout, timer.style))
    .raw()
    .toBuffer({ resolveWithObject: true });
  const atlas = new Uint8Array(atlasData.buffer, atlasData.byteOffset, atlasData.length);

  const digitCells = [];
  for (let digit = 0; digit <= 9; digit++) {
    digitCells.push(cropAtlasCell(atlas, atlasWidth, digit, layout.digitWidth, layout.digitHeight));
  }

  // 3. Every possible tile: each slot's backdrop with each digit drawn on it.
  const tileRGBA = layout.slots.map((slot) => {
    const backdrop = cropRGBA(background, creative.width, slot);
    return digitCells.map((cell) => {
      const tile = new Uint8Array(backdrop);
      compositeOver(tile, cell);
      return tile;
    });
  });

  const expiredRGBA =
    timer.expired.mode === 'freeze' ? null : await renderExpiredCanvas(timer, creative, layout);

  // 4. One palette for all of it, so a tile can be dropped into the canvas at
  //    request time without any colour matching.
  const histogram = new ColorHistogram();
  histogram.addRGBA(background);
  tileRGBA.forEach((slotTiles) => slotTiles.forEach((tile) => histogram.addRGBA(tile)));
  if (expiredRGBA) histogram.addRGBA(expiredRGBA);

  const reserved = [
    hexToRgb(timer.style.color),
    hexToRgb(timer.style.separatorColor),
    hexToRgb(timer.style.labelColor),
    hexToRgb(timer.expired.color),
  ].filter(Boolean);

  const mapper = buildPalette(histogram, timer.colors, reserved);

  const baseIndices = mapper.mapRGBA(background);
  const tileSize = layout.digitWidth * layout.digitHeight;

  const tiles = tileRGBA.map((slotTiles) => {
    const packed = new Uint8Array(tileSize * 10);
    slotTiles.forEach((tile, digit) => packed.set(mapper.mapRGBA(tile), digit * tileSize));
    return packed;
  });

  const minCodeSize = Math.max(2, Math.ceil(Math.log2(Math.max(2, mapper.size))));

  const expiredBlock = expiredRGBA
    ? encodeFrameBlock({
        indices: mapper.mapRGBA(expiredRGBA),
        left: 0,
        top: 0,
        width: creative.width,
        height: creative.height,
        delayMs: 1000,
        minCodeSize,
      })
    : null;

  return {
    width: creative.width,
    height: creative.height,
    palette: mapper.palette,
    minCodeSize,
    baseIndices,
    slots: layout.slots.map(({ unit, position, power, left, top, width, height }) => ({
      unit,
      position,
      power,
      left,
      top,
      width,
      height,
    })),
    tileWidth: layout.digitWidth,
    tileHeight: layout.digitHeight,
    tiles,
    expiredBlock,
    leadDigits,
  };
}

/* -------------------------------------------------------------- caching */

// Only what changes the pixels belongs in the key. The deadline deliberately
// does not: two campaigns ending at different times but drawn identically share
// one bundle, and the clock is applied per request.
function bundleCacheKey(timer, vars, leadDigits) {
  const shape = {
    source: timer.source,
    canvasWidth: timer.canvasWidth,
    background: timer.background,
    colors: timer.colors,
    style: timer.style,
    expired: timer.expired,
    vars,
    leadDigits,
  };

  return `timer:sprites:${crypto.createHash('md5').update(JSON.stringify(shape)).digest('hex')}`;
}

/** Bundle to a single buffer: a JSON header, then the binary parts back to back. */
function packBundle(bundle) {
  const header = Buffer.from(
    JSON.stringify({
      width: bundle.width,
      height: bundle.height,
      minCodeSize: bundle.minCodeSize,
      paletteBytes: bundle.palette.length,
      baseBytes: bundle.baseIndices.length,
      tileWidth: bundle.tileWidth,
      tileHeight: bundle.tileHeight,
      tileBytes: bundle.tiles.length ? bundle.tiles[0].length : 0,
      tileCount: bundle.tiles.length,
      expiredBytes: bundle.expiredBlock ? bundle.expiredBlock.length : 0,
      slots: bundle.slots,
      leadDigits: bundle.leadDigits,
    }),
    'utf8'
  );

  const headerLength = Buffer.allocUnsafe(4);
  headerLength.writeUInt32LE(header.length, 0);

  return Buffer.concat([
    headerLength,
    header,
    Buffer.from(bundle.palette.buffer, bundle.palette.byteOffset, bundle.palette.length),
    Buffer.from(bundle.baseIndices.buffer, bundle.baseIndices.byteOffset, bundle.baseIndices.length),
    ...bundle.tiles.map((tile) => Buffer.from(tile.buffer, tile.byteOffset, tile.length)),
    bundle.expiredBlock || Buffer.alloc(0),
  ]);
}

function unpackBundle(buffer) {
  const headerLength = buffer.readUInt32LE(0);
  const header = JSON.parse(buffer.subarray(4, 4 + headerLength).toString('utf8'));

  let cursor = 4 + headerLength;
  const take = (length) => {
    const slice = buffer.subarray(cursor, cursor + length);
    cursor += length;
    return new Uint8Array(slice);
  };

  const palette = take(header.paletteBytes);
  const baseIndices = take(header.baseBytes);
  const tiles = [];
  for (let i = 0; i < header.tileCount; i++) tiles.push(take(header.tileBytes));
  const expiredBlock = header.expiredBytes
    ? Buffer.from(buffer.subarray(cursor, cursor + header.expiredBytes))
    : null;

  return {
    width: header.width,
    height: header.height,
    palette,
    minCodeSize: header.minCodeSize,
    baseIndices,
    slots: header.slots,
    tileWidth: header.tileWidth,
    tileHeight: header.tileHeight,
    tiles,
    expiredBlock,
    leadDigits: header.leadDigits,
  };
}

// Concurrent opens of a brand-new campaign all miss at once; without this every
// one of them would build the same bundle in parallel and pin the CPU.
const inFlight = new SingleFlight();

async function readPacked(key) {
  if (!redisState.connected) return null;

  try {
    const packed = await redisState.client.getBuffer(key);
    return packed ? unpackBundle(packed) : null;
  } catch (err) {
    console.warn('⚠️ Redis timer sprite read error:', err.message);
    return null;
  }
}

async function buildAndStore(timer, vars, leadDigits, key) {
  const bundle = await buildBundle(timer, vars, leadDigits);

  if (redisState.connected) {
    redisState.client
      .set(key, packBundle(bundle), 'EX', TIMER_SPRITE_TTL_SECONDS)
      .catch((err) => console.warn('⚠️ Redis timer sprite write error:', err.message));
  }

  return bundle;
}

async function getBundle(timer, vars, leadDigits) {
  const key = bundleCacheKey(timer, vars, leadDigits);

  const fromMemory = memoryBundles.get(key);
  if (fromMemory) return fromMemory;

  return inFlight.run(key, async () => {
    const cached = await readPacked(key);
    if (cached) {
      memoryBundles.set(key, cached);
      return cached;
    }

    // inFlight only covers this process. In production there is one process per
    // core, and on a cold cache all of them miss the same key in the same
    // second — so without a lock shared between them, a restart or a new
    // campaign costs one ~450ms CPU build per worker, simultaneously, on a box
    // that has exactly that many cores. One builds; the rest wait for it and
    // read the result it writes.
    const { value } = await withRedisLock(`${key}:lock`, {
      ttlMs: TIMER_SPRITE_LOCK_MS,
      waitMs: TIMER_SPRITE_LOCK_WAIT_MS,
      read: () => readPacked(key),
      build: () => buildAndStore(timer, vars, leadDigits, key),
    });

    memoryBundles.set(key, value);
    return value;
  });
}

function clearBundles() {
  memoryBundles.clear();
}

// A timer's styling changed somewhere in the cluster: this worker's bundles were
// built from the old definition, so they go too.
onInvalidate('timer', () => clearBundles());

module.exports = { getBundle, buildBundle, bundleCacheKey, packBundle, unpackBundle, clearBundles };

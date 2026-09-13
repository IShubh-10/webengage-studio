/**
 * Median-cut colour quantisation: RGB pixels in, a <=256 colour palette and
 * per-pixel indices out.
 *
 * The countdown encoder quantises the creative and every possible digit tile
 * together, in one pass, so that a digit blitted into the canvas at request
 * time lands on colours that already exist in the shared palette. That is what
 * lets the per-second frames be plain index copies with no colour work at all.
 *
 * Colours are histogrammed at 6 bits per channel (262,144 buckets). The bucket
 * only decides how colours are grouped — each palette entry is the exact
 * average of the true 8-bit colours that fell into it, so flat artwork comes
 * back essentially lossless. Photographic backgrounds will band a little; that
 * is the nature of a 256-colour format, and `colors` can be lowered to trade
 * palette size for file size.
 */

const BITS = 6;
const LEVELS = 1 << BITS; // 64 levels per channel
const BUCKETS = LEVELS * LEVELS * LEVELS;
const SHIFT = 8 - BITS;

function bucketOf(r, g, b) {
  return ((r >> SHIFT) << (BITS * 2)) | ((g >> SHIFT) << BITS) | (b >> SHIFT);
}

/**
 * A histogram fed from one or more RGB/RGBA sources. Kept separate from the
 * quantiser itself so a caller can accumulate the base image and every digit
 * tile before any palette is chosen.
 */
class ColorHistogram {
  constructor() {
    this.counts = new Uint32Array(BUCKETS);
    this.sumR = new Float64Array(BUCKETS);
    this.sumG = new Float64Array(BUCKETS);
    this.sumB = new Float64Array(BUCKETS);
    this.occupied = 0;
  }

  /** `pixels` is RGBA; alpha is ignored (callers flatten before quantising). */
  addRGBA(pixels) {
    const { counts, sumR, sumG, sumB } = this;

    for (let i = 0; i < pixels.length; i += 4) {
      const r = pixels[i];
      const g = pixels[i + 1];
      const b = pixels[i + 2];
      const bucket = bucketOf(r, g, b);

      if (counts[bucket] === 0) this.occupied++;
      counts[bucket]++;
      sumR[bucket] += r;
      sumG[bucket] += g;
      sumB[bucket] += b;
    }
  }
}

function boxStats(bucketList, from, to, histogram) {
  let count = 0;
  let rMin = 255;
  let rMax = 0;
  let gMin = 255;
  let gMax = 0;
  let bMin = 255;
  let bMax = 0;

  for (let i = from; i <= to; i++) {
    const bucket = bucketList[i];
    count += histogram.counts[bucket];

    const r = (bucket >> (BITS * 2)) & (LEVELS - 1);
    const g = (bucket >> BITS) & (LEVELS - 1);
    const b = bucket & (LEVELS - 1);

    if (r < rMin) rMin = r;
    if (r > rMax) rMax = r;
    if (g < gMin) gMin = g;
    if (g > gMax) gMax = g;
    if (b < bMin) bMin = b;
    if (b > bMax) bMax = b;
  }

  return {
    from,
    to,
    count,
    // Weighted by rough perceptual sensitivity, so a green spread splits before
    // an equally wide blue one.
    score: count * Math.max((rMax - rMin) * 1.2, (gMax - gMin) * 1.5, (bMax - bMin) * 0.9),
    ranges: [
      { channel: 0, span: (rMax - rMin) * 1.2 },
      { channel: 1, span: (gMax - gMin) * 1.5 },
      { channel: 2, span: (bMax - bMin) * 0.9 },
    ],
  };
}

function channelOf(bucket, channel) {
  if (channel === 0) return (bucket >> (BITS * 2)) & (LEVELS - 1);
  if (channel === 1) return (bucket >> BITS) & (LEVELS - 1);
  return bucket & (LEVELS - 1);
}

/**
 * Chooses a palette and returns it alongside a mapper.
 *
 * `reserved` colours are forced into the palette whatever the histogram says —
 * the countdown uses it for the digit colour, so text stays exact even when the
 * artwork behind it dominates the histogram.
 */
function buildPalette(histogram, maxColors = 256, reserved = []) {
  const reservedList = reserved
    .filter(Boolean)
    .slice(0, Math.max(0, maxColors - 1))
    .map(({ r, g, b }) => ({ r: r & 0xff, g: g & 0xff, b: b & 0xff }));

  const budget = Math.max(2, maxColors - reservedList.length);

  const bucketList = new Int32Array(histogram.occupied);
  let cursor = 0;
  for (let bucket = 0; bucket < BUCKETS; bucket++) {
    if (histogram.counts[bucket] !== 0) bucketList[cursor++] = bucket;
  }

  let boxes = [];
  if (cursor > 0) boxes.push(boxStats(bucketList, 0, cursor - 1, histogram));

  while (boxes.length > 0 && boxes.length < budget) {
    // Split whichever box is doing the most damage: many pixels spread widely.
    let target = -1;
    let best = 0;
    for (let i = 0; i < boxes.length; i++) {
      const box = boxes[i];
      if (box.from === box.to) continue; // a single bucket cannot split further
      if (box.score > best) {
        best = box.score;
        target = i;
      }
    }
    if (target === -1) break;

    const box = boxes[target];
    const channel = box.ranges.reduce((a, b) => (b.span > a.span ? b : a)).channel;

    const slice = Array.from(bucketList.subarray(box.from, box.to + 1));
    slice.sort((a, b) => channelOf(a, channel) - channelOf(b, channel));
    bucketList.set(slice, box.from);

    // Cut at the population median so both halves carry similar pixel counts.
    const half = box.count / 2;
    let running = 0;
    let cut = box.from;
    for (let i = box.from; i < box.to; i++) {
      running += histogram.counts[bucketList[i]];
      cut = i;
      if (running >= half) break;
    }

    boxes.splice(
      target,
      1,
      boxStats(bucketList, box.from, cut, histogram),
      boxStats(bucketList, cut + 1, box.to, histogram)
    );
  }

  const paletteLength = reservedList.length + boxes.length;
  const palette = new Uint8Array(paletteLength * 3);

  reservedList.forEach((color, i) => {
    palette[i * 3] = color.r;
    palette[i * 3 + 1] = color.g;
    palette[i * 3 + 2] = color.b;
  });

  // -1 means "not decided yet"; buckets inside a box are filled in below, and
  // anything else is resolved by nearest-colour search the first time it is
  // asked for.
  const bucketToIndex = new Int16Array(BUCKETS).fill(-1);

  boxes.forEach((box, boxIndex) => {
    const paletteIndex = reservedList.length + boxIndex;
    let count = 0;
    let r = 0;
    let g = 0;
    let b = 0;

    for (let i = box.from; i <= box.to; i++) {
      const bucket = bucketList[i];
      count += histogram.counts[bucket];
      r += histogram.sumR[bucket];
      g += histogram.sumG[bucket];
      b += histogram.sumB[bucket];
      bucketToIndex[bucket] = paletteIndex;
    }

    palette[paletteIndex * 3] = count ? Math.round(r / count) : 0;
    palette[paletteIndex * 3 + 1] = count ? Math.round(g / count) : 0;
    palette[paletteIndex * 3 + 2] = count ? Math.round(b / count) : 0;
  });

  // A reserved colour whose bucket nothing else claimed should map to itself,
  // so pure text pixels never drift into a near neighbour.
  reservedList.forEach((color, i) => {
    bucketToIndex[bucketOf(color.r, color.g, color.b)] = i;
  });

  return new PaletteMapper(palette, bucketToIndex);
}

class PaletteMapper {
  constructor(palette, bucketToIndex) {
    this.palette = palette;
    this.size = palette.length / 3;
    this.bucketToIndex = bucketToIndex;
  }

  indexOf(r, g, b) {
    const bucket = bucketOf(r, g, b);
    const known = this.bucketToIndex[bucket];
    if (known >= 0) return known;

    let best = 0;
    let bestDistance = Infinity;
    for (let i = 0; i < this.size; i++) {
      const dr = r - this.palette[i * 3];
      const dg = g - this.palette[i * 3 + 1];
      const db = b - this.palette[i * 3 + 2];
      const distance = dr * dr * 2 + dg * dg * 4 + db * db;
      if (distance < bestDistance) {
        bestDistance = distance;
        best = i;
      }
    }

    this.bucketToIndex[bucket] = best;
    return best;
  }

  /** RGBA pixels to one palette index per pixel. */
  mapRGBA(pixels, out = new Uint8Array(pixels.length / 4)) {
    for (let i = 0, p = 0; i < pixels.length; i += 4, p++) {
      out[p] = this.indexOf(pixels[i], pixels[i + 1], pixels[i + 2]);
    }
    return out;
  }
}

module.exports = { ColorHistogram, buildPalette, PaletteMapper };

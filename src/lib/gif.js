/**
 * A GIF89a writer, written here rather than pulled in as a dependency because
 * the countdown endpoint needs one specific trick no general-purpose encoder
 * exposes: per-frame sub-rectangles over a shared global palette.
 *
 * A countdown frame differs from the one before it only in the handful of
 * pixels where a digit changed. GIF has supported partial frames since 1989 —
 * each frame carries its own left/top/width/height and a disposal method of
 * "leave in place" — so the seconds digit ticking over costs a ~40x60 block
 * instead of a re-encode of the whole creative. That is the difference between
 * ~10ms and ~400ms of CPU per email open.
 *
 * Everything here works on palette indices; see lib/quantize.js for turning
 * RGB pixels into them.
 */

const HEADER = Buffer.from('GIF89a', 'ascii');
const TRAILER = Buffer.from([0x3b]);

// "Leave the frame in place and draw the next one over it" — what makes
// partial frames accumulate into a whole image instead of flashing.
const DISPOSAL_NONE = 1;

/**
 * Collects LZW codes as a bit stream and emits them as GIF sub-blocks (each at
 * most 255 bytes, terminated by a zero-length block).
 */
class BlockStream {
  constructor() {
    this.chunks = [];
    this.block = Buffer.allocUnsafe(255);
    this.blockLength = 0;
    this.accumulator = 0;
    this.accumulatorBits = 0;
  }

  writeCode(code, codeSize) {
    // codeSize maxes out at 12 and fewer than 8 bits are ever pending, so the
    // accumulator stays inside 32-bit integer territory.
    this.accumulator |= code << this.accumulatorBits;
    this.accumulatorBits += codeSize;

    while (this.accumulatorBits >= 8) {
      this.writeByte(this.accumulator & 0xff);
      this.accumulator >>>= 8;
      this.accumulatorBits -= 8;
    }
  }

  writeByte(byte) {
    this.block[this.blockLength++] = byte;
    if (this.blockLength === 255) this.flushBlock();
  }

  flushBlock() {
    if (this.blockLength === 0) return;
    this.chunks.push(Buffer.from([this.blockLength]));
    this.chunks.push(Buffer.from(this.block.subarray(0, this.blockLength)));
    this.blockLength = 0;
  }

  finish() {
    if (this.accumulatorBits > 0) {
      this.writeByte(this.accumulator & 0xff);
      this.accumulator = 0;
      this.accumulatorBits = 0;
    }
    this.flushBlock();
    this.chunks.push(Buffer.from([0x00])); // block terminator
    return Buffer.concat(this.chunks);
  }
}

/**
 * Variable-width LZW as the GIF spec defines it: a dictionary seeded with the
 * palette, a clear code, and an end-of-information code.
 */
function lzwCompress(indices, minCodeSize) {
  const clearCode = 1 << minCodeSize;
  const endCode = clearCode + 1;

  const stream = new BlockStream();
  let dictionary = new Map();
  let nextCode = endCode + 1;
  let codeSize = minCodeSize + 1;

  stream.writeCode(clearCode, codeSize);

  if (indices.length === 0) {
    stream.writeCode(endCode, codeSize);
    return stream.finish();
  }

  let prefix = indices[0];

  for (let i = 1; i < indices.length; i++) {
    const next = indices[i];
    const key = (prefix << 8) | next;
    const existing = dictionary.get(key);

    if (existing !== undefined) {
      prefix = existing;
      continue;
    }

    stream.writeCode(prefix, codeSize);

    // Widen *before* the entry that needs the extra bit is created, not after.
    // The decoder is always one entry behind the encoder, so bumping a code too
    // early puts the two out of step and every later code is misread.
    if (nextCode > (1 << codeSize) - 1 && codeSize < 12) codeSize++;

    if (nextCode === 4096) {
      // The dictionary is full: tell the decoder to reset and start over.
      stream.writeCode(clearCode, codeSize);
      dictionary = new Map();
      nextCode = endCode + 1;
      codeSize = minCodeSize + 1;
    } else {
      dictionary.set(key, nextCode);
      nextCode++;
    }

    prefix = next;
  }

  stream.writeCode(prefix, codeSize);
  stream.writeCode(endCode, codeSize);

  return stream.finish();
}

// GIF colour tables have to be a power of two, at least 2 entries.
function paletteSizeExponent(colorCount) {
  let exponent = 1;
  while (1 << exponent < colorCount) exponent++;
  return Math.min(Math.max(exponent, 1), 8);
}

function u16(value) {
  const buffer = Buffer.allocUnsafe(2);
  buffer.writeUInt16LE(value & 0xffff, 0);
  return buffer;
}

/**
 * One frame, encoded on its own so a static frame (the expired card, say) can
 * be encoded once and then appended to many responses as raw bytes.
 *
 * `left`/`top`/`width`/`height` describe where this block lands on the canvas;
 * `indices` holds exactly width*height palette indices for that rectangle.
 */
function encodeFrameBlock({
  indices,
  left = 0,
  top = 0,
  width,
  height,
  delayMs = 1000,
  disposal = DISPOSAL_NONE,
  transparentIndex = -1,
  minCodeSize,
}) {
  if (indices.length !== width * height) {
    throw new Error(`frame is ${indices.length} indices, expected ${width * height}`);
  }

  const hasTransparency = transparentIndex >= 0;

  // Graphic control extension: disposal, delay, optional transparent index.
  // Delay is in hundredths of a second, which is the whole reason a countdown
  // ticks on whole seconds rather than anything finer.
  const graphicControl = Buffer.concat([
    Buffer.from([0x21, 0xf9, 0x04, ((disposal & 0x07) << 2) | (hasTransparency ? 1 : 0)]),
    u16(Math.round(delayMs / 10)),
    Buffer.from([hasTransparency ? transparentIndex : 0, 0x00]),
  ]);

  const imageDescriptor = Buffer.concat([
    Buffer.from([0x2c]),
    u16(left),
    u16(top),
    u16(width),
    u16(height),
    Buffer.from([0x00]), // no local colour table, not interlaced
  ]);

  return Buffer.concat([
    graphicControl,
    imageDescriptor,
    Buffer.from([minCodeSize]),
    lzwCompress(indices, minCodeSize),
  ]);
}

/**
 * Assembles a GIF from a global palette and a sequence of frames.
 *
 * `loop` is deliberately null by default. A countdown that looped would jump
 * back to the starting time after its last frame and show the wrong number, so
 * the animation plays once and freezes on its final frame — the email client
 * re-fetches the image on the next open and gets a fresh one.
 */
class GifWriter {
  constructor({ width, height, palette, loop = null, backgroundIndex = 0 }) {
    this.width = width;
    this.height = height;
    this.loop = loop;

    const colorCount = palette.length / 3;
    const exponent = paletteSizeExponent(colorCount);
    const tableEntries = 1 << exponent;

    this.minCodeSize = Math.max(exponent, 2);

    const colorTable = Buffer.alloc(tableEntries * 3);
    Buffer.from(palette).copy(colorTable, 0, 0, Math.min(palette.length, colorTable.length));

    const screenDescriptor = Buffer.concat([
      u16(width),
      u16(height),
      // global colour table present | colour resolution 8 bits | not sorted | size
      Buffer.from([0x80 | 0x70 | (exponent - 1), backgroundIndex, 0x00]),
    ]);

    this.chunks = [HEADER, screenDescriptor, colorTable];

    if (loop !== null) {
      this.chunks.push(
        Buffer.concat([
          Buffer.from([0x21, 0xff, 0x0b]),
          Buffer.from('NETSCAPE2.0', 'ascii'),
          Buffer.from([0x03, 0x01]),
          u16(loop),
          Buffer.from([0x00]),
        ])
      );
    }
  }

  addFrame(frame) {
    this.chunks.push(encodeFrameBlock({ ...frame, minCodeSize: this.minCodeSize }));
    return this;
  }

  /** Append a block produced earlier by `encodeFrameBlock` with the same palette. */
  addEncodedFrame(block) {
    this.chunks.push(block);
    return this;
  }

  finish() {
    return Buffer.concat([...this.chunks, TRAILER]);
  }
}

module.exports = { GifWriter, encodeFrameBlock, lzwCompress, DISPOSAL_NONE };

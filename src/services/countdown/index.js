/**
 * Turning "how long is left" into a GIF, once per request.
 *
 * Every expensive decision was already made by sprites.js. What is left is the
 * part that genuinely depends on the clock: which digits to show, which of them
 * changed since the previous second, and the smallest rectangle that covers the
 * change. Fifty-nine of the sixty frames end up being a strip a few digits wide.
 *
 * The animation plays once and stops. A countdown that looped would jump back
 * to its starting value; instead it freezes on its last frame and the next time
 * the message is opened the image is fetched again, fresh.
 */

const crypto = require('crypto');

const redisState = require('../../config/redis').state;
const { GifWriter, encodeFrameBlock } = require('../../lib/gif');
const { getBundle } = require('./sprites');
const { resolveDeadline } = require('./time');
const {
  loadTemplateSchema,
  templatePlaceholders,
  placeholdersIn,
  relevantVars,
} = require('../render');
const {
  TIMER_RESPONSE_CACHE_SECONDS,
  TIMER_EXPIRED_CACHE_SECONDS,
  TIMER_EVERGREEN_TTL_SECONDS,
  RENDER_YIELD_FRAMES,
} = require('../../config');

const UNIT_SECONDS = { days: 86400, hours: 3600, minutes: 60, seconds: 1 };

// A 1x1 fully transparent GIF, for timers configured to disappear once they end.
const BLANK_GIF = Buffer.from(
  'R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7',
  'base64'
);

/**
 * Unit values for a number of seconds, where the largest unit shown absorbs
 * everything above it — a timer with no days group shows 72 hours rather than
 * wrapping round to 0.
 */
function unitValues(totalSeconds, units) {
  const values = {};
  let remainder = Math.max(0, totalSeconds);

  units.forEach((unit) => {
    const size = UNIT_SECONDS[unit];
    values[unit] = Math.floor(remainder / size);
    remainder -= values[unit] * size;
  });

  return values;
}

function digitFor(slot, values) {
  return Math.floor((values[slot.unit] || 0) / slot.power) % 10;
}

/** How many slots the largest unit needs at the moment the animation starts. */
function leadDigitsFor(totalSeconds, units) {
  const lead = units[0];
  const value = Math.floor(Math.max(0, totalSeconds) / UNIT_SECONDS[lead]);
  return Math.max(2, String(value).length);
}

/** Copy the background into a rectangle, then stamp the current digits onto it. */
function assembleRect(bundle, rect, digits) {
  const indices = new Uint8Array(rect.width * rect.height);

  for (let y = 0; y < rect.height; y++) {
    const from = (rect.top + y) * bundle.width + rect.left;
    indices.set(bundle.baseIndices.subarray(from, from + rect.width), y * rect.width);
  }

  const tileSize = bundle.tileWidth * bundle.tileHeight;

  bundle.slots.forEach((slot, slotIndex) => {
    if (slot.left < rect.left || slot.left + slot.width > rect.left + rect.width) return;

    const tile = bundle.tiles[slotIndex];
    const offset = digits[slotIndex] * tileSize;
    const localLeft = slot.left - rect.left;
    const localTop = slot.top - rect.top;

    for (let y = 0; y < slot.height; y++) {
      indices.set(
        tile.subarray(offset + y * slot.width, offset + (y + 1) * slot.width),
        (localTop + y) * rect.width + localLeft
      );
    }
  });

  return indices;
}

/** The whole canvas with the given digits on it — used for the first frame. */
function assembleFullFrame(bundle, digits) {
  return assembleRect(
    bundle,
    { left: 0, top: 0, width: bundle.width, height: bundle.height },
    digits
  );
}

/** The smallest rectangle covering every slot whose digit changed. */
function changedRect(bundle, previousDigits, digits) {
  let left = Infinity;
  let right = -Infinity;
  let top = Infinity;
  let bottom = -Infinity;

  bundle.slots.forEach((slot, index) => {
    if (previousDigits[index] === digits[index]) return;
    left = Math.min(left, slot.left);
    right = Math.max(right, slot.left + slot.width);
    top = Math.min(top, slot.top);
    bottom = Math.max(bottom, slot.top + slot.height);
  });

  if (left === Infinity) return null;

  return { left, top, width: right - left, height: bottom - top };
}

// A seconds column takes exactly sixty frames to visit all sixty of its values,
// which is what makes a looping countdown possible at all.
const LOOP_FRAMES = 60;

/**
 * Whether this timer can loop *seamlessly*.
 *
 * A naive infinite loop is worse than no loop: the animation returns to frame 0
 * and the clock visibly jumps back up, which reads as broken rather than as
 * still running. It only works if the smallest unit on screen completes a whole
 * cycle in one pass — so the timer has to be showing seconds, and it must not
 * run out part-way through the loop.
 */
function canLoopSeamlessly(timer, totalSeconds) {
  return Boolean(timer.loop) && timer.style.units.includes('seconds') && totalSeconds > LOOP_FRAMES;
}

/**
 * The GIF itself.
 *
 * `remainingMs` is measured once, at the top of the request, and every frame is
 * derived from it — so the animation is correct relative to the moment the
 * image was fetched, which is the moment the email was opened.
 *
 * In looping mode the seconds column runs a full 59->00->59 cycle and everything
 * above it is *held* at its opening value. Two things fall out of that: the wrap
 * from the last frame back to frame 0 is an ordinary one-second decrement, so
 * there is no jump anywhere in the picture; and the seconds shown stay exactly
 * correct forever, because (s - k) mod 60 is what a real clock reads k seconds
 * later. Only minutes and above go stale, by however long the reader stares.
 */
async function buildGif(timer, bundle, remainingMs) {
  const units = timer.style.units;
  const totalSeconds = Math.floor(remainingMs / 1000);
  const looping = canLoopSeamlessly(timer, totalSeconds);

  const frameCount = looping ? LOOP_FRAMES : timer.frames;

  const gif = new GifWriter({
    width: bundle.width,
    height: bundle.height,
    palette: bundle.palette,
    loop: looping ? 0 : null,
  });

  // Frame 0 covers the whole canvas, so the loop repaints cleanly and no
  // residue survives from the last frame.
  const heldValues = looping ? unitValues(totalSeconds, units) : null;

  let previousDigits = null;

  for (let frame = 0; frame < frameCount; frame++) {
    // Assembling and LZW-encoding a frame is synchronous, and sixty of them in
    // a row is long enough to be felt by every other request on this worker.
    // Handing the loop back periodically costs this render a little latency and
    // stops it from monopolising the process.
    if (RENDER_YIELD_FRAMES && frame > 0 && frame % RENDER_YIELD_FRAMES === 0) {
      await new Promise((resolve) => setImmediate(resolve));
    }

    const secondsLeft = totalSeconds - frame;

    if (secondsLeft < 0) {
      // The deadline passed while the reader was watching. Swap to the expired
      // card rather than counting into negative numbers.
      if (bundle.expiredBlock) gif.addEncodedFrame(bundle.expiredBlock);
      break;
    }

    // One breakdown per frame, not one per digit slot.
    const values = unitValues(secondsLeft, units);
    const digits = bundle.slots.map((slot) =>
      digitFor(slot, looping && slot.unit !== 'seconds' ? heldValues : values)
    );

    if (frame === 0) {
      gif.addFrame({
        indices: assembleFullFrame(bundle, digits),
        left: 0,
        top: 0,
        width: bundle.width,
        height: bundle.height,
        delayMs: 1000,
      });
    } else {
      const rect = changedRect(bundle, previousDigits, digits);
      if (rect) {
        gif.addFrame({
          indices: assembleRect(bundle, rect, digits),
          left: rect.left,
          top: rect.top,
          width: rect.width,
          height: rect.height,
          delayMs: 1000,
        });
      }
    }

    previousDigits = digits;
  }

  return gif.finish();
}

/** A single static frame: the expired card, or a frozen row of zeros. */
async function buildExpiredGif(timer, bundle) {
  const gif = new GifWriter({
    width: bundle.width,
    height: bundle.height,
    palette: bundle.palette,
    loop: null,
  });

  if (bundle.expiredBlock) {
    gif.addEncodedFrame(bundle.expiredBlock);
  } else {
    const digits = bundle.slots.map(() => 0);
    gif.addFrame({
      indices: assembleFullFrame(bundle, digits),
      left: 0,
      top: 0,
      width: bundle.width,
      height: bundle.height,
      delayMs: 1000,
    });
  }

  return gif.finish();
}

/**
 * Evergreen timers: "24 hours from when you first opened this".
 *
 * The first fetch for a recipient records the moment; later fetches count down
 * from it. This needs an explicit `uid` in the URL because the request comes
 * from the email client's image proxy, not from the reader — there is nothing
 * else to key on.
 */
async function resolveEvergreenDeadline(timer, uid, now) {
  const window = timer.evergreenSeconds * 1000;

  if (!uid || !redisState.connected) {
    // With nowhere to remember a start, every open would restart the clock,
    // which is worse than simply showing the full window.
    return now + window;
  }

  const key = `timer:evergreen:${crypto
    .createHash('md5')
    .update(`${timer.evergreenSeconds}:${JSON.stringify(timer.source)}:${uid}`)
    .digest('hex')}`;

  try {
    // SET NX returns null when the key already existed, so the first open wins
    // the race and everyone else reads what it stored.
    const stored = await redisState.client.set(key, String(now), 'EX', TIMER_EVERGREEN_TTL_SECONDS, 'NX');
    if (stored) return now + window;

    const startedAt = Number(await redisState.client.get(key));
    if (Number.isFinite(startedAt)) return startedAt + window;
  } catch (err) {
    console.warn('⚠️ Redis evergreen timer error:', err.message);
  }

  return now + window;
}

/** When this timer runs out, in epoch milliseconds — or null if it never does. */
async function resolveTimerDeadline(timer, { uid, now }) {
  if (timer.evergreenSeconds > 0) return resolveEvergreenDeadline(timer, uid, now);
  return resolveDeadline(timer.endAt, timer.timezone);
}

/**
 * The subset of `vars` that can actually change this timer's pixels.
 *
 * A campaign URL carries far more than the creative uses — recipient ids, UTM
 * parameters, whatever the ESP appends. Everything downstream of here is cached
 * by a hash of the variables, so keying on the whole set means every recipient
 * gets their own sprite bundle and their own response entry: a ~450ms build per
 * person for a picture that is identical for all of them.
 *
 * Reducing the key to the placeholders the creative actually contains is exact,
 * not a heuristic — a variable the template never mentions cannot affect the
 * output — and for the common case of a creative with no placeholders at all it
 * collapses an entire send onto a single cache entry.
 */
async function cacheVars(timer, vars) {
  if (!vars || Object.keys(vars).length === 0) return {};

  try {
    if (timer.source.templateId) {
      const template = await loadTemplateSchema(timer.source.templateId);
      return relevantVars(vars, templatePlaceholders(template));
    }

    return relevantVars(vars, placeholdersIn(timer.source.backgroundUrl));
  } catch (err) {
    // Never let key optimisation break a render: fall back to the full set,
    // which is correct, just less cacheable.
    console.warn('⚠️ Could not resolve timer placeholders:', err.message);
    return vars;
  }
}

/**
 * The endpoint's whole job, minus the HTTP.
 *
 * Returns the GIF plus enough context for the caller to log or to set debug
 * headers. Identical requests inside the same second share one render: on a
 * large send that is thousands of opens collapsing onto a single encode.
 */
async function renderTimer(timer, { vars: rawVars = {}, uid = '', now = Date.now() } = {}) {
  const deadline = await resolveTimerDeadline(timer, { uid, now });

  if (deadline === null) {
    const error = new Error('This timer has no end time — pass end=<date> or configure one');
    error.status = 400;
    throw error;
  }

  const remainingMs = deadline - now;
  const expired = remainingMs <= 0;

  if (expired && timer.expired.mode === 'hide') {
    return { buffer: BLANK_GIF, expired: true, remainingSeconds: 0, cached: false, frames: 1 };
  }

  // Reduced before anything is keyed on it — see cacheVars.
  const vars = await cacheVars(timer, rawVars);

  const leadDigits = leadDigitsFor(Math.floor(Math.max(0, remainingMs) / 1000), timer.style.units);
  const bundle = await getBundle(timer, vars, leadDigits);

  // Two opens in the same second want the same bytes. The window is short, and
  // the response still goes to the recipient with no-store, so nothing between
  // here and the inbox is allowed to hold on to it.
  const secondBucket = expired ? 'expired' : Math.floor(remainingMs / 1000);
  const responseKey = `timer:gif:${crypto
    .createHash('md5')
    .update(`${JSON.stringify(timer)}|${JSON.stringify(vars)}|${leadDigits}`)
    .digest('hex')}:${secondBucket}`;

  if (redisState.connected) {
    try {
      const cached = await redisState.client.getBuffer(responseKey);
      if (cached) {
        return {
          buffer: cached,
          expired,
          looping: !expired && canLoopSeamlessly(timer, Math.floor(remainingMs / 1000)),
          remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
          cached: true,
          frames: expired ? 1 : timer.frames,
        };
      }
    } catch (err) {
      console.warn('⚠️ Redis timer response cache error:', err.message);
    }
  }

  const looping = !expired && canLoopSeamlessly(timer, Math.floor(remainingMs / 1000));

  const buffer = expired
    ? await buildExpiredGif(timer, bundle)
    : await buildGif(timer, bundle, remainingMs);

  if (redisState.connected) {
    const ttl = expired ? TIMER_EXPIRED_CACHE_SECONDS : TIMER_RESPONSE_CACHE_SECONDS;
    redisState.client
      .set(responseKey, buffer, 'EX', Math.max(1, ttl))
      .catch((err) => console.warn('⚠️ Redis timer response cache write error:', err.message));
  }

  return {
    buffer,
    expired,
    looping,
    remainingSeconds: Math.max(0, Math.floor(remainingMs / 1000)),
    cached: false,
    frames: expired ? 1 : looping ? LOOP_FRAMES : timer.frames,
  };
}

module.exports = {
  renderTimer,
  cacheVars,
  canLoopSeamlessly,
  LOOP_FRAMES,
  resolveTimerDeadline,
  unitValues,
  leadDigitsFor,
  BLANK_GIF,
  UNIT_SECONDS,
};

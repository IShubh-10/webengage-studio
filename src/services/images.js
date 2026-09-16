/**
 * Image sourcing for the renderer: a cached buffer loader (memory, then Redis,
 * then the network), a cached metadata reader, and the dimension parser the
 * composite step uses.
 */

const sharp = require('sharp');

const redisState = require('../config/redis').state;
const { LRUCache, bufferCache, metadataCache } = require('../lib/cache');
const { SingleFlight } = require('../lib/singleflight');
const { onInvalidate } = require('../lib/invalidation');
const { assertFetchableUrl } = require('../lib/urlGuard');
const {
  IMAGE_FETCH_HEADERS,
  IMAGE_CACHE_TTL_SECONDS,
  IMAGE_CACHE_REFRESH_SECONDS,
  IMAGE_MAX_BYTES,
  IMAGE_FETCH_TIMEOUT_MS,
} = require('../config');

// When each Redis key last had its TTL re-asserted, so a memory hit does not
// cost a round trip on every single render. Bounded like the buffer cache it
// shadows; it holds timestamps only, so it is cheap.
const redisTouchedAt = new LRUCache(512);

// Concurrent renders of the same creative all want the same background. Without
// this, a cold cache under load means one outbound HTTP request per email open
// to the same URL — which is both slow and a good way to get rate-limited by
// whoever is hosting the asset. The first caller fetches; everyone else waits
// on that fetch.
const inFlightFetches = new SingleFlight();

function dueForRedisTouch(key) {
  const last = redisTouchedAt.get(key);
  const now = Date.now();
  if (last && now - last < IMAGE_CACHE_REFRESH_SECONDS * 1000) return false;
  redisTouchedAt.set(key, now);
  return true;
}

/**
 * Keep Redis in step with the in-memory LRU.
 *
 * The memory cache has no expiry, so before this existed a hot image kept being
 * served from memory while its Redis entry expired unnoticed — leaving Redis
 * with no copy of the binary at all, for every other worker and for this one
 * after a restart. EXPIRE renews a key that is still there and reports 0 when
 * it has gone, in which case the bytes are written again.
 */
function touchRedisCopy(key, value, serialize) {
  if (!redisState.connected || !dueForRedisTouch(key)) return;

  redisState.client
    .expire(key, IMAGE_CACHE_TTL_SECONDS)
    .then((renewed) => {
      if (renewed) return null;
      return redisState.client.set(key, serialize ? serialize(value) : value, 'EX', IMAGE_CACHE_TTL_SECONDS);
    })
    .catch((err) => {
      console.warn('⚠️ Redis image cache refresh error:', err.message);
    });
}

async function loadImageBuffer(src) {
  if (!src) return null;

  // Handle data URIs
  if (src.startsWith('data:')) {
    const match = src.match(/^data:(image\/[^;]+);base64,(.*)$/);
    if (match) {
      return Buffer.from(match[2], 'base64');
    }
    return null;
  }

  /*
   * Before the caches, not after.
   *
   * The obvious place for this is next to the fetch, but the caches sit in
   * front of the fetch — so a URL that was allowed once would keep being
   * served from memory or Redis for as long as its entry lived, no matter what
   * the rules said now. Anything cached before this check existed would stay
   * readable too. The verdict is memoized inside the guard, so this does not
   * cost a DNS lookup per render.
   */
  await assertFetchableUrl(src);

  const cacheKey = `img_buffer:${src}`;

  // 1. Check in-memory LRU first (fastest)
  let buffer = bufferCache.get(cacheKey);
  if (buffer) {
    if (process.env.DEBUG_CACHE === 'true') console.log(`📦 In-Memory HIT: ${cacheKey}`);
    touchRedisCopy(cacheKey, buffer);
    return buffer;
  }

  // 2. Check Redis (if connected)
  if (redisState.connected) {
    try {
      const cached = await redisState.client.getBuffer(cacheKey);
      if (cached) {
        if (process.env.DEBUG_CACHE === 'true') console.log(`🔴 Redis HIT: ${cacheKey}`);
        bufferCache.set(cacheKey, cached);
        return cached;
      }
    } catch (err) {
      console.warn('⚠️ Redis read error:', err.message);
    }
  }

  // 3. Fetch from remote (with persistent agent), one request per URL at a time
  return inFlightFetches.run(cacheKey, () => fetchAndCache(src, cacheKey));
}

/**
 * Read the body, refusing to allocate more than IMAGE_MAX_BYTES for it.
 *
 * `arrayBuffer()` would buffer whatever arrives, which for a URL the caller
 * chose is an unbounded allocation in a process that also has to serve
 * everyone else. Content-Length is checked first because it is free, then the
 * running total is checked as chunks arrive — a remote is under no obligation
 * to send that header, or to be honest in it.
 */
async function readCapped(response, src) {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > IMAGE_MAX_BYTES) {
    throw new Error(`image is ${declared} bytes, over the ${IMAGE_MAX_BYTES} limit`);
  }

  const chunks = [];
  let total = 0;

  for await (const chunk of response.body) {
    total += chunk.length;
    if (total > IMAGE_MAX_BYTES) {
      // Stop pulling bytes rather than reading to the end and then complaining.
      await response.body.cancel?.().catch(() => {});
      throw new Error(`image exceeded the ${IMAGE_MAX_BYTES} byte limit`);
    }
    chunks.push(chunk);
  }

  return Buffer.concat(chunks, total);
}

// A public host that redirects to an internal one would walk straight past a
// check done only on the URL the caller typed, so redirects are followed by
// hand and every hop is validated the same way the first one was. Three is
// more than any image CDN legitimately needs.
const MAX_REDIRECTS = 3;

async function fetchGuarded(src) {
  let target = src;

  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    /*
     * The caller picks this URL, so it is checked before a socket is opened:
     * http(s) only, and it must resolve to a public address. Without this the
     * render endpoint is a read primitive on the private network — see
     * lib/urlGuard.js.
     */
    await assertFetchableUrl(target);

    const response = await fetch(target, {
      headers: IMAGE_FETCH_HEADERS,
      redirect: 'manual',
      // Node's built-in fetch ignores node-fetch's `timeout` option, so until
      // now there was none and a slow remote held a render slot indefinitely.
      signal: AbortSignal.timeout(IMAGE_FETCH_TIMEOUT_MS),
    });

    const location = response.headers.get('location');
    if (response.status >= 300 && response.status < 400 && location) {
      target = new URL(location, target).toString();
      continue;
    }

    return response;
  }

  throw new Error(`more than ${MAX_REDIRECTS} redirects`);
}

async function fetchAndCache(src, cacheKey) {
  let buffer;

  try {
    const startFetch = Date.now();

    const r = await fetchGuarded(src);

    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }

    buffer = await readCapped(r, src);

    if (process.env.DEBUG_TIMING === 'true') {
      console.log(`⏱️ Fetched ${src} in ${Date.now() - startFetch}ms (${buffer.length} bytes)`);
    }

    // 4. Cache in both in-memory (immediate) and Redis (persistent)
    bufferCache.set(cacheKey, buffer);

    if (redisState.connected) {
      redisTouchedAt.set(cacheKey, Date.now());
      redisState.client.set(cacheKey, buffer, 'EX', IMAGE_CACHE_TTL_SECONDS).catch((err) => {
        console.warn('⚠️ Redis set error:', err.message);
      });
    }

    return buffer;
  } catch (err) {
    console.error(`❌ Error fetching image ${src}:`, err.message);
    return null;
  }
}

/**
 * Decoded properties of a source image: memory, then Redis, then sharp. Only
 * width and height drive the layout maths, but format/size/contentType are kept
 * so the cached record describes the asset without touching the bytes again.
 * Decoding is the expensive part, so this survives a restart in Redis rather
 * than living only in this process.
 */
async function loadImageMetadata(src, buffer) {
  const memoryKey = `meta:${src}`;

  const memoryHit = metadataCache.get(memoryKey);
  if (memoryHit) {
    if (process.env.DEBUG_CACHE === 'true') console.log(`📐 Metadata HIT: ${memoryKey}`);
    if (!src.startsWith('data:')) {
      touchRedisCopy(`img_meta:${src}`, memoryHit, JSON.stringify);
    }
    return memoryHit;
  }

  const redisKey = `img_meta:${src}`;

  if (redisState.connected && !src.startsWith('data:')) {
    try {
      const raw = await redisState.client.get(redisKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        metadataCache.set(memoryKey, parsed);
        return parsed;
      }
    } catch (err) {
      console.warn('⚠️ Redis metadata read error:', err.message);
    }
  }

  const probed = await sharp(buffer).metadata();

  const metadata = {
    format: probed.format || null,
    contentType: probed.format ? `image/${probed.format}` : null,
    width: probed.width,
    height: probed.height,
    size: probed.size || buffer.length,
    space: probed.space || null,
    channels: probed.channels || null,
    hasAlpha: Boolean(probed.hasAlpha),
  };

  metadataCache.set(memoryKey, metadata);

  if (redisState.connected && !src.startsWith('data:')) {
    redisTouchedAt.set(redisKey, Date.now());
    redisState.client
      .set(redisKey, JSON.stringify(metadata), 'EX', IMAGE_CACHE_TTL_SECONDS)
      .catch((err) => {
        console.warn('⚠️ Redis metadata set error:', err.message);
      });
  }

  return metadata;
}

function parseDimension(val, maxPixels, axisScale) {
  const cleanStr = String(val).trim().toLowerCase();
  if (cleanStr === 'auto' || !cleanStr || isNaN(parseInt(cleanStr))) return null;
  if (cleanStr.endsWith('%')) {
    const pct = parseFloat(cleanStr) / 100;
    return Math.round(maxPixels * pct);
  }
  return Math.round((parseInt(cleanStr) || 0) * axisScale);
}

// A saved template may point at a re-uploaded asset living at a URL we already
// have bytes for, so an edit drops the image caches. Previously this ran only in
// the worker that handled the save; it now reaches all of them.
onInvalidate('template', () => {
  bufferCache.clear();
  metadataCache.clear();
});

module.exports = { loadImageBuffer, loadImageMetadata, parseDimension };

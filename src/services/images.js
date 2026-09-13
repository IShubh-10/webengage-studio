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
const { httpAgent, httpsAgent } = require('../lib/httpAgents');
const {
  IMAGE_FETCH_HEADERS,
  IMAGE_CACHE_TTL_SECONDS,
  IMAGE_CACHE_REFRESH_SECONDS,
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

async function fetchAndCache(src, cacheKey) {
  let buffer;

  try {
    const startFetch = Date.now();
    const protocol = src.startsWith('https') ? 'https' : 'http';
    const agent = protocol === 'https' ? httpsAgent : httpAgent;

    const r = await fetch(src, {
      headers: IMAGE_FETCH_HEADERS,
      agent,
      timeout: 10000,
    });

    if (!r.ok) {
      throw new Error(`HTTP ${r.status}`);
    }

    const arrayBuffer = await r.arrayBuffer();
    buffer = Buffer.from(arrayBuffer);

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

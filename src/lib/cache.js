/**
 * In-memory LRU caches: the fast layer in front of Redis and the network.
 *
 * An optional TTL exists for entries this process cannot be told about when
 * they change. Cross-worker invalidation (lib/invalidation.js) handles the
 * normal case, but it travels over Redis — so when Redis is down, a TTL is the
 * only thing that eventually retires a stale entry.
 */

class LRUCache {
  /** `ttlMs` of 0 means entries never expire on their own (the original behaviour). */
  constructor(maxSize = 512, ttlMs = 0) {
    this.cache = new Map();
    this.maxSize = maxSize;
    this.ttlMs = Math.max(0, ttlMs);
    this.hits = 0;
    this.misses = 0;
  }

  get(key) {
    if (this.cache.has(key)) {
      const node = this.cache.get(key);

      if (this.ttlMs && node.expiresAt <= Date.now()) {
        this.cache.delete(key);
        this.misses++;
        return null;
      }

      // Move to end (most recently used)
      this.cache.delete(key);
      this.cache.set(key, node);
      this.hits++;
      return this.ttlMs ? node.value : node;
    }
    this.misses++;
    return null;
  }

  set(key, value) {
    if (this.cache.has(key)) {
      this.cache.delete(key);
    }
    this.cache.set(key, this.ttlMs ? { value, expiresAt: Date.now() + this.ttlMs } : value);

    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value;
      this.cache.delete(firstKey);
    }
  }

  delete(key) {
    return this.cache.delete(key);
  }

  clear() {
    this.cache.clear();
  }

  stats() {
    const total = this.hits + this.misses;
    const hitRate = total > 0 ? ((this.hits / total) * 100).toFixed(2) : 0;
    return { hits: this.hits, misses: this.misses, size: this.cache.size, hitRate: `${hitRate}%` };
  }
}

const bufferCache = new LRUCache(256); // Image buffers
const metadataCache = new LRUCache(128); // Image metadata
const svgCache = new LRUCache(256); // Pre-compiled SVGs
const resizedCache = new LRUCache(128); // Resized overlay buffers

module.exports = { LRUCache, bufferCache, metadataCache, svgCache, resizedCache };

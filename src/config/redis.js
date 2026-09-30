/**
 * Redis client with a soft fallback: when it is unavailable the app keeps
 * working from its in-memory caches. `state` is shared by reference so callers
 * always see the live connection status.
 *
 * `createClient` exists because a connection in subscriber mode cannot run
 * ordinary commands — cross-worker cache invalidation needs a second connection
 * of its own (see lib/invalidation.js).
 *
 * Redis is a separate machine, not a sidecar. It runs on its own EC2 instance
 * so one cache can serve several applications, which makes three things matter
 * that did not when it was a local process:
 *
 *   - the endpoint is configuration, never a constant in this file. An earlier
 *     version carried a provider's internal hostname as a production default,
 *     and that name resolves nowhere else — the app then retried a dead host
 *     forever instead of saying it was unconfigured;
 *   - the connection crosses a network that can drop an idle socket silently,
 *     so TCP keepalive is on and there is a connect timeout;
 *   - the instance is shared, so this app takes a numbered database of its own
 *     (REDIS_DB) and its keys can never collide with another tenant's. That
 *     also keeps `scanDelete` in lib/redisOps.js honest: SCAN walks one
 *     database, so a pattern sweep here cannot touch anybody else's keys.
 */

const Redis = require('ioredis');

const { connectedTo, note } = require('../lib/bootReport');

// `reported` marks the boot summary as already written, so the connect handler
// can tell a first connection from a reconnection after an outage.
const state = { client: null, connected: false, enabled: true, reported: false };

const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Was anything pointed at a Redis explicitly? Used to tell a deliberate
// in-memory-only run apart from a misconfigured one.
const HAS_EXPLICIT_CONFIG = Boolean(
  process.env.REDIS_URL ||
    process.env.REDIS_HOST ||
    process.env.REDIS_PORT ||
    process.env.REDIS_PASSWORD
);

// Hosted Redis is usually handed over as a single URL (`redis://…`, or
// `rediss://…` when the connection is encrypted), so REDIS_URL wins when it is
// set and the host/port/password fields below stay for a local install and for
// the EC2 cache, where the pieces are easier to read in a unit file than one
// long string with a password in the middle.
const REDIS_URL = process.env.REDIS_URL || '';

const REDIS_HOST = process.env.REDIS_HOST || '127.0.0.1';
const REDIS_PORT = Number(process.env.REDIS_PORT || 6379);

// The numbered database this app uses on a shared instance. Redis has 16 by
// default (`databases 16` in redis.conf); giving each application its own is
// the cheapest isolation there is — no key prefix to remember, no chance of
// one app's FLUSHDB or pattern sweep taking another's cache with it.
//
// Note it does NOT isolate pub/sub: channels are global to the server, which is
// why lib/invalidation.js names its channel `we-studio:invalidate` rather than
// something generic.
const REDIS_DB = Math.max(0, Number(process.env.REDIS_DB || 0));

// Redis 6 added named users (ACLs). A plain `requirepass` instance has only the
// implicit `default` user and needs the password alone, so this stays unset in
// most deployments.
const REDIS_USERNAME = process.env.REDIS_USERNAME || undefined;
const REDIS_PASSWORD = process.env.REDIS_PASSWORD || undefined;

// Encryption in transit. Inside one VPC, with 6379 reachable only from the
// application's security group, the traffic never leaves Amazon's network and
// plaintext with a password is the usual setting. Turn this on when the cache
// is fronted by stunnel or configured with `tls-port`, and always if the two
// instances are ever in different VPCs or accounts.
const REDIS_TLS = String(process.env.REDIS_TLS || '').toLowerCase() === 'true';

// A cache on another instance answers a handshake in single-digit milliseconds
// when it is healthy and not at all when its security group is wrong. ioredis
// waits 10s by default, which is a long time to find that out on every worker
// at boot.
const REDIS_CONNECT_TIMEOUT_MS = Math.max(
  500,
  Number(process.env.REDIS_CONNECT_TIMEOUT_MS || 5000)
);

// Nothing points at a Redis anywhere. Locally that is fine — a developer
// running `redis-server` with no env vars expects 127.0.0.1:6379 to be tried.
// In production it can only ever fail: there is no Redis inside the application
// instance, that is the whole point of the split. Attempting it anyway produced
// one ECONNREFUSED line per retry per worker, forever, which buried every other
// line in the log.
const IS_CONFIGURED = HAS_EXPLICIT_CONFIG;

/** False when the app is deliberately running on its in-memory caches alone. */
function isEnabled() {
  return state.enabled;
}

/**
 * Where this process thinks the cache is, with any password removed — printed
 * once at boot. Moving the cache to its own host makes "connected to what?" a
 * real question, and a redacted endpoint in the log is the fastest answer.
 */
function describeEndpoint() {
  if (REDIS_URL) {
    try {
      const url = new URL(REDIS_URL);
      const db = url.pathname && url.pathname !== '/' ? url.pathname : `/${REDIS_DB}`;
      return `${url.protocol}//${url.hostname}:${url.port || 6379}${db}`;
    } catch (err) {
      return 'REDIS_URL (unparseable)';
    }
  }

  const scheme = REDIS_TLS ? 'rediss' : 'redis';
  return `${scheme}://${REDIS_HOST}:${REDIS_PORT}/${REDIS_DB}`;
}

// --- Throttled logging -----------------------------------------------------
// A dead Redis fails identically several times a second on every worker. Print
// the first of each distinct message, then hold the rest back and summarise how
// many arrived, so a real outage stays visible without drowning the log.
const LOG_WINDOW_MS = 60000;
const suppressed = new Map(); // message -> { until, count }

function reportRedisIssue(label, message) {
  const key = `${label}:${message}`;
  const now = Date.now();
  const entry = suppressed.get(key);

  if (entry && now < entry.until) {
    entry.count += 1;
    return;
  }

  if (entry && entry.count > 0) {
    console.warn(
      `⚠️ ${label}: ${message} (${entry.count} more in the last ${Math.round(LOG_WINDOW_MS / 1000)}s)`
    );
  } else {
    console.warn(`⚠️ ${label}: ${message}`);
  }

  suppressed.set(key, { until: now + LOG_WINDOW_MS, count: 0 });
}

function connectionOptions() {
  const common = {
    maxRetriesPerRequest: 3,
    enableReadyCheck: false,
    enableOfflineQueue: true,
    connectTimeout: REDIS_CONNECT_TIMEOUT_MS,
    // The cache is a TCP hop away now, and an idle connection between two
    // instances can be dropped by the network without either end being told —
    // the next command then hangs until it times out. Keepalive probes turn
    // that silent death into a reconnect.
    keepAlive: 30000,
    // Cache reads are small and latency-sensitive; waiting to coalesce them
    // into a fuller packet is the wrong trade on this path.
    noDelay: true,
    // Backs off to half a minute rather than hammering a host that is down:
    // reconnecting twice a second buys nothing and costs a log line each time.
    retryStrategy: (times) => Math.min(times * 500, 30000),
    reconnectOnError: () => true,
  };

  // A db in the URL's path wins; REDIS_DB fills it in when the URL has none, so
  // the same variable works with either form of configuration.
  if (REDIS_URL) return REDIS_DB ? { ...common, db: REDIS_DB } : common;

  return {
    ...common,
    host: REDIS_HOST,
    port: REDIS_PORT,
    db: REDIS_DB,
    username: REDIS_USERNAME,
    password: REDIS_PASSWORD,
    // `{}` means "encrypt, verify against the system CA store". A cache using a
    // certificate it signed itself needs REDIS_TLS_INSECURE=true as well.
    tls: REDIS_TLS
      ? { rejectUnauthorized: String(process.env.REDIS_TLS_INSECURE || '').toLowerCase() !== 'true' }
      : undefined,
  };
}

/**
 * A fresh connection with the same settings — for pub/sub, which needs its own.
 * Returns null when Redis is switched off, so callers must check.
 */
function createClient(overrides = {}) {
  if (!state.enabled) return null;

  const options = { ...connectionOptions(), ...overrides };
  return REDIS_URL ? new Redis(REDIS_URL, options) : new Redis(options);
}

async function initRedis() {
  if (IS_PRODUCTION && !IS_CONFIGURED) {
    state.enabled = false;
    state.connected = false;
    connectedTo('Redis', 'not configured — in-memory caches only');
    note(
      '⚠️ No Redis is configured. Renders and timer lookups are not shared between workers\n' +
        '      and are lost on restart; registration OTPs, evergreen first-open times and the\n' +
        '      logout deny-list have nowhere to live. Set REDIS_URL (or REDIS_HOST/REDIS_PORT/\n' +
        '      REDIS_PASSWORD) in the service environment to fix it.'
    );
    return;
  }

  try {
    state.client = createClient();

    // The first connection is reported in the boot summary, not here — a line
    // saying "Redis connected" in the middle of this process's own startup
    // messages is what made it look as though this process had started Redis.
    // A LATER connect is a reconnection after an outage, which is news.
    state.client.on('connect', () => {
      const isReconnect = state.reported;
      state.connected = true;
      if (isReconnect) console.log('✅ Redis reachable again — resuming shared caches');
    });

    state.client.on('error', (err) => {
      const wasConnected = state.connected;
      state.connected = false;
      reportRedisIssue('Redis error', err.message);
      if (wasConnected) console.warn('⚠️ Redis connection lost — serving from in-memory caches');
    });

    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        resolve();
      }, 2000);

      state.client.once('ready', () => {
        clearTimeout(timeout);
        resolve();
      });
    });

    // Reported once the outcome is known, so the summary says whether the
    // cache actually answered rather than only where it was dialled.
    state.reported = true;
    connectedTo(
      'Redis',
      `${describeEndpoint()}${state.connected ? '' : '  — NOT reachable, using in-memory caches'}`
    );
  } catch (err) {
    console.warn('⚠️ Redis initialization failed, will use in-memory cache only:', err.message);
    state.connected = false;
    if (!state.reported) {
      state.reported = true;
      connectedTo('Redis', `${describeEndpoint()}  — unreachable (${err.message})`);
    }
  }
}

module.exports = { state, initRedis, createClient, isEnabled, reportRedisIssue, describeEndpoint };

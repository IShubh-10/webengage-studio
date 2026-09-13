/**
 * Every tunable in one place. Modules destructure what they need, so the values
 * are named identically wherever they are used.
 */

const fs = require('fs');
const path = require('path');
const { ROOT_DIR } = require('./env');

const PORT = process.env.PORT || 3000;
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');

// --- Process / cluster -------------------------------------------------------
// How many workers this deployment runs. The master exports it into each fork
// so a worker can size its own share of shared resources — os.cpus() is no help
// here, it reports the host's cores rather than the container's CPU limit.
const WORKER_COUNT = Math.max(1, Number(process.env.WORKER_COUNT || process.env.WORKERS || 1));

// --- MySQL connection ---------------------------------------------------------
// Every one of these comes from the environment (.env locally, the dashboard's
// environment panel in a deployment), because a managed database hands you a
// host, a port and a password that must not be written into the repository.
const DB_HOST = process.env.DB_HOST || 'localhost';
// Managed MySQL rarely listens on 3306 — it multiplexes many databases behind
// one address, so each gets its own port.
const DB_PORT = Math.max(1, Number(process.env.DB_PORT || 3306));
const DB_USER = process.env.DB_USER || 'root';
const DB_PASSWORD = process.env.DB_PASSWORD || '';
const DB_NAME = process.env.DB_NAME || 'railway';

// TLS. A hosted database is reached over the public internet, so the connection
// has to be encrypted; a local one on 127.0.0.1 does not need it.
//   DB_SSL=true          verify the server against the system CA store
//   DB_SSL=skip-verify   encrypt but do not verify (self-signed certificates)
//   DB_SSL_CA=/path.pem  verify against a CA the provider gave you
// mysql2 wants `undefined` rather than `false` when TLS is off.
const DB_SSL = (() => {
  const mode = String(process.env.DB_SSL || '').trim().toLowerCase();
  const ca = process.env.DB_SSL_CA;

  if (ca) {
    return { ca: fs.readFileSync(path.isAbsolute(ca) ? ca : path.join(ROOT_DIR, ca)) };
  }
  if (mode === 'skip-verify' || mode === 'no-verify') {
    return { rejectUnauthorized: false };
  }
  if (mode === 'true' || mode === '1' || mode === 'required') {
    return { minVersion: 'TLSv1.2' };
  }
  return undefined;
})();

// How long to wait for a connection to be established. mysql2's default is 10s,
// which is generous for a database on localhost and tight for one behind a
// provider's public TCP proxy — that handshake is seconds, not milliseconds,
// and a cold worker opening its first connection is the slowest case.
const DB_CONNECT_TIMEOUT_MS = Math.max(1000, Number(process.env.DB_CONNECT_TIMEOUT_MS || 20000));

// --- MySQL pool ---------------------------------------------------------------
// The pool is per worker, so the number that matters is the product. MySQL's
// default max_connections is 151; a pool of 75 across eight workers asks for
// 600 and the server answers ER_CON_COUNT_ERROR long before the database is
// actually busy. Size the whole cluster instead, then divide.
const DB_POOL_TOTAL = Math.max(4, Number(process.env.DB_POOL_TOTAL || 60));
const DB_CONNECTION_LIMIT = Math.max(
  2,
  Number(process.env.DB_CONNECTION_LIMIT || Math.floor(DB_POOL_TOTAL / WORKER_COUNT))
);

// Unbounded queueing (queueLimit: 0) turns a traffic spike into unbounded
// latency and unbounded memory: requests park in the pool's queue long after
// the client that sent them has given up. A bounded queue fails fast instead,
// which is information rather than a slow collapse.
const DB_QUEUE_LIMIT = Math.max(0, Number(process.env.DB_QUEUE_LIMIT || 100));

// --- Render load shedding -----------------------------------------------------
// GIF and PNG rendering is CPU work on a single-threaded event loop. Past a
// point, accepting more of it does not produce more throughput — it produces a
// queue nobody is still waiting on.
// Measured on one dev process: 16 in flight with 1024 waiting absorbs a burst of
// 1,200 simultaneous opens with nothing shed, at ~475 renders a second. Raising
// the concurrency past this makes throughput *worse* — the process spends
// longer inside CPU work and is slower to accept new connections. Size the
// queue from observed throughput: it is roughly how many seconds of backlog you
// are willing to make a reader wait for.
const RENDER_CONCURRENCY = Math.max(1, Number(process.env.RENDER_CONCURRENCY || 16));
const RENDER_QUEUE_LIMIT = Math.max(0, Number(process.env.RENDER_QUEUE_LIMIT || 1024));

// Frames are assembled and LZW-encoded synchronously. Handing control back to
// the event loop every so often keeps one large render from stalling every
// other request behind it — it costs the render a little latency and buys a far
// better p99 across the board.
const RENDER_YIELD_FRAMES = Math.max(0, Number(process.env.RENDER_YIELD_FRAMES || 8));

// --- Sessions ---------------------------------------------------------------
const SESSION_COOKIE = 'we_studio_session';
const SESSION_TTL_SECONDS = 7 * 24 * 60 * 60; // 7 days
const SESSION_SECRET = process.env.SESSION_SECRET || 'webengage-studio-dev-secret-change-me';

// The fallback is written in this file, so it is in the repository, so anyone
// who can read the source can mint a token for any account id — including one
// whose row says role = 'admin'. A warning was not enough: it scrolls past in a
// deploy log and the server starts anyway. In production this is fatal.
if (!process.env.SESSION_SECRET) {
  const message =
    'SESSION_SECRET is not set. Sessions would be signed with the default that ships in this repository, ' +
    'which means anyone who can read the source can forge an admin session.\n' +
    '   Generate one:  openssl rand -base64 32\n' +
    '   Then set it in .env locally, and in the environment of wherever this is deployed.';

  if (process.env.NODE_ENV === 'production') {
    console.error(`\u274c ${message}`);
    throw new Error('SESSION_SECRET is required when NODE_ENV=production');
  }

  console.warn(`\u26a0\ufe0f ${message}`);
}

// --- Registration policy ----------------------------------------------------
// Optional guard so only company addresses can self-register, e.g. ALLOWED_EMAIL_DOMAIN=webengage.com
const ALLOWED_EMAIL_DOMAIN = (process.env.ALLOWED_EMAIL_DOMAIN || '')
  .trim()
  .toLowerCase()
  .replace(/^@/, '');

const EMAIL_REGEX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MIN_PASSWORD_LENGTH = 8;

// --- Phone verification -----------------------------------------------------
// Registration is India-only for now: the form takes 10 digits and the SMS goes
// out to +91<digits>.
const PHONE_COUNTRY_CODE = process.env.PHONE_COUNTRY_CODE || '+91';
const PHONE_REGEX = /^\d{10}$/;

const OTP_LENGTH = 4;
const OTP_TTL_SECONDS = Number(process.env.OTP_TTL_SECONDS || 300); // 5 minutes
const OTP_MAX_ATTEMPTS = 5;
const OTP_RESEND_COOLDOWN_SECONDS = 30;

// --- WebEngage transactional campaign ---------------------------------------
const WEBENGAGE_API_KEY = process.env.WEBENGAGE_API_KEY || '';
const WEBENGAGE_OTP_URL =
  process.env.WEBENGAGE_OTP_URL ||
  'https://api.webengage.com/v2/accounts/76aba26/experiments/~24clqpf/transaction';
const WEBENGAGE_OTP_TTL = Number(process.env.WEBENGAGE_OTP_TTL || 60);

// The campaign is triggered against one fixed WebEngage user, the same id its
// sample cURL uses. The recipient comes from overrideData.phone, so this does
// not need to identify the person signing up.
const WEBENGAGE_OTP_USER_ID = process.env.WEBENGAGE_OTP_USER_ID || 'shubham01';

// --- Images -----------------------------------------------------------------
const S3_BUCKET_NAME = process.env.S3_BUCKET_NAME || 'my-studio-assets';

const IMAGE_FETCH_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
  Referer: 'https://www.google.com/',
};

// Source images are content-addressed (UUID filenames on S3/afiles), so a
// fetched image is cached for a long time rather than re-pulled hourly. If an
// image is ever replaced *at the same URL*, bust it with a query parameter or
// drop the `img_buffer:` / `img_meta:` keys.
const IMAGE_CACHE_TTL_SECONDS = Number(process.env.IMAGE_CACHE_TTL_SECONDS || 86400);

// The in-memory LRU never expires, so a hot image would keep being served from
// memory while its Redis copy quietly expired. Every memory hit re-asserts the
// Redis TTL, but at most once per key per this interval so the fast path does
// not spend a round trip on every render.
const IMAGE_CACHE_REFRESH_SECONDS = Number(process.env.IMAGE_CACHE_REFRESH_SECONDS || 300);

// Pre-compiled regex for placeholder replacement
const PLACEHOLDER_REGEX = /\{\{([\w\-]+)\}\}/g;

// --- Countdown timers -------------------------------------------------------
// Frames are one per second, so this is also the length of the animation. Sixty
// is the number every comparable service settles on: long enough that a reader
// sees the clock move, short enough that the GIF stays small and the next open
// re-fetches a fresh one.
const TIMER_FRAMES = Number(process.env.TIMER_FRAMES || 60);
const TIMER_MAX_FRAMES = Number(process.env.TIMER_MAX_FRAMES || 120);

// A creative wider than this is scaled down before any GIF work happens. Frame
// zero is the only full-canvas frame, but it is still the most expensive part
// of a response, and email clients cap display width around 600px anyway.
const TIMER_MAX_CANVAS_WIDTH = Number(process.env.TIMER_MAX_CANVAS_WIDTH || 1200);

// How long a built sprite bundle (palette, quantised background, digit tiles)
// stays in Redis. Rebuilding one costs a few hundred milliseconds of sharp and
// quantisation work; serving from it costs single-digit milliseconds.
const TIMER_SPRITE_TTL_SECONDS = Number(process.env.TIMER_SPRITE_TTL_SECONDS || 21600); // 6 hours
const TIMER_SPRITE_MEMORY_SLOTS = Number(process.env.TIMER_SPRITE_MEMORY_SLOTS || 24);

// The response cache. Two opens of the same campaign in the same second want
// byte-identical GIFs, and on a large send there are thousands of them, so the
// generated bytes are held for a moment and shared. This never reaches the
// recipient's client \u2014 the response still goes out with no-store.
const TIMER_RESPONSE_CACHE_SECONDS = Number(process.env.TIMER_RESPONSE_CACHE_SECONDS || 2);

// Expired timers render the same picture forever, so they are worth holding on
// to for longer than a live frame.
const TIMER_EXPIRED_CACHE_SECONDS = Number(process.env.TIMER_EXPIRED_CACHE_SECONDS || 3600);

// Evergreen timers ("24 hours from your first open") need somewhere to remember
// when a given recipient first saw the image.
const TIMER_EVERGREEN_TTL_SECONDS = Number(process.env.TIMER_EVERGREEN_TTL_SECONDS || 90 * 86400);

// The timer row itself. Before this existed, every single email open ran a
// SELECT against MySQL — the creative was cached at every other layer, and the
// one lookup in front of them all was not. Memory first, then Redis, and the
// database only when both miss.
const TIMER_CONFIG_CACHE_SECONDS = Number(process.env.TIMER_CONFIG_CACHE_SECONDS || 300);
const TIMER_CONFIG_MEMORY_SECONDS = Number(process.env.TIMER_CONFIG_MEMORY_SECONDS || 30);
const TIMER_CONFIG_MEMORY_SLOTS = Number(process.env.TIMER_CONFIG_MEMORY_SLOTS || 256);

// How long one worker may hold the cluster-wide lock while it builds a sprite
// bundle, and how long the others wait for the result before building it
// themselves.
const TIMER_SPRITE_LOCK_MS = Number(process.env.TIMER_SPRITE_LOCK_MS || 20000);
const TIMER_SPRITE_LOCK_WAIT_MS = Number(process.env.TIMER_SPRITE_LOCK_WAIT_MS || 8000);

// Template rows come back from Redis today, which is still a network round trip
// on a path that runs per email open. A short memory copy in front of it makes
// the common case free.
const TEMPLATE_MEMORY_SECONDS = Number(process.env.TEMPLATE_MEMORY_SECONDS || 30);
const TEMPLATE_MEMORY_SLOTS = Number(process.env.TEMPLATE_MEMORY_SLOTS || 256);
const TEMPLATE_CACHE_SECONDS = Number(process.env.TEMPLATE_CACHE_SECONDS || 86400);

// Headers that stop Gmail's image proxy, Outlook and every CDN in between from
// answering the next open out of a cache. Without these the reader sees the
// countdown from whenever the image was first fetched.
const NO_STORE_HEADERS = {
  'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0, s-maxage=0, proxy-revalidate',
  Pragma: 'no-cache',
  Expires: '0',
  'Surrogate-Control': 'no-store',
  'CDN-Cache-Control': 'no-store',
};

const CORS_ORIGINS = ['https://ishubh-10.github.io', 'http://localhost:3000', 'http://localhost:3001'];

module.exports = {
  ROOT_DIR,
  PORT,
  WORKER_COUNT,
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_SSL,
  DB_CONNECT_TIMEOUT_MS,
  DB_POOL_TOTAL,
  DB_CONNECTION_LIMIT,
  DB_QUEUE_LIMIT,
  RENDER_CONCURRENCY,
  RENDER_QUEUE_LIMIT,
  RENDER_YIELD_FRAMES,
  PUBLIC_DIR,
  SESSION_COOKIE,
  SESSION_TTL_SECONDS,
  SESSION_SECRET,
  ALLOWED_EMAIL_DOMAIN,
  EMAIL_REGEX,
  MIN_PASSWORD_LENGTH,
  PHONE_COUNTRY_CODE,
  PHONE_REGEX,
  OTP_LENGTH,
  OTP_TTL_SECONDS,
  OTP_MAX_ATTEMPTS,
  OTP_RESEND_COOLDOWN_SECONDS,
  WEBENGAGE_API_KEY,
  WEBENGAGE_OTP_URL,
  WEBENGAGE_OTP_TTL,
  WEBENGAGE_OTP_USER_ID,
  S3_BUCKET_NAME,
  IMAGE_FETCH_HEADERS,
  IMAGE_CACHE_TTL_SECONDS,
  IMAGE_CACHE_REFRESH_SECONDS,
  PLACEHOLDER_REGEX,
  TIMER_FRAMES,
  TIMER_MAX_FRAMES,
  TIMER_MAX_CANVAS_WIDTH,
  TIMER_SPRITE_TTL_SECONDS,
  TIMER_SPRITE_MEMORY_SLOTS,
  TIMER_RESPONSE_CACHE_SECONDS,
  TIMER_EXPIRED_CACHE_SECONDS,
  TIMER_EVERGREEN_TTL_SECONDS,
  TIMER_CONFIG_CACHE_SECONDS,
  TIMER_CONFIG_MEMORY_SECONDS,
  TIMER_CONFIG_MEMORY_SLOTS,
  TIMER_SPRITE_LOCK_MS,
  TIMER_SPRITE_LOCK_WAIT_MS,
  TEMPLATE_MEMORY_SECONDS,
  TEMPLATE_MEMORY_SLOTS,
  TEMPLATE_CACHE_SECONDS,
  NO_STORE_HEADERS,
  CORS_ORIGINS,
};

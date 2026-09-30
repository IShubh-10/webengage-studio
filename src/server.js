/**
 * Process entry point: loads the environment, forks workers in production,
 * starts the HTTP server, prepares the schema, and shuts down cleanly.
 */

require('./config/env');

// Loaded here, in the master, before anything is forked. Configuration that
// refuses to start — a missing SESSION_SECRET in production — has to stop the
// master: if it only failed inside the workers, every one of them would die on
// require and the restart handler below would fork them again, forever.
require('./config');

const cluster = require('cluster');
const os = require('os');
const sharp = require('sharp');

if (cluster.isMaster && process.env.NODE_ENV === 'production') {
  const numWorkers = Number(process.env.WORKERS) || os.cpus().length;
  let shuttingDown = false;

  console.log(`🚀 Master process ${process.pid} forking ${numWorkers} workers...`);

  for (let i = 0; i < numWorkers; i++) {
    // Workers size their MySQL pool and their sharp thread budget from this.
    // os.cpus() is no substitute: inside a container it reports the host's
    // cores, so a worker would happily claim eight cores' worth of a half-core
    // instance.
    cluster.fork({ WORKER_COUNT: String(numWorkers) });
  }

  // A worker that dies on startup would otherwise be restarted forever, pinning
  // the CPU and burying the real error in a scroll of restart messages. Crashes
  // that happen after a worker has been up for a while are the ordinary kind
  // and still restart without limit.
  const CRASH_WINDOW_MS = 60000;
  const MAX_CRASHES_IN_WINDOW = 10;
  let recentCrashes = [];

  cluster.on('exit', (worker, code, signal) => {
    if (shuttingDown) return;

    const now = Date.now();
    recentCrashes = recentCrashes.filter((at) => now - at < CRASH_WINDOW_MS);
    recentCrashes.push(now);

    if (recentCrashes.length > MAX_CRASHES_IN_WINDOW) {
      console.error(
        `\u274c ${recentCrashes.length} worker crashes in ${CRASH_WINDOW_MS / 1000}s — ` +
          'this is a startup failure, not a transient one. Stopping so the error above is readable.'
      );
      process.exit(1);
    }

    console.warn(
      `⚠️ Worker ${worker.process.pid} exited (${signal || code}). Restarting...`
    );
    cluster.fork({ WORKER_COUNT: String(numWorkers) });
  });

  process.on('SIGTERM', () => {
    // Without this the exit handler above would treat a deliberate shutdown as
    // a crash and fork replacements for the workers it is killing.
    shuttingDown = true;
    console.log('🛑 Master shutting down gracefully...');
    for (const id in cluster.workers) {
      cluster.workers[id].kill();
    }
    process.exit(0);
  });

  return; // Master process ends here
}

// --- sharp, sized for this worker's share of the box -------------------------
// These used to be set twice, and sharp.concurrency was a flat 4 per worker —
// so eight workers asked for 32 native threads on a machine with eight cores.
// Oversubscribing does not add throughput, it adds context switching and
// memory. The libuv pool is shared by sharp, fs and DNS, so it is sized above
// sharp's own budget rather than at it.
const WORKERS_ON_BOX = Math.max(1, Number(process.env.WORKER_COUNT || 1));
const SHARP_CONCURRENCY = Math.max(
  1,
  Number(process.env.SHARP_CONCURRENCY || Math.ceil(os.cpus().length / WORKERS_ON_BOX))
);

process.env.UV_THREADPOOL_SIZE =
  process.env.UV_THREADPOOL_SIZE || String(Math.max(8, SHARP_CONCURRENCY * 4));

sharp.cache({ memory: 256, items: 100 });
sharp.concurrency(SHARP_CONCURRENCY);

const app = require('./app');
const db = require('./config/db');
const redisState = require('./config/redis').state;
const { initRedis } = require('./config/redis');
const { initInvalidation, closeInvalidation } = require('./lib/invalidation');
const {
  ensureAuthSchema,
  ensureTemplateSchema,
  ensureTimerSchema,
  ensureStatsSchema,
} = require('./db/schema');
const { flushNow } = require('./services/openCounter');
const { startedHere, connectedTo, note, print } = require('./lib/bootReport');
const {
  PORT,
  WORKER_COUNT,
  WEBENGAGE_API_KEY,
  WEBENGAGE_OTP_URL,
  RATE_LIMIT_ENABLED,
} = require('./config');

/*
 * The four tables the server guarantees on boot. Collected into one line of the
 * summary rather than four of their own, because "they are all there" is the
 * only thing worth a line when nothing is wrong. A failure still prints
 * immediately and in full — it must not wait for a summary printed afterwards —
 * and the summary then names which table did not come up.
 */
const SCHEMA_STEPS = [
  ['users', ensureAuthSchema, 'login and register will fail'],
  ['templates', ensureTemplateSchema, 'saving and listing templates will fail'],
  ['timers', ensureTimerSchema, 'saving and listing timers will fail'],
  // Counting is not worth refusing to serve images over: the counter retries
  // the schema on its next flush and everything else works meanwhile.
  ['asset_opens', ensureStatsSchema, 'stats will be empty'],
];

const server = app.listen(PORT, async () => {
  await initRedis();

  // Has to come after Redis: this is how a save in one worker reaches the
  // in-memory caches of all the others.
  initInvalidation();

  startedHere(`HTTP listening on http://localhost:${PORT}`);

  const ready = [];
  const failed = [];

  for (const [table, ensure, consequence] of SCHEMA_STEPS) {
    try {
      await ensure();
      ready.push(table);
    } catch (err) {
      failed.push(table);
      console.error(`❌ Could not prepare the ${table} table — ${consequence}: ${err.message}`);
    }
  }

  startedHere(
    `schema ready — ${ready.join(', ') || 'nothing'}` +
      (failed.length ? `   (FAILED: ${failed.join(', ')})` : '')
  );

  // The OTP campaign is WebEngage's, running on WebEngage's servers. This
  // process calls it; it does not host it.
  if (WEBENGAGE_API_KEY) {
    let host = WEBENGAGE_OTP_URL;
    try {
      host = new URL(WEBENGAGE_OTP_URL).host;
    } catch (err) {
      // Leave the raw value in the summary — a URL that will not parse is
      // worth seeing in full.
    }
    connectedTo('OTP', `${host} (registration codes)`);
  } else {
    connectedTo('OTP', 'not configured — codes are printed in this log only');
    note(
      '⚠️ WEBENGAGE_API_KEY is not set, so registration OTPs will NOT be delivered.\n' +
        '      Add it to .env (see .env.example) and restart. Until then each code is\n' +
        '      printed here so sign-up can still be tested.'
    );
  }

  // Left off after a load test, this is an open door — say so every boot rather
  // than letting it disappear into the deploy log.
  if (!RATE_LIMIT_ENABLED) {
    note(
      '⚠️ RATE_LIMIT_ENABLED=false — every per-IP rate limit is bypassed.\n' +
        '      This is the load-testing switch. Unset it before serving real traffic:\n' +
        '      OTP sends, login attempts and timer GIF requests are all uncapped.'
    );
  }

  print(
    cluster.worker
      ? `Webengage Studio — worker ${cluster.worker.id} of ${WORKER_COUNT}`
      : 'Webengage Studio'
  );
});

async function gracefulShutdown() {
  console.log('🛑 Graceful shutdown initiated...');

  server.close(async () => {
    console.log('✅ HTTP server closed');

    // Before the pool goes: whatever this worker has counted since its last
    // flush is still only in memory, and a deploy would otherwise throw away
    // the last few seconds of every creative's numbers.
    await flushNow();

    try {
      await closeInvalidation();
      if (redisState.client) {
        // Closing this process's connection. The cache itself is another
        // service — a Homebrew service locally, its own EC2 instance in the
        // deployment — and keeps running with every other client attached.
        await redisState.client.quit();
        console.log('✅ Redis connection closed (the cache itself keeps running)');
      }
    } catch (err) {
      console.error('Error closing Redis:', err.message);
    }

    try {
      await db.end();
      console.log('✅ MySQL pool closed (the database itself keeps running)');
    } catch (err) {
      console.error('Error closing MySQL:', err.message);
    }

    process.exit(0);
  });

  // Force shutdown after 30 seconds
  setTimeout(() => {
    console.error('❌ Forced shutdown after timeout');
    process.exit(1);
  }, 30000);
}

process.on('SIGTERM', gracefulShutdown);
process.on('SIGINT', gracefulShutdown);

// Handle uncaught exceptions
process.on('uncaughtException', (err) => {
  console.error('💥 Uncaught exception:', err);
  gracefulShutdown();
});

process.on('unhandledRejection', (reason, promise) => {
  console.error('💥 Unhandled rejection at:', promise, 'reason:', reason);
});

module.exports = app;

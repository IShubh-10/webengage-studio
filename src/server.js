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
const { ensureAuthSchema, ensureTemplateSchema, ensureTimerSchema } = require('./db/schema');
const { PORT, WEBENGAGE_API_KEY, WEBENGAGE_OTP_URL } = require('./config');

const server = app.listen(PORT, async () => {
  await initRedis();

  // Has to come after Redis: this is how a save in one worker reaches the
  // in-memory caches of all the others.
  initInvalidation();

  try {
    await ensureAuthSchema();
    console.log('✅ Auth schema ready (users table)');
  } catch (err) {
    console.error('❌ Could not prepare the users table — login/register will fail:', err.message);
  }

  try {
    await ensureTemplateSchema();
    console.log('✅ Template schema ready (templates.elements JSON)');
  } catch (err) {
    console.error('❌ Could not prepare the templates table:', err.message);
  }

  try {
    await ensureTimerSchema();
    console.log('✅ Timer schema ready (timers.config JSON)');
  } catch (err) {
    console.error('❌ Could not prepare the timers table:', err.message);
  }

  if (WEBENGAGE_API_KEY) {
    console.log(`✅ OTP delivery configured (${WEBENGAGE_OTP_URL})`);
  } else {
    console.warn(
      '⚠️ WEBENGAGE_API_KEY is not set — registration OTPs will NOT be delivered.\n' +
        '   Add it to .env (see .env.example) and restart:  WEBENGAGE_API_KEY=your-key\n' +
        '   Until then, each code is printed in this log so sign-up can still be tested.'
    );
  }

  console.log(`✨ Worker ${cluster.worker?.id || 'standalone'} listening on http://localhost:${PORT}`);
});

async function gracefulShutdown() {
  console.log('🛑 Graceful shutdown initiated...');

  server.close(async () => {
    console.log('✅ HTTP server closed');

    try {
      await closeInvalidation();
      if (redisState.client) {
        await redisState.client.quit();
        console.log('✅ Redis connection closed');
      }
    } catch (err) {
      console.error('Error closing Redis:', err.message);
    }

    try {
      await db.end();
      console.log('✅ MySQL pool closed');
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

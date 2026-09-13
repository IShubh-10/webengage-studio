/**
 * MySQL connection pool, shared by every repository and route.
 *
 * The pool belongs to one worker, not to the deployment — see DB_POOL_TOTAL in
 * config/index.js for why the limit is divided by the worker count rather than
 * set per process.
 */

const mysql = require('mysql2/promise');

const { DB_CONNECTION_LIMIT, DB_QUEUE_LIMIT, WORKER_COUNT } = require('./index');

const db = mysql.createPool({
  host: process.env.DB_HOST || 'localhost',
  user: process.env.DB_USER || 'root',
  password: process.env.DB_PASSWORD || 'qwer1234',
  database: process.env.DB_NAME || 'personalize_studio',
  waitForConnections: true,
  connectionLimit: DB_CONNECTION_LIMIT,
  // Bounded on purpose: past this the pool rejects instead of parking requests
  // nobody is waiting for any more.
  queueLimit: DB_QUEUE_LIMIT,
  enableKeepAlive: true,
  // mysql2 spells this without the unit suffix; the old name was silently
  // ignored (and warned that a future version would throw).
  keepAliveInitialDelay: 30000,
});

if (process.env.NODE_ENV === 'production') {
  console.log(
    `🗄️ MySQL pool: ${DB_CONNECTION_LIMIT} connections per worker x ${WORKER_COUNT} worker(s) = ${
      DB_CONNECTION_LIMIT * WORKER_COUNT
    } max — keep this under the server's max_connections`
  );
}

module.exports = db;

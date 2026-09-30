/**
 * MySQL connection pool, shared by every repository and route.
 *
 * Every connection detail — host, port, user, password, database, TLS — comes
 * from config/index.js, which reads it from the environment. Nothing is
 * hardcoded here: the credentials differ per environment, a password in the
 * repository is a password everyone with read access has, and a managed
 * database (Railway, Aiven, …) does not listen on 3306, so leaving the port
 * out silently dials the wrong one.
 *
 * The pool belongs to one worker, not to the deployment — see DB_POOL_TOTAL in
 * config/index.js for why the limit is divided by the worker count rather than
 * set per process.
 */

const mysql = require('mysql2/promise');

const { connectedTo } = require('../lib/bootReport');

const {
  DB_HOST,
  DB_PORT,
  DB_USER,
  DB_PASSWORD,
  DB_NAME,
  DB_SSL,
  DB_CONNECT_TIMEOUT_MS,
  DB_CONNECTION_LIMIT,
  DB_QUEUE_LIMIT,
  WORKER_COUNT,
} = require('./index');

const db = mysql.createPool({
  host: DB_HOST,
  port: DB_PORT,
  user: DB_USER,
  password: DB_PASSWORD,
  database: DB_NAME,
  // undefined when TLS is off — mysql2 treats any object here as "use TLS"
  ssl: DB_SSL,
  // A database behind a provider's TCP proxy answers in seconds rather than
  // milliseconds, and the first connection of a cold worker is the slowest one.
  connectTimeout: DB_CONNECT_TIMEOUT_MS,
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

// The database runs somewhere else entirely — a managed host reached over the
// public internet — so it belongs in the boot summary's "connected to" half
// rather than among the things this process starts. Registered in every
// environment, not only production: knowing which database a local run is
// pointed at is worth exactly as much.
connectedTo(
  'MySQL',
  `${DB_USER}@${DB_HOST}:${DB_PORT}/${DB_NAME} (TLS ${DB_SSL ? 'on' : 'off'})`,
  `${DB_CONNECTION_LIMIT} connections per worker x ${WORKER_COUNT} = ${
    DB_CONNECTION_LIMIT * WORKER_COUNT
  } max — keep under the server's max_connections`
);

module.exports = db;

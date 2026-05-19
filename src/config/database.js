/**
 * config/database.js
 * 
 * PostgreSQL connection pool using the `pg` library.
 * Uses a connection pool (max 20 connections) for scalability.
 * On Google Cloud Run, this connects to Cloud SQL via the
 * Cloud SQL Auth Proxy (automatically injected by Cloud Run).
 */

const { Pool } = require('pg');
const logger = require('../utils/logger');

// ─── Connection Pool Configuration ───────────────────────────────────────────
// Pool size of 20 handles high concurrency. Cloud SQL supports 500+ connections.
// For 1M users: deploy multiple Cloud Run instances, each with its own pool.
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: 20,                  // Maximum simultaneous DB connections
  idleTimeoutMillis: 30000, // Close idle connections after 30s
  connectionTimeoutMillis: 5000, // Fail fast if DB is unreachable

  // SSL required for Google Cloud SQL in production
  ssl: process.env.NODE_ENV === 'production'
    ? { rejectUnauthorized: false }
    : false,
});

// ─── Pool Event Listeners ─────────────────────────────────────────────────────
pool.on('connect', () => {
  logger.debug('New DB client connected to pool');
});

pool.on('error', (err) => {
  // Log unexpected DB errors — don't crash the server
  logger.error('Unexpected DB pool error:', err);
});

// ─── Query Helper ─────────────────────────────────────────────────────────────
/**
 * Execute a parameterized SQL query.
 * Always use parameterized queries — NEVER string-concatenate SQL (SQL injection risk).
 * 
 * Usage:
 *   const { rows } = await query('SELECT * FROM users WHERE email = $1', [email]);
 */
const query = async (text, params) => {
  const start = Date.now();
  try {
    const result = await pool.query(text, params);
    const duration = Date.now() - start;
    logger.debug('Query executed', { duration, rows: result.rowCount });
    return result;
  } catch (err) {
    logger.error('Query error', { text, params, error: err.message });
    throw err;
  }
};

// ─── Transaction Helper ───────────────────────────────────────────────────────
/**
 * Run multiple queries as a single atomic transaction.
 * Automatically rolls back on error — no partial writes.
 * 
 * Usage:
 *   await transaction(async (client) => {
 *     await client.query('INSERT INTO users ...');
 *     await client.query('INSERT INTO profiles ...');
 *   });
 */
const transaction = async (callback) => {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await callback(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK');
    logger.error('Transaction rolled back:', err.message);
    throw err;
  } finally {
    client.release(); // Always release client back to pool
  }
};

module.exports = { query, transaction, pool };

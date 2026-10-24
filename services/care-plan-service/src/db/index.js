'use strict';

const fs = require('fs');
const path = require('path');
const { Pool, types } = require('pg');

// Return SQL DATE columns as plain 'YYYY-MM-DD' strings. The default converts them to a JS Date at
// local midnight, which shifts birthdays/visit dates by a day when serialised as UTC (e.g. in Manila, UTC+8).
types.setTypeParser(1082, (v) => v);
const logger = require('../lib/logger');

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  max: Number(process.env.DB_POOL_MAX || 10),
  idleTimeoutMillis: 30000,
  connectionTimeoutMillis: 5000,
  ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
});
pool.on('error', (err) => logger.error('pg pool error', err));

async function migrate() {
  await pool.query(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  const seedFile = path.join(__dirname, 'seed.sql');
  if (process.env.SEED_DEMO_DATA === 'true' && fs.existsSync(seedFile)) {
    await pool.query(fs.readFileSync(seedFile, 'utf8'));
  }
  // After the seed, so seeded and pre-existing plans alike become version 1 (idempotent).
  await pool.query(fs.readFileSync(path.join(__dirname, 'carryover.sql'), 'utf8'));
  logger.info('database migrated');
}

/** Runs fn(client) inside BEGIN/COMMIT, rolling back on error. */
async function withTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

async function waitForDb(retries = 20, delayMs = 1500) {
  for (let i = 1; i <= retries; i += 1) {
    try {
      await pool.query('SELECT 1');
      return;
    } catch (err) {
      logger.warn('waiting for database', { attempt: i, error: err.message });
      await new Promise((r) => setTimeout(r, delayMs));
    }
  }
  throw new Error('Database not reachable');
}

module.exports = { pool, migrate, withTransaction, waitForDb };

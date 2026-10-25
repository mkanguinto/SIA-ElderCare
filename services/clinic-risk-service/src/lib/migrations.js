'use strict';

/**
 * Versioned database migrations (in addition to the idempotent schema.sql applied at start-up).
 *
 * Files in <service>/src/db/migrations named NNNN_description.sql run once, in name order, each in its
 * own transaction, and are recorded in schema_migrations. A migration that fails rolls back and stops
 * start-up, so a service never runs against a half-migrated database.
 *
 *   await runMigrations(pool, path.join(__dirname, 'migrations'), logger);
 */
const fs = require('fs');
const path = require('path');

async function runMigrations(pool, dir, logger) {
  await pool.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    id TEXT PRIMARY KEY, applied_at TIMESTAMPTZ NOT NULL DEFAULT now())`);
  if (!fs.existsSync(dir)) return [];
  const files = fs.readdirSync(dir).filter((f) => /^\d{4}_[a-z0-9_]+\.sql$/.test(f)).sort();
  const { rows } = await pool.query('SELECT id FROM schema_migrations');
  const done = new Set(rows.map((r) => r.id));
  const applied = [];
  for (const file of files) {
    const id = file.replace(/\.sql$/, '');
    if (done.has(id)) continue;
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query(fs.readFileSync(path.join(dir, file), 'utf8'));
      await client.query('INSERT INTO schema_migrations (id) VALUES ($1)', [id]);
      await client.query('COMMIT');
      applied.push(id);
      if (logger) logger.info('migration applied', { migration: id });
    } catch (err) {
      await client.query('ROLLBACK').catch(() => {});
      throw new Error(`migration ${id} failed: ${err.message}`);
    } finally {
      client.release();
    }
  }
  return applied;
}

module.exports = { runMigrations };

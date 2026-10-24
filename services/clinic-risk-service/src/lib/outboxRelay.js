'use strict';

/**
 * Transactional outbox + relay (Topic 12 "Persistence is not the whole story").
 *
 * A service never publishes directly from a request handler. It writes the event into its own
 * outbox_events table inside the same DB transaction as the business change, then this relay
 * publishes it to RabbitMQ and marks it delivered only after the broker's publisher confirm.
 * Result: no "row saved but event lost" and no "event sent but row rolled back".
 *
 * If the broker is down, rows stay pending and are retried with exponential backoff; after
 * OUTBOX_MAX_ATTEMPTS they are marked failed (visible in /health) for manual follow-up.
 *
 * Table (each service, own database):
 *   outbox_events(id BIGSERIAL PK, event_id UUID, event_type TEXT, target TEXT, payload JSONB,
 *                 status TEXT, attempts INT, next_attempt_at TIMESTAMPTZ, last_error TEXT,
 *                 created_at TIMESTAMPTZ, delivered_at TIMESTAMPTZ)
 */
const crypto = require('crypto');

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {object} o.logger
 * @param {(row: {routingKey:string, event:object, target:string}) => Promise<void>} o.deliver
 * @param {string} o.source            service name written into every event
 * @param {number} [o.maxAttempts]
 * @param {number} [o.pollMs]
 * @param {(client: import('pg').PoolClient, row: {event_type:string, payload:object}) => Promise<void>} [o.onDelivered]
 *        runs in the same transaction right after a row is marked delivered (e.g. advance a business status)
 */
function createOutbox({ pool, logger, deliver, source, onDelivered, maxAttempts = Number(process.env.OUTBOX_MAX_ATTEMPTS || 10), pollMs = Number(process.env.OUTBOX_POLL_MS || 2000) }) {
  const BATCH = 25;
  let running = false;
  let timer = null;

  /** Inserts the event using the caller's transaction client. Returns the full event. */
  async function enqueue(client, eventType, payload, { target = 'broker', correlationId } = {}) {
    const event = {
      eventId: crypto.randomUUID(),
      type: eventType,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      source,
      ...(correlationId ? { correlationId } : {}),
      ...payload,
    };
    await client.query('INSERT INTO outbox_events (event_id, event_type, target, payload) VALUES ($1, $2, $3, $4)', [event.eventId, eventType, target, event]);
    return event;
  }

  async function flush() {
    if (running) return;
    running = true;
    try {
      for (;;) {
        const client = await pool.connect();
        let rows = [];
        try {
          await client.query('BEGIN');
          ({ rows } = await client.query(
            `SELECT id, event_type, target, payload, attempts FROM outbox_events
              WHERE status = 'pending' AND next_attempt_at <= now()
              ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
            [BATCH],
          ));
          for (const row of rows) {
            try {
              await deliver({ routingKey: row.event_type, event: row.payload, target: row.target });
              await client.query(`UPDATE outbox_events SET status = 'delivered', delivered_at = now(), attempts = attempts + 1, last_error = NULL WHERE id = $1`, [row.id]);
              if (onDelivered) {
                // A failing hook must not make a delivered event look undelivered (it would be published twice).
                await client.query('SAVEPOINT on_delivered');
                try {
                  await onDelivered(client, row);
                  await client.query('RELEASE SAVEPOINT on_delivered');
                } catch (hookErr) {
                  await client.query('ROLLBACK TO SAVEPOINT on_delivered');
                  logger.warn('outbox onDelivered hook failed', { eventId: row.payload.eventId, error: hookErr.message });
                }
              }
            } catch (err) {
              const attempts = row.attempts + 1;
              const failed = err.permanent || attempts >= maxAttempts;
              const backoffSec = Math.min(300, 2 ** attempts);
              await client.query(
                `UPDATE outbox_events SET attempts = $2, last_error = $3, status = $4,
                        next_attempt_at = now() + ($5 || ' seconds')::interval WHERE id = $1`,
                [row.id, attempts, String(err.message).slice(0, 500), failed ? 'failed' : 'pending', String(backoffSec)],
              );
              (failed ? logger.error : logger.warn)(failed ? 'outbox event FAILED - manual follow-up required' : 'outbox publish failed, will retry', {
                eventId: row.payload.eventId, type: row.event_type, attempts, error: err.message,
              });
            }
          }
          await client.query('COMMIT');
        } catch (err) {
          await client.query('ROLLBACK').catch(() => {});
          logger.error('outbox flush error', { error: err.message });
          rows = [];
        } finally {
          client.release();
        }
        if (rows.length < BATCH) break;
      }
    } finally {
      running = false;
    }
  }

  /** Publish soon (after the caller's COMMIT) instead of waiting for the next poll. */
  function kick() {
    setImmediate(() => flush().catch((e) => logger.error('outbox flush', { error: e.message })));
  }

  function start() {
    timer = setInterval(() => flush().catch((e) => logger.error('outbox loop', { error: e.message })), pollMs);
    if (timer.unref) timer.unref();
    return timer;
  }

  function stop() {
    if (timer) clearInterval(timer);
  }

  async function stats() {
    const { rows } = await pool.query('SELECT status, count(*)::int AS count FROM outbox_events GROUP BY status');
    return Object.fromEntries(rows.map((r) => [r.status, r.count]));
  }

  /** Puts failed rows back to pending (operator action after fixing the cause). */
  async function retryFailed() {
    const { rowCount } = await pool.query(`UPDATE outbox_events SET status = 'pending', attempts = 0, next_attempt_at = now() WHERE status = 'failed'`);
    if (rowCount) kick();
    return { requeued: rowCount };
  }

  return { enqueue, flush, kick, start, stop, stats, retryFailed };
}

module.exports = { createOutbox };

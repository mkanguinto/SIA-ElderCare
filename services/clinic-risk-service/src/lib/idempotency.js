'use strict';

/**
 * Idempotent Receiver (Topic 11 EIP, Topic 12 "At-least-once means duplicates are possible").
 *
 * The eventId is recorded in processed_events IN THE SAME local transaction as the business
 * change. Outcomes:
 *   - first delivery   -> insert succeeds, handler runs, both commit together
 *   - redelivery       -> primary-key conflict, nothing is applied twice, caller ACKs the duplicate
 *   - handler throws   -> both roll back, so a retry can process the event again
 *
 * Table required in every consuming service's own database:
 *   CREATE TABLE processed_events (event_id UUID PRIMARY KEY, received_at TIMESTAMPTZ NOT NULL DEFAULT now());
 */

/**
 * @param {import('pg').Pool} pool
 * @param {string} eventId
 * @param {(client: import('pg').PoolClient) => Promise<any>} fn
 * @returns {Promise<{duplicate: boolean, result?: any}>}
 */
async function processOnce(pool, eventId, fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const ins = await client.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [eventId]);
    if (!ins.rowCount) {
      await client.query('ROLLBACK');
      return { duplicate: true };
    }
    const result = await fn(client);
    await client.query('COMMIT');
    return { duplicate: false, result };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

module.exports = { processOnce };

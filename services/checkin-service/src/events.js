'use strict';

/** This service's connection to the integration middleware (RabbitMQ or HTTP fallback). */
const { pool } = require('./db');
const logger = require('./lib/logger');
const { createEventing } = require('./lib/eventing');

// Once a check-in's event reaches the broker it is in the clinic's queue: received -> awaiting_review.
async function onDelivered(client, row) {
  const id = row.payload && row.payload.checkin && row.payload.checkin.id;
  if (!id) return;
  const { rowCount } = await client.query(
    `UPDATE checkins SET status = 'awaiting_review' WHERE id = $1 AND status = 'received'`, [id],
  );
  if (rowCount) {
    await client.query(
      `INSERT INTO checkin_status_log (checkin_id, status, changed_by, note) VALUES ($1, 'awaiting_review', 'system', $2)`,
      [id, `sent to the clinic queue (${row.event_type})`],
    );
  }
}

module.exports = createEventing({ pool, logger, source: 'checkin-service', onDelivered });

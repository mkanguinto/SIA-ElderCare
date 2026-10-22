'use strict';

/**
 * Transactional outbox - first step of the Check-in -> Alert -> Clinic Queue saga (Section 15).
 *
 * Events are inserted in the same DB transaction as the check-in, then the relay publishes them
 * to the RabbitMQ topic exchange "eldercare.events" (routing key = event type). Which services
 * receive an event is decided by the broker bindings, not by this service:
 *
 *   checkin.anomaly_detected -> alert-service.checkin-events, clinic-risk-service.events
 *   checkin.missed           -> alert-service.checkin-events, clinic-risk-service.events
 *   checkin.normal           -> clinic-risk-service.events
 *
 * Without a broker (EVENT_TRANSPORT=http) the same rows are POSTed to /internal/events.
 */
const events = require('./events');

/** `targets` is kept for backwards compatibility; routing now comes from the broker bindings. */
// eslint-disable-next-line no-unused-vars
async function enqueueEvent(client, eventType, payload, targets) {
  return events.outbox.enqueue(client, eventType, payload);
}

module.exports = {
  enqueueEvent,
  flush: () => events.outbox.flush(),
  start: () => events.start(),
  stats: () => events.outbox.stats(),
};

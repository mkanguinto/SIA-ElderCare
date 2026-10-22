'use strict';

/**
 * Clinic Risk Queue Service
 * Owns: patient risk scores, clinic follow-up actions, triage status (Section 9).
 * Reachable only through the API Gateway (public routes) or peer services (/internal routes).
 */
require('dotenv').config();
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'clinic-risk-service';

const express = require('express');
const helmet = require('helmet');
const logger = require('./src/lib/logger');
const { pool, migrate, waitForDb } = require('./src/db');
const { breakerSnapshots } = require('./src/lib/resilientHttp');
const routes = require('./src/routes');
const events = require('./src/events');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '50kb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    const { rows: [q] } = await pool.query(`SELECT count(*) FILTER (WHERE status IN ('open','in_review','scheduled'))::int AS active FROM risk_queue`);
    res.json({ status: 'up', service: 'clinic-risk-service', db: 'up', activeQueueItems: q.active, messaging: await events.status(), circuitBreakers: breakerSnapshots() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', service: 'clinic-risk-service', db: 'down', error: err.message });
  }
});

app.use(events.adminRouter(express, require('./src/lib/internalAuth').requireInternalToken));
app.use(routes);
app.use((req, res) => res.status(404).json({ error: 'not_found' }));
// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request', message: 'Malformed JSON body' });
  logger.error('unhandled error', { requestId: req.get('x-request-id'), error: err.message, stack: err.stack });
  return res.status(500).json({ error: 'internal_error', requestId: req.get('x-request-id') });
});

async function main() {
  await waitForDb();
  await migrate();
  // RabbitMQ consumer: one durable queue for every event this service reacts to (topic bindings).
  await events.bus.subscribe({
    queue: 'clinic-risk-service.events',
    bindings: ['checkin.anomaly_detected', 'checkin.missed', 'checkin.normal', 'weather.risk_detected'],
    prefetch: Number(process.env.EVENT_PREFETCH || 10),
    handler: (evt) => routes.handleEvent(evt),
  });
  await events.start();
  const port = Number(process.env.PORT || 4003);
  const server = app.listen(port, () => logger.info('clinic-risk-service listening', { port }));
  const shutdown = () => server.close(async () => { await events.close(); await pool.end(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => { logger.error('startup failed', err); process.exit(1); });
}

module.exports = app;

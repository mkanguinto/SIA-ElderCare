'use strict';

/**
 * Daily Check-In Logger Service
 * Owns: patients, check-in history, vital trends, baselines (Section 9).
 * Reachable only through the API Gateway (public routes) or peer services (/internal routes).
 */
require('dotenv').config();
require('./src/lib/secrets').loadFileSecrets(); // *_FILE Docker secrets, before anything reads process.env
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'checkin-service';

const express = require('express');
const helmet = require('helmet');
const logger = require('./src/lib/logger');
const { pool, migrate, waitForDb } = require('./src/db');
const outbox = require('./src/outbox');
const events = require('./src/events');
const missedCheckinJob = require('./src/missedCheckinJob');
const routes = require('./src/routes');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '50kb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'up', service: 'checkin-service', db: 'up', outbox: await outbox.stats(), messaging: await events.status() });
  } catch (err) {
    res.status(503).json({ status: 'degraded', service: 'checkin-service', db: 'down', error: err.message });
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
  outbox.start();
  missedCheckinJob.start();
  const port = Number(process.env.PORT || 4001);
  const server = app.listen(port, () => logger.info('checkin-service listening', { port }));
  const shutdown = () => server.close(async () => { await events.close(); await pool.end(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => { logger.error('startup failed', err); process.exit(1); });
}

module.exports = app;

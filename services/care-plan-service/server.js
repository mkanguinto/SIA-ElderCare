'use strict';

/**
 * Care Plan Service (v2 Batch 4)
 * Owns: care plans, caregiver duty tasks (personal care, medical, meals, transport, emotional support,
 * home safety, communication, records) and their daily completions.
 * Reachable only through the API Gateway (public routes).
 */
require('dotenv').config();
require('./src/lib/secrets').loadFileSecrets(); // *_FILE Docker secrets, before anything reads process.env
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'care-plan-service';

const express = require('express');
const helmet = require('helmet');
const logger = require('./src/lib/logger');
const { pool, migrate, waitForDb } = require('./src/db');
const routes = require('./src/routes');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
app.use(express.json({ limit: '50kb' }));

app.get('/health', async (req, res) => {
  try {
    await pool.query('SELECT 1');
    res.json({ status: 'up', service: 'care-plan-service', db: 'up' });
  } catch (err) {
    res.status(503).json({ status: 'degraded', service: 'care-plan-service', db: 'down', error: err.message });
  }
});

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
  const port = Number(process.env.PORT || 4006);
  const server = app.listen(port, () => logger.info('care-plan-service listening', { port }));
  const shutdown = () => server.close(async () => { await pool.end(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => { logger.error('startup failed', err); process.exit(1); });
}

module.exports = app;

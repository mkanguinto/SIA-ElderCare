'use strict';

/**
 * Family Alert & Notification Service
 * Owns: alert rules, notification logs, family subscriber contacts (Section 9).
 * Integrates: TextBee SMS gateway (via RabbitMQ worker), OpenWeatherMap (weather mashup).
 * Messaging: consumes checkin.anomaly_detected / checkin.missed, publishes weather.risk_detected and
 * notification.sms.requested (transactional outbox -> RabbitMQ topic exchange eldercare.events).
 */
require('dotenv').config();
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'alert-service';

const express = require('express');
const helmet = require('helmet');
const logger = require('./src/lib/logger');
const { pool, migrate, waitForDb } = require('./src/db');
const smsWorker = require('./src/smsWorker');
const events = require('./src/events');
const mashup = require('./src/weatherAlertMashup');
const smsSender = require('./src/smsSender');
const { breakerSnapshots } = require('./src/lib/resilientHttp');
const routes = require('./src/routes');

const app = express();
app.disable('x-powered-by');
app.use(helmet());
// Keep the raw bytes: TextBee webhook signatures are computed over the exact request body.
app.use(express.json({ limit: '50kb', verify: (req, res, buf) => { req.rawBody = buf; } }));

app.get('/health', async (req, res) => {
  let db = 'up';
  try { await pool.query('SELECT 1'); } catch { db = 'down'; }
  const { rows } = db === 'up'
    ? await pool.query(`SELECT max(fetched_at) AS last_weather FROM weather_cache`)
    : { rows: [{}] };
  const body = {
    status: db === 'up' ? 'up' : 'degraded',
    service: 'alert-service',
    db,
    integrations: {
      sms: smsSender.mode(),
      openWeatherMap: process.env.OPENWEATHER_API_KEY ? 'configured' : 'not-configured',
      lastWeatherFetch: rows[0] && rows[0].last_weather,
    },
    messaging: db === 'up' ? await events.status() : null,
    circuitBreakers: breakerSnapshots(),
  };
  res.status(db === 'up' ? 200 : 503).json(body);
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
  // RabbitMQ consumers: family alerts for check-in events, and the TextBee SMS worker.
  await events.bus.subscribe({
    queue: 'alert-service.checkin-events',
    bindings: ['checkin.anomaly_detected', 'checkin.missed'],
    prefetch: Number(process.env.EVENT_PREFETCH || 10),
    handler: (evt) => routes.handleCheckinEvent(evt),
  });
  await smsWorker.start(events.bus);
  await events.start();
  mashup.startScheduler();
  const port = Number(process.env.PORT || 4002);
  const server = app.listen(port, () => logger.info('alert-service listening', { port, sms: smsSender.mode() }));
  const shutdown = () => server.close(async () => { await events.close(); await pool.end(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

if (require.main === module) {
  main().catch((err) => { logger.error('startup failed', err); process.exit(1); });
}

module.exports = app;

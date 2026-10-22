'use strict';

/**
 * Wires a service to the integration middleware.
 *
 *   EVENT_TRANSPORT=rabbitmq  (default when AMQP_URL is set)
 *       outbox -> RabbitMQ topic exchange -> per-service durable queues (+ retry tiers + DLQ)
 *
 *   EVENT_TRANSPORT=http      (fallback for running without a broker, e.g. a laptop without Docker)
 *       outbox -> direct REST POST /internal/events on the consuming services (the v1 behaviour);
 *       in-service queues (e.g. SMS dispatch) use the in-process broker with the same retry/DLQ rules.
 *
 * Either way the producer code is identical: write to the outbox inside the business transaction.
 */
const { createBus } = require('./messageBus');
const { createOutbox } = require('./outboxRelay');

// Which services receive which event when there is no broker (mirrors the RabbitMQ bindings).
const HTTP_ROUTES = {
  'checkin.anomaly_detected': ['ALERT_SERVICE_URL', 'CLINIC_SERVICE_URL'],
  'checkin.missed': ['ALERT_SERVICE_URL', 'CLINIC_SERVICE_URL'],
  'checkin.normal': ['CLINIC_SERVICE_URL'],
  'weather.risk_detected': ['CLINIC_SERVICE_URL'],
};
const DEFAULT_URLS = { ALERT_SERVICE_URL: 'http://localhost:4002', CLINIC_SERVICE_URL: 'http://localhost:4003' };

function transportMode() {
  const m = String(process.env.EVENT_TRANSPORT || '').toLowerCase();
  if (m === 'http' || m === 'rabbitmq') return m;
  return process.env.AMQP_URL ? 'rabbitmq' : 'http';
}

/**
 * @param {object} o
 * @param {import('pg').Pool} o.pool
 * @param {object} o.logger
 * @param {string} o.source  service name
 */
function createEventing({ pool, logger, source }) {
  const mode = transportMode();
  const bus = createBus({ url: mode === 'rabbitmq' ? process.env.AMQP_URL : 'memory://', serviceName: source, logger });

  async function deliver({ routingKey, event }) {
    if (mode === 'rabbitmq' || !HTTP_ROUTES[routingKey]) {
      await bus.publish(routingKey, event);
      return;
    }
    // HTTP fallback: deliver to every consumer; any failure retries the whole row (consumers are idempotent).
    // eslint-disable-next-line global-require
    const { request } = require('./resilientHttp');
    // eslint-disable-next-line global-require
    const { internalHeaders } = require('./internalAuth');
    for (const envName of HTTP_ROUTES[routingKey]) {
      const base = process.env[envName] || DEFAULT_URLS[envName];
      await request(`events-${envName}`, { method: 'POST', url: `${base}/internal/events`, data: event, headers: internalHeaders(event.eventId) }, { retries: 0, timeoutMs: 4000 });
    }
  }

  const outbox = createOutbox({ pool, logger, deliver, source });

  return {
    mode,
    bus,
    outbox,
    async start() {
      if (mode === 'rabbitmq') {
        // Do not block start-up on the broker: the outbox buffers until it is reachable.
        bus.connect().catch((e) => logger.error('broker connect failed', { error: e.message }));
      }
      outbox.start();
    },
    async status() {
      const s = bus.status();
      let queues = [];
      try { ({ queues } = await bus.inspect()); } catch { /* broker unavailable */ }
      return { mode, connected: s.connected, published: s.published, consumed: s.consumed, retried: s.retried, deadLettered: s.deadLettered, lastError: s.lastError || null, queues, outbox: await outbox.stats() };
    },
    /**
     * Operator endpoints (called by the gateway's /api/admin/messaging routes, never public):
     *   GET  /internal/messaging                  broker connection, queue + DLQ depths, outbox counts
     *   POST /internal/messaging/replay           {queue, limit?} move parked DLQ messages back for processing
     *   POST /internal/messaging/outbox/retry     re-publish outbox rows marked failed
     */
    adminRouter(express, requireInternalToken) {
      const r = express.Router();
      r.use('/internal/messaging', requireInternalToken);
      r.get('/internal/messaging', async (req, res, next) => {
        try { res.json({ service: source, ...(await this.status()) }); } catch (e) { next(e); }
      });
      r.post('/internal/messaging/replay', async (req, res, next) => {
        try {
          const queue = String((req.body && req.body.queue) || '');
          const known = bus.status().subscriptions.map((x) => x.queue);
          if (!known.includes(queue)) return res.status(422).json({ error: 'validation_failed', details: [`queue must be one of: ${known.join(', ')}`] });
          const limit = Math.min(Math.max(parseInt(req.body.limit, 10) || 50, 1), 500);
          const result = await bus.replayDlq(queue, limit);
          logger.warn('DLQ replay', { queue, ...result, by: req.get('x-user-id') || 'unknown' });
          return res.json({ queue, ...result });
        } catch (e) { return next(e); }
      });
      r.post('/internal/messaging/outbox/retry', async (req, res, next) => {
        try { res.json(await outbox.retryFailed()); } catch (e) { next(e); }
      });
      return r;
    },
    async close() {
      outbox.stop();
      await bus.close();
    },
  };
}

module.exports = { createEventing, transportMode, HTTP_ROUTES };

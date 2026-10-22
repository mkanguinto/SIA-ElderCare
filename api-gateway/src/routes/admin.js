'use strict';

/**
 * Admin View backend (Section 17 - "Admin View", Section 15 - Logging/Monitoring).
 * GET /api/admin/health : integration health of every downstream service + circuit-breaker states.
 * GET /api/admin/users  : user accounts and role assignments (no password hashes).
 * GET /api/admin/messaging         : RabbitMQ status, queue and dead-letter-queue depths, outbox counts per service.
 * POST /api/admin/messaging/replay : {service, queue, limit?} replay parked DLQ messages after fixing the cause.
 */
const express = require('express');
const axios = require('axios');
const config = require('../config');
const { authenticate } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');
const { ROLES } = require('../config/roles');
const { breakerSnapshots } = require('../lib/resilientHttp');
const { listUsers } = require('../auth/userStore');

const router = express.Router();

async function probe(name, baseUrl) {
  const started = Date.now();
  try {
    const { data, status } = await axios.get(`${baseUrl}/health`, { timeout: 2000, validateStatus: () => true });
    return { name, status: status === 200 ? 'up' : 'degraded', httpStatus: status, latencyMs: Date.now() - started, details: data };
  } catch (err) {
    return { name, status: 'down', error: err.code || err.message, latencyMs: Date.now() - started };
  }
}

router.get('/health', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
  const services = await Promise.all(Object.entries(config.services).map(([k, url]) => probe(k, url)));
  const overall = services.every((s) => s.status === 'up') ? 'up' : 'degraded';
  res.json({ gateway: 'up', overall, services, circuitBreakers: breakerSnapshots(), checkedAt: new Date().toISOString() });
});

// GET /api/admin/users : accounts and role assignments (Section 17 - Admin View). Read-only;
// accounts are changed in data/users.json (or the external IdP), never through an API that could leak hashes.
router.get('/users', authenticate, authorize(ROLES.ADMIN), (req, res) => {
  const users = listUsers();
  const byRole = users.reduce((acc, u) => ({ ...acc, [u.role]: (acc[u.role] || 0) + 1 }), {});
  res.json({ total: users.length, byRole, users });
});

/* ------------------------------ Messaging (RabbitMQ) ------------------------------ */
const MESSAGING_SERVICES = ['checkin', 'alert', 'clinic'];
const internal = (req) => ({ 'x-internal-token': config.internalServiceToken, 'x-request-id': req.id || req.get('x-request-id') || '', 'x-user-id': req.user.id, 'x-user-role': req.user.role });

router.get('/messaging', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
  const services = await Promise.all(MESSAGING_SERVICES.map(async (name) => {
    try {
      const { data } = await axios.get(`${config.services[name]}/internal/messaging`, { timeout: 3000, headers: internal(req) });
      return { name, ...data };
    } catch (err) {
      return { name, error: err.code || err.message };
    }
  }));
  const deadLetters = services.flatMap((s) => (s.queues || []).filter((q) => q.queue.endsWith('.dlq') && q.messages > 0).map((q) => ({ service: s.name, ...q })));
  res.json({ checkedAt: new Date().toISOString(), deadLetters, services });
});

router.post('/messaging/replay', authenticate, authorize(ROLES.ADMIN), async (req, res) => {
  const { service, queue, limit } = req.body || {};
  if (!MESSAGING_SERVICES.includes(service)) return res.status(422).json({ error: 'validation_failed', details: [`service must be one of: ${MESSAGING_SERVICES.join(', ')}`] });
  try {
    const r = await axios.post(`${config.services[service]}/internal/messaging/replay`, { queue, limit }, { timeout: 10000, headers: internal(req), validateStatus: () => true });
    return res.status(r.status).json(r.data);
  } catch (err) {
    return res.status(502).json({ error: 'bad_gateway', message: err.code || err.message });
  }
});

module.exports = router;

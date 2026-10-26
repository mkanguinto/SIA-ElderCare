'use strict';

/**
 * Service-to-service trust (Section 15 - "Authentication: Centralized at the Gateway").
 *
 * The API Gateway validates the end-user JWT once. It then forwards the request with:
 *   X-Internal-Token : shared secret proving the call came from the gateway / a peer service
 *   X-User-Id, X-User-Name (URI-encoded), X-User-Role, X-User-Patients : the already-validated identity
 *
 * Microservices must NOT be reachable from the public internet; this header check is
 * defense-in-depth in case a service port is accidentally exposed.
 */
const crypto = require('crypto');

function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function requireInternalToken(req, res, next) {
  const expected = process.env.INTERNAL_SERVICE_TOKEN;
  if (!expected) {
    return res.status(500).json({ error: 'server_misconfigured', message: 'INTERNAL_SERVICE_TOKEN not set' });
  }
  if (!safeEqual(req.get('x-internal-token'), expected)) {
    return res.status(401).json({ error: 'unauthorized', message: 'Missing or invalid internal service token' });
  }
  // Rehydrate the gateway-validated user context (absent on pure service-to-service events).
  const role = req.get('x-user-role');
  if (role) {
    let name = null;
    try { name = req.get('x-user-name') ? decodeURIComponent(req.get('x-user-name')) : null; } catch { /* malformed: leave empty */ }
    req.user = {
      id: req.get('x-user-id'),
      name,
      role,
      patients: (req.get('x-user-patients') || '').split(',').filter(Boolean),
      // Teams a nurse leads, set by the gateway only on routes that checked it (team-lead tools).
      leadTeams: (req.get('x-user-lead-teams') || '').split(',').filter(Boolean),
    };
  }
  return next();
}

/** Headers a service attaches when it calls a peer service directly. */
function internalHeaders(requestId) {
  return {
    'X-Internal-Token': process.env.INTERNAL_SERVICE_TOKEN,
    ...(requestId ? { 'X-Request-Id': requestId } : {}),
  };
}

module.exports = { requireInternalToken, internalHeaders };

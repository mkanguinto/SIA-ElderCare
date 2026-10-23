'use strict';

/**
 * Forwards an authenticated request to an internal microservice.
 *
 * - Clients never see internal service addresses (Section 15 - Routing).
 * - The validated identity is forwarded as trusted headers plus the shared
 *   X-Internal-Token, so services don't re-implement JWT validation.
 * - Calls go through a per-service circuit breaker; when a service is down the
 *   gateway fails fast with 503 instead of piling up hung requests.
 */
const config = require('../config');
const logger = require('./logger');
const { request, CircuitOpenError } = require('./resilientHttp');

// Request headers that must never be forwarded from the client.
const HOP_BY_HOP = ['host', 'connection', 'content-length', 'transfer-encoding', 'x-internal-token', 'x-user-id', 'x-user-name', 'x-user-role', 'x-user-patients'];

function buildHeaders(req) {
  const headers = {};
  for (const [k, v] of Object.entries(req.headers)) {
    if (!HOP_BY_HOP.includes(k.toLowerCase())) headers[k] = v;
  }
  headers['x-internal-token'] = config.internalServiceToken;
  headers['x-request-id'] = req.id;
  headers['x-forwarded-for'] = req.ip;
  if (req.user) {
    headers['x-user-id'] = req.user.id;
    headers['x-user-name'] = encodeURIComponent(req.user.name || '');
    headers['x-user-role'] = req.user.role;
    headers['x-user-patients'] = req.user.patients.join(',');
  }
  return headers;
}

/**
 * @param {keyof config.services} serviceKey  e.g. "checkin"
 * @param {(req)=>string} [pathBuilder]       upstream path; defaults to req.originalUrl
 */
function forwardTo(serviceKey, pathBuilder) {
  const baseUrl = config.services[serviceKey];
  if (!baseUrl) throw new Error(`Unknown service "${serviceKey}"`);

  return async function forward(req, res) {
    const path = pathBuilder ? pathBuilder(req) : req.originalUrl;
    const started = Date.now();
    try {
      const upstream = await request(
        serviceKey,
        {
          method: req.method,
          url: baseUrl + path,
          headers: buildHeaders(req),
          // Forward the exact bytes the client sent when available (webhook signatures depend on them).
          data: ['GET', 'HEAD', 'DELETE'].includes(req.method) ? undefined : (req.rawBody && req.rawBody.length ? req.rawBody : req.body),
          validateStatus: () => true, // pass 4xx/5xx bodies straight back to the client
        },
        // Only idempotent reads are retried; a POST is never re-sent automatically.
        { retries: req.method === 'GET' ? 2 : 0, timeoutMs: config.upstreamTimeoutMs },
      );

      logger.info('proxied', { requestId: req.id, service: serviceKey, method: req.method, path, status: upstream.status, ms: Date.now() - started });
      if (upstream.headers['content-type']) res.set('Content-Type', upstream.headers['content-type']);
      // 201 Created points at the new resource; public /api paths equal the services' paths.
      if (upstream.headers.location && String(upstream.headers.location).startsWith('/api/')) res.set('Location', upstream.headers.location);
      return res.status(upstream.status).send(upstream.data);
    } catch (err) {
      const ms = Date.now() - started;
      if (err instanceof CircuitOpenError) {
        logger.warn('upstream circuit open', { requestId: req.id, service: serviceKey, ms });
        return res.status(503).json({ error: 'service_unavailable', message: `${serviceKey} service is temporarily unavailable`, requestId: req.id });
      }
      const timedOut = err.code === 'ECONNABORTED' || err.code === 'ETIMEDOUT';
      logger.error('upstream error', { requestId: req.id, service: serviceKey, code: err.code, error: err.message, ms });
      return res.status(timedOut ? 504 : 502).json({
        error: timedOut ? 'gateway_timeout' : 'bad_gateway',
        message: `Could not reach ${serviceKey} service`,
        requestId: req.id,
      });
    }
  };
}

module.exports = { forwardTo };

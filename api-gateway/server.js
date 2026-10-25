'use strict';

/**
 * ElderCare Connect - API Gateway
 * Single public entry point for the Caregiver App, Family Dashboard, Clinic Portal and Admin View.
 *
 * Responsibilities (Sections 7, 12, 15):
 *   - OAuth 2.0 token endpoint + stateless JWT validation
 *   - RBAC for the four platform roles
 *   - Request routing to the internal microservices
 *   - Rate limiting, request validation, security headers, CORS
 *   - Request IDs + structured access logs
 */
const config = require('./src/config'); // loads .env first and fails fast on missing secrets
const net = require('net');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const axios = require('axios');
const rateLimit = require('express-rate-limit');

const logger = require('./src/lib/logger');
const { requestContext } = require('./src/middleware/requestContext');
const oauthRoutes = require('./src/routes/oauth');
const adminRoutes = require('./src/routes/admin');
const directoryRoutes = require('./src/routes/directory');
const accountRoutes = require('./src/routes/accounts');
const { store: accountStore } = require('./src/auth/accountStore');
const apiRoutes = require('./src/routes');
const { forwardTo } = require('./src/lib/proxy');
const { verifyTextbeeSignature } = require('./src/middleware/textbeeSignature');

const app = express();

app.disable('x-powered-by');
app.set('trust proxy', 1); // behind a cloud load balancer (Section 14)
// Behind Cloudflare and Render's proxies, the load balancer's own address arrives for every visitor, so the rate
// limits would be shared by everyone and the audit log would record the proxy. When CLIENT_IP_HEADER is set (only
// where the edge sets that header and clients cannot reach the gateway around it), req.ip is the visitor's address.
if (config.clientIpHeaders.length) {
  app.use((req, res, next) => {
    for (const h of config.clientIpHeaders) {
      const v = String(req.get(h) || '').split(',')[0].trim();
      if (net.isIP(v)) { Object.defineProperty(req, 'ip', { value: v, configurable: true, enumerable: true }); break; }
    }
    next();
  });
}

app.use(requestContext);
app.use(helmet());
app.use(
  cors({
    origin(origin, cb) {
      // Allow native mobile clients (no Origin header) and the configured web dashboards.
      if (!origin || config.corsOrigins.includes(origin)) return cb(null, true);
      return cb(null, false);
    },
    methods: ['GET', 'POST', 'PATCH', 'PUT', 'DELETE', 'OPTIONS'],
    allowedHeaders: ['Authorization', 'Content-Type', 'X-Request-Id'],
    exposedHeaders: ['X-Request-Id', 'RateLimit-Limit', 'RateLimit-Remaining', 'RateLimit-Reset'],
    maxAge: 600,
  }),
);

// Keep the raw request bytes so TextBee webhooks (X-Signature HMAC) can be verified downstream.
const keepRaw = (req, res, buf) => { req.rawBody = buf; };
app.use(express.json({ limit: '100kb', verify: keepRaw }));
app.use(express.urlencoded({ extended: false, limit: '20kb', verify: keepRaw }));

// Malformed JSON -> 400 instead of a stack trace.
app.use((err, req, res, next) => {
  if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'bad_request', message: 'Malformed JSON body' });
  if (err.type === 'entity.too.large') return res.status(413).json({ error: 'payload_too_large', message: 'Request body too large' });
  return next(err);
});

const apiLimiter = rateLimit({
  windowMs: config.rateLimit.windowMs,
  limit: config.rateLimit.max,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'too_many_requests', message: 'Rate limit exceeded, slow down' },
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  limit: config.rateLimit.authMax,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  skipSuccessfulRequests: true, // only failed logins count toward the brute-force limit
  message: { error: 'too_many_requests', error_description: 'Too many failed login attempts, try again later' },
});

// Public endpoints
app.get('/health', (req, res) => res.json({ status: 'up', service: 'api-gateway', uptimeSec: Math.round(process.uptime()) }));

// GET /health/wake : public, no data. On free hosting (Render free tier) idle services sleep and take
// ~1 minute to start, so the app calls this when it opens: every downstream /health is pinged in parallel
// (which starts the sleeping ones) and the reply says which are already up. Only up/down is returned.
app.get('/health/wake', async (req, res) => {
  const results = await Promise.all(Object.entries(config.services).map(async ([name, url]) => {
    try {
      const r = await axios.get(`${url}/health`, { timeout: Number(process.env.WAKE_PROBE_TIMEOUT_MS || 4000), validateStatus: () => true });
      return [name, r.status === 200];
    } catch {
      return [name, false];
    }
  }));
  const services = Object.fromEntries(results);
  res.set('Cache-Control', 'no-store').json({ ready: results.every(([, up]) => up), services });
});
app.use('/oauth', authLimiter, oauthRoutes);
// Account activation and password reset (codes / links from SMS): public, same brute-force limit as sign-in.
app.use('/auth', authLimiter, accountRoutes.pub);
app.use('/internal/test', accountRoutes.testing);
// TextBee (Android SMS gateway): delivery receipts + incoming SMS (check-ins, SOS, STOP/START) from
// caregivers without internet (Risk 3). No JWT (TextBee cannot send one); X-Signature is verified instead:
// here, before the Node-RED content-based router (Batch 3), or by the alert service in direct mode.
if (config.textbee.webhookTarget === 'node-red') {
  app.post('/webhooks/textbee', apiLimiter, verifyTextbeeSignature, forwardTo('nodeRed'));
} else {
  app.post('/webhooks/textbee', apiLimiter, forwardTo('alert'));
}

// Protected endpoints
app.use('/api', apiLimiter);
app.use('/api/admin', accountRoutes.admin);
app.use('/api/admin', adminRoutes);
app.use('/api/directory', directoryRoutes);
app.use('/api', apiRoutes);

app.use((req, res) => res.status(404).json({ error: 'not_found', message: `No route for ${req.method} ${req.path}` }));

// eslint-disable-next-line no-unused-vars
app.use((err, req, res, next) => {
  logger.error('unhandled error', { requestId: req.id, error: err.message, stack: err.stack });
  res.status(500).json({ error: 'internal_error', message: 'Unexpected gateway error', requestId: req.id });
});

if (require.main === module) {
  let server;
  if (config.accountSmsCapture) logger.warn('ACCOUNT_SMS_CAPTURE is on: activation codes can be read through /internal/test (local testing only)');
  accountStore.init().then(() => {
    server = app.listen(config.port, () => logger.info('api-gateway listening', { port: config.port, env: config.nodeEnv, accounts: accountStore.kind }));
  }).catch((err) => {
    logger.error('account store failed to start', { error: err.message });
    process.exit(1);
  });
  const shutdown = (signal) => {
    logger.info('shutting down', { signal });
    if (!server) process.exit(0);
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(1), 10000).unref();
  };
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}

module.exports = app;

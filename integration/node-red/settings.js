'use strict';

/**
 * Node-RED settings for the ElderCare EAI layer (Batch 3).
 *
 *   editor      http://localhost:1880/admin   user "admin", password NODE_RED_ADMIN_PASSWORD
 *   dashboard   http://localhost:1880/dlq     user DASHBOARD_USER, password DASHBOARD_PASSWORD
 *   webhook     POST /webhooks/textbee        from the API gateway only (X-Internal-Token)
 *
 * The flows ship in the image (flows.json, the source of truth in git). Changes made in the editor
 * last until the container is recreated: export them back to integration/node-red/flows.json.
 */
const path = require('path');
const crypto = require('crypto');

// Docker secrets (INTERNAL_SERVICE_TOKEN_FILE=/run/secrets/...), same convention as the services.
require('./src/lib/secrets').loadFileSecrets(process.env, [
  'INTERNAL_SERVICE_TOKEN', 'NODE_RED_ADMIN_PASSWORD', 'NODE_RED_CREDENTIAL_SECRET', 'DASHBOARD_PASSWORD',
]);

const safeEqual = (a, b) => {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
};
const adminPassword = process.env.NODE_RED_ADMIN_PASSWORD;

module.exports = {
  uiPort: Number(process.env.PORT || 1880),
  uiHost: '0.0.0.0',
  flowFile: path.join(__dirname, 'flows.json'),
  userDir: process.env.NODE_RED_USER_DIR || '/data',
  credentialSecret: process.env.NODE_RED_CREDENTIAL_SECRET || false, // flows hold no credentials: config comes from env
  flowFilePretty: true,

  // Editor at /admin so the flows' own endpoints (/dlq, /webhooks/textbee, /health) stay at the root.
  httpAdminRoot: '/admin',
  httpNodeRoot: '/',
  // No password configured -> the editor is disabled instead of open to anyone.
  disableEditor: !adminPassword,
  adminAuth: adminPassword ? {
    type: 'credentials',
    users: (username) => Promise.resolve(username === 'admin' ? { username: 'admin', permissions: '*' } : null),
    authenticate: (username, password) => Promise.resolve(
      username === 'admin' && safeEqual(password, adminPassword) ? { username: 'admin', permissions: '*' } : null,
    ),
  } : undefined,

  // Flow logic lives in a tested module; function nodes use global.get('eldercare').
  functionGlobalContext: { eldercare: require('./src/eldercare') },
  // Function nodes read service URLs and the internal token with env.get(); nothing else is exposed.
  functionExternalModules: false,
  exportGlobalContextKeys: false,

  logging: { console: { level: process.env.NODE_RED_LOG_LEVEL || 'info', metrics: false, audit: false } },
  editorTheme: { projects: { enabled: false }, tours: false },
};

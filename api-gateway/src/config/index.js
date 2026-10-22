'use strict';

require('dotenv').config();
// Docker secrets: JWT_SECRET_FILE=/run/secrets/jwt_secret etc. fill JWT_SECRET before anything reads it.
require('../lib/secrets').loadFileSecrets();

function required(name) {
  const v = process.env[name];
  if (!v) throw new Error(`Missing required environment variable: ${name}`);
  return v;
}

const algorithm = (process.env.JWT_ALGORITHM || 'HS256').toUpperCase();
if (!['HS256', 'RS256'].includes(algorithm)) {
  throw new Error('JWT_ALGORITHM must be HS256 or RS256');
}

// PEM keys are usually stored in env vars with literal "\n" sequences.
const pem = (v) => (v ? v.replace(/\\n/g, '\n') : undefined);

/**
 * Verify-only keys kept during a key rotation, as JSON {"<kid>": "<secret or public PEM>"}.
 * Tokens signed with them stay valid until they expire; new tokens use the active kid.
 */
function keyMap(name, { isPem = false } = {}) {
  const raw = process.env[name];
  if (!raw) return {};
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error(`${name} must be a JSON object {"<kid>": "<key>"}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error(`${name} must be a JSON object {"<kid>": "<key>"}`);
  const out = {};
  for (const [kid, key] of Object.entries(parsed)) {
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid) || typeof key !== 'string' || !key) throw new Error(`${name}: invalid entry for kid "${kid}"`);
    out[kid] = isPem ? pem(key) : key;
  }
  return out;
}

function kidOf(name, fallback) {
  const kid = process.env[name] || fallback;
  if (!/^[A-Za-z0-9._-]{1,64}$/.test(kid)) throw new Error(`${name} must be 1-64 characters: letters, digits, . _ -`);
  return kid;
}

const config = {
  port: Number(process.env.PORT || 8080),
  nodeEnv: process.env.NODE_ENV || 'development',
  corsOrigins: (process.env.CORS_ORIGINS || 'http://localhost:3000').split(',').map((s) => s.trim()),

  jwt: {
    algorithm,
    // HS256: one shared secret. RS256: private key signs (gateway / IdP), public key verifies.
    secret: algorithm === 'HS256' ? required('JWT_SECRET') : undefined,
    privateKey: algorithm === 'RS256' ? pem(process.env.JWT_PRIVATE_KEY) : undefined,
    publicKey: algorithm === 'RS256' ? pem(required('JWT_PUBLIC_KEY')) : undefined,
    refreshSecret: required('JWT_REFRESH_SECRET'),
    // kid-based key rotation: the active key signs, previous keys only verify (see docs/SECURITY.md).
    kid: kidOf('JWT_KID', 'k1'),
    previousKeys: keyMap('JWT_PREVIOUS_KEYS', { isPem: algorithm === 'RS256' }),
    refreshKid: kidOf('JWT_REFRESH_KID', 'r1'),
    previousRefreshKeys: keyMap('JWT_PREVIOUS_REFRESH_KEYS'),
    keyRotatedAt: process.env.JWT_KEY_ROTATED_AT || null, // ISO date the active kid was introduced
    keyRotationDays: Number(process.env.JWT_KEY_ROTATION_DAYS || 90),
    issuer: process.env.JWT_ISSUER || 'eldercare-connect-auth',
    audience: process.env.JWT_AUDIENCE || 'eldercare-connect-api',
    accessTtl: process.env.JWT_ACCESS_TTL || '15m',
    refreshTtl: process.env.JWT_REFRESH_TTL || '7d',
    // Two tabs refreshing with the same token at once is a race, not theft: allow it for a few seconds.
    refreshReuseGraceSec: Number(process.env.REFRESH_REUSE_GRACE_SECONDS ?? 10),
  },

  // Revoked jti's, refresh-token sessions and per-user revocations. "memory" = not persisted.
  tokenStoreFile: process.env.TOKEN_STORE_FILE || require('path').join(__dirname, '../../data/token-store.json'),

  internalServiceToken: required('INTERNAL_SERVICE_TOKEN'),

  services: {
    checkin: process.env.CHECKIN_SERVICE_URL || 'http://localhost:4001',
    alert: process.env.ALERT_SERVICE_URL || 'http://localhost:4002',
    clinic: process.env.CLINIC_SERVICE_URL || 'http://localhost:4003',
    legacyAdapter: process.env.LEGACY_ADAPTER_URL || 'http://localhost:4004',
  },

  upstreamTimeoutMs: Number(process.env.UPSTREAM_TIMEOUT_MS || 5000),

  rateLimit: {
    windowMs: Number(process.env.RATE_LIMIT_WINDOW_MS || 60000),
    max: Number(process.env.RATE_LIMIT_MAX || 300),
    authMax: Number(process.env.RATE_LIMIT_AUTH_MAX || 20),
  },

  usersFile: process.env.USERS_FILE || require('path').join(__dirname, '../../data/users.json'),
};

for (const [kid] of Object.entries(config.jwt.previousKeys)) {
  if (kid === config.jwt.kid) throw new Error(`JWT_PREVIOUS_KEYS must not contain the active JWT_KID "${kid}"`);
}
for (const [kid] of Object.entries(config.jwt.previousRefreshKeys)) {
  if (kid === config.jwt.refreshKid) throw new Error(`JWT_PREVIOUS_REFRESH_KEYS must not contain the active JWT_REFRESH_KID "${kid}"`);
}

module.exports = config;

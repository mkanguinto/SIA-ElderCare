'use strict';

/**
 * JWT authentication middleware - validates OAuth 2.0 Bearer access tokens (RFC 6750).
 *
 * On success it sets `req.user = { id, name, role, patients, scope }`.
 * On failure it returns 401 with a standards-compliant WWW-Authenticate header.
 *
 * Checks performed (tokenService.verifyAccessToken):
 *   - Authorization header present and uses the "Bearer" scheme
 *   - signature valid with the key named by the header's `kid`, using ONLY the configured algorithm
 *     (blocks alg=none / alg-confusion); unknown or retired kids are rejected
 *   - exp / nbf (with small clock tolerance), iss and aud match configuration
 *   - token type is "access" (a refresh token cannot be used to call APIs)
 *   - not revoked: jti deny-list, ended session (logout / refresh reuse), admin "revoke all sessions"
 *   - required claims (sub, role) are present and the role is a known platform role
 */
const { ALL_ROLES } = require('../config/roles');
const { verifyAccessToken } = require('../auth/tokenService');

// `reason` tells the app what to show: the lock screen (session_locked), "signed in elsewhere" (session_replaced),
// or the sign-in page (session_ended).
const REASON = { locked: 'session_locked', replaced: 'session_replaced', revoked: 'session_ended' };

function unauthorized(res, error, description, reason) {
  res.set('WWW-Authenticate', `Bearer realm="eldercare-connect", error="${error}", error_description="${description}"`);
  return res.status(401).json({ error, message: description, ...(reason ? { reason } : {}) });
}

function extractBearerToken(req) {
  const header = req.get('authorization');
  if (!header) return null;
  const [scheme, token] = header.split(' ');
  if (!scheme || scheme.toLowerCase() !== 'bearer' || !token) return undefined;
  return token.trim();
}

function authenticate(req, res, next) {
  const token = extractBearerToken(req);
  if (token === null) return unauthorized(res, 'invalid_request', 'Missing Authorization header');
  if (token === undefined) return unauthorized(res, 'invalid_request', 'Authorization header must be: Bearer <token>');

  let claims;
  try {
    claims = verifyAccessToken(token);
  } catch (err) {
    if (err.code === 'expired') return unauthorized(res, 'invalid_token', 'Access token has expired');
    if (REASON[err.code]) return unauthorized(res, 'invalid_token', err.message, REASON[err.code]);
    if (err.message === 'Token is not an access token') return unauthorized(res, 'invalid_token', err.message);
    return unauthorized(res, 'invalid_token', 'Access token is invalid');
  }

  if (!claims.sub || !ALL_ROLES.includes(claims.role)) {
    return unauthorized(res, 'invalid_token', 'Token is missing required claims');
  }

  req.user = {
    id: String(claims.sub),
    name: claims.name,
    role: claims.role,
    patients: Array.isArray(claims.patients) ? claims.patients.map(String) : [],
    scope: claims.scope ? String(claims.scope).split(' ') : [],
  };
  req.tokenClaims = claims; // jti / sid / exp, used by POST /oauth/logout
  return next();
}

module.exports = { authenticate, extractBearerToken };

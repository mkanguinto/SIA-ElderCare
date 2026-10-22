'use strict';

/**
 * OAuth 2.0 endpoints (RFC 6749 / RFC 7009).
 *
 *   POST /oauth/token
 *     grant_type=password       username, password            -> access + refresh token (new session)
 *     grant_type=refresh_token  refresh_token                 -> new access + NEW refresh token (rotation);
 *                                                                 a spent refresh token revokes the session
 *   POST /oauth/revoke          token, token_type_hint?       -> 200 always (RFC 7009 section 2.2)
 *   POST /oauth/logout          Authorization: Bearer <access> -> 204, ends the session (all its tokens)
 *
 * Accepts application/json or application/x-www-form-urlencoded.
 * Errors use the RFC 6749 section 5.2 shape: { error, error_description }.
 *
 * Note: the "password" grant is used here because the Caregiver App, Family Dashboard and
 * Clinic Portal are first-party clients. If third-party clients are ever added, move to the
 * Authorization Code + PKCE flow through an external identity provider.
 */
const express = require('express');
const { findByCredentials, findById } = require('../auth/userStore');
const { startSession, refreshSession, revokeToken, logout } = require('../auth/tokenService');
const { authenticate } = require('../middleware/authMiddleware');
const logger = require('../lib/logger');

const router = express.Router();

function oauthError(res, status, error, description) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ error, error_description: description });
}

router.post('/token', (req, res) => {
  const body = req.body || {};
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');

  switch (body.grant_type) {
    case 'password': {
      if (!body.username || !body.password) {
        return oauthError(res, 400, 'invalid_request', 'username and password are required');
      }
      const user = findByCredentials(body.username, body.password);
      if (!user) {
        logger.warn('login failed', { requestId: req.id, username: String(body.username).slice(0, 64) });
        return oauthError(res, 400, 'invalid_grant', 'Invalid username or password');
      }
      logger.info('login success', { requestId: req.id, userId: user.id, role: user.role });
      return res.json(startSession(user));
    }

    case 'refresh_token': {
      if (!body.refresh_token) return oauthError(res, 400, 'invalid_request', 'refresh_token is required');
      try {
        return res.json(refreshSession(String(body.refresh_token), findById));
      } catch (err) {
        if (err.code === 'reuse' || err.code === 'revoked') return oauthError(res, 400, 'invalid_grant', err.message);
        return oauthError(res, 400, 'invalid_grant', 'Refresh token is invalid or expired');
      }
    }

    default:
      return oauthError(res, 400, 'unsupported_grant_type', 'Supported grant types: password, refresh_token');
  }
});

// RFC 7009: the holder of a token may revoke it. The response is the same whether or not the token
// was valid, so the endpoint cannot be used to probe tokens.
router.post('/revoke', (req, res) => {
  const body = req.body || {};
  res.set('Cache-Control', 'no-store');
  if (typeof body.token !== 'string' || !body.token) return oauthError(res, 400, 'invalid_request', 'token is required');
  if (body.token_type_hint !== undefined && !['access_token', 'refresh_token'].includes(body.token_type_hint)) {
    return oauthError(res, 400, 'unsupported_token_type', 'token_type_hint must be access_token or refresh_token');
  }
  const r = revokeToken(body.token, body.token_type_hint);
  if (r.revoked) logger.info('token revoked', { requestId: req.id, userId: r.userId, type: r.type });
  return res.status(200).json({});
});

router.post('/logout', authenticate, (req, res) => {
  logout(req.tokenClaims);
  logger.info('logout', { requestId: req.id, userId: req.user.id });
  res.set('Cache-Control', 'no-store');
  return res.status(204).end();
});

module.exports = router;

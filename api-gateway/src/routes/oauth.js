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
 *   POST /oauth/lock            Authorization: Bearer <access> -> 204, the app's user went idle: lock the session
 *   POST /oauth/unlock          refresh_token, password        -> new tokens for the same session (lock screen)
 *
 * Sessions (Batch 3a): one per user - signing in ends the user's other sessions, except that a nurse may keep
 * one phone and one desktop session ("device": "phone" | "desktop", else taken from the User-Agent). A session
 * locks after inactivity (15 min clinic / admin, 30 min caregiver / family) until the password is re-entered.
 *
 * Accepts application/json or application/x-www-form-urlencoded.
 * Errors use the RFC 6749 section 5.2 shape: { error, error_description }.
 *
 * Note: the "password" grant is used here because the Caregiver App, Family Dashboard and
 * Clinic Portal are first-party clients. If third-party clients are ever added, move to the
 * Authorization Code + PKCE flow through an external identity provider.
 */
const express = require('express');
const { verifyLogin, findById, verifyPassword, audit, store } = require('../auth/userStore');
const { startSession, refreshSession, revokeToken, logout, lockSession, unlockSession } = require('../auth/tokenService');
const { deviceClass } = require('../auth/accountRules');
const { authenticate } = require('../middleware/authMiddleware');
const logger = require('../lib/logger');

const router = express.Router();

function oauthError(res, status, error, description, reason) {
  res.set('Cache-Control', 'no-store');
  return res.status(status).json({ error, error_description: description, ...(reason ? { reason } : {}) });
}
const REASON = { locked: 'session_locked', replaced: 'session_replaced', revoked: 'session_ended', reuse: 'session_ended' };
const quiet = (p) => p.catch((err) => logger.error('account audit write failed', { error: err.message }));

router.post('/token', async (req, res, next) => {
  const body = req.body || {};
  res.set('Cache-Control', 'no-store');
  res.set('Pragma', 'no-cache');

  switch (body.grant_type) {
    case 'password': {
      if (!body.username || !body.password) {
        return oauthError(res, 400, 'invalid_request', 'username and password are required');
      }
      try {
        const r = await verifyLogin(body.username, body.password);
        if (!r.user) {
          logger.warn('login failed', { requestId: req.id, username: String(body.username).slice(0, 64), reason: r.reason });
          quiet(audit(req, 'login_failed', r.account ? r.account.id : null, { reason: r.reason, username: String(body.username).slice(0, 64) }));
          if (r.reason === 'pending_activation') return oauthError(res, 400, 'invalid_grant', 'This account is not activated yet. Use the activation code sent to your phone.', 'account_pending');
          if (r.reason === 'disabled') return oauthError(res, 400, 'invalid_grant', 'This account has been disabled. Contact the clinic.', 'account_disabled');
          return oauthError(res, 400, 'invalid_grant', 'Invalid username or password');
        }
        const user = r.user;
        const device = deviceClass(body.device, req.get('user-agent'));
        const s = startSession(user, { deviceClass: device, userAgent: req.get('user-agent'), ip: req.ip });
        logger.info('login success', { requestId: req.id, userId: user.id, role: user.role, device, replaced: s.replaced.length });
        quiet(store.update(user.id, { lastLoginAt: new Date() }));
        quiet(audit({ ip: req.ip, user }, 'login', user.id, { device, endedSessions: s.replaced.length }));
        return res.json(s.response);
      } catch (err) {
        return next(err);
      }
    }

    case 'refresh_token': {
      if (!body.refresh_token) return oauthError(res, 400, 'invalid_request', 'refresh_token is required');
      try {
        return res.json(await refreshSession(String(body.refresh_token), findById));
      } catch (err) {
        if (REASON[err.code]) return oauthError(res, 400, 'invalid_grant', err.message, REASON[err.code]);
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
  quiet(audit(req, 'logout', req.user.id));
  res.set('Cache-Control', 'no-store');
  return res.status(204).end();
});

// The app saw no taps or keys for the idle limit: lock now (the server also locks sessions with no requests).
router.post('/lock', authenticate, (req, res) => {
  if (lockSession(req.tokenClaims)) quiet(audit(req, 'session_locked', req.user.id, { by: 'app' }));
  res.set('Cache-Control', 'no-store');
  return res.status(204).end();
});

router.post('/unlock', async (req, res, next) => {
  const body = req.body || {};
  res.set('Cache-Control', 'no-store');
  if (typeof body.refresh_token !== 'string' || typeof body.password !== 'string') {
    return oauthError(res, 400, 'invalid_request', 'refresh_token and password are required');
  }
  try {
    let userId = null;
    const tokens = await unlockSession(body.refresh_token, body.password, async (id, pw) => {
      userId = id;
      const user = await findById(id);
      return user && verifyPassword(pw, user.passwordHash) ? user : null;
    });
    quiet(audit({ ip: req.ip, user: { id: userId, role: tokens.role } }, 'session_unlocked', userId));
    return res.json(tokens);
  } catch (err) {
    if (err.code === 'bad_password') return oauthError(res, 400, 'invalid_grant', 'Wrong password', 'bad_password');
    if (REASON[err.code]) return oauthError(res, 400, 'invalid_grant', err.message, REASON[err.code]);
    if (err.code === 'invalid' || err.code === 'expired') return oauthError(res, 400, 'invalid_grant', 'Session has ended, please sign in again', 'session_ended');
    return next(err);
  }
});

module.exports = router;

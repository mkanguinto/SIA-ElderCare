'use strict';

/**
 * Issues, verifies, rotates and revokes OAuth 2.0 access / refresh tokens (signed JWTs).
 *
 * Batch 2 security model:
 *   - kid-based keys: every token header carries `kid`; verification picks the key by kid from the
 *     keyring (active key + verify-only previous keys), so keys rotate without logging everyone out.
 *   - sessions: each sign-in starts a refresh-token family `sid`; access tokens carry the same `sid`.
 *   - refresh rotation: every refresh returns a NEW refresh token; the old one is spent.
 *   - reuse detection: presenting a spent refresh token revokes the whole session (RFC 9700 4.14.2),
 *     which also kills its access tokens immediately.
 *   - revocation: jti deny-list for single access tokens, session revocation for logout / revoke,
 *     per-user "revoked before" for an admin kill switch.
 */
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const config = require('../config');
const logger = require('../lib/logger');
const { TokenStore } = require('./tokenStore');
const { sessionsToReplace, idleLimitMinutes } = require('./accountRules');

const store = new TokenStore(config.tokenStoreFile);

class TokenError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code; // expired | invalid | revoked | reuse
  }
}

/* ------------------------------------------------------------------ */
/* Keyrings                                                            */
/* ------------------------------------------------------------------ */
const accessKeys = {
  algorithm: config.jwt.algorithm,
  kid: config.jwt.kid,
  signKey: config.jwt.algorithm === 'HS256' ? config.jwt.secret : config.jwt.privateKey,
  verify: {
    ...config.jwt.previousKeys,
    [config.jwt.kid]: config.jwt.algorithm === 'HS256' ? config.jwt.secret : config.jwt.publicKey,
  },
};
const refreshKeys = {
  algorithm: 'HS256',
  kid: config.jwt.refreshKid,
  signKey: config.jwt.refreshSecret,
  verify: { ...config.jwt.previousRefreshKeys, [config.jwt.refreshKid]: config.jwt.refreshSecret },
};
const REFRESH_AUDIENCE = `${config.jwt.audience}:refresh`;

function signWith(keys, claims, options) {
  if (!keys.signKey) throw new Error('RS256 mode without JWT_PRIVATE_KEY: tokens must be issued by your external IdP');
  return jwt.sign(claims, keys.signKey, { ...options, algorithm: keys.algorithm, keyid: keys.kid, issuer: config.jwt.issuer });
}

/** Verifies signature + standard claims with the key named by the token's kid. */
function verifyWith(keys, token, audience) {
  const decoded = jwt.decode(token, { complete: true });
  if (!decoded || !decoded.header) throw new TokenError('invalid', 'Token is malformed');
  // Tokens from before kid support have no kid: they can only match the active key.
  const kid = decoded.header.kid || keys.kid;
  const key = keys.verify[kid];
  if (!key) throw new TokenError('invalid', 'Token was signed with an unknown or retired key');
  try {
    return jwt.verify(token, key, { algorithms: [keys.algorithm], issuer: config.jwt.issuer, audience, clockTolerance: 30 });
  } catch (err) {
    if (err.name === 'TokenExpiredError') throw new TokenError('expired', 'Token has expired');
    throw new TokenError('invalid', 'Token is invalid');
  }
}

/* ------------------------------------------------------------------ */
/* Issuing                                                             */
/* ------------------------------------------------------------------ */
function issueAccessToken(user, sid) {
  const claims = {
    typ: 'access',
    sid,
    name: user.name,
    role: user.role,
    patients: user.patients || [],
    scope: (user.scopes || []).join(' '),
  };
  return signWith(accessKeys, claims, {
    subject: user.id,
    audience: config.jwt.audience,
    expiresIn: config.jwt.accessTtl,
    jwtid: crypto.randomUUID(),
  });
}

function issueRefreshToken(user, sid, jti) {
  return signWith(refreshKeys, { typ: 'refresh', sid }, {
    subject: user.id,
    audience: REFRESH_AUDIENCE,
    expiresIn: config.jwt.refreshTtl,
    jwtid: jti,
  });
}

/** RFC 6749 section 5.1 token response for a session. */
function tokenResponse(user, sid, refreshJti) {
  const accessToken = issueAccessToken(user, sid);
  const refreshToken = issueRefreshToken(user, sid, refreshJti);
  const { exp, iat } = jwt.decode(accessToken);
  return {
    response: {
      access_token: accessToken,
      token_type: 'Bearer',
      expires_in: exp - iat,
      refresh_token: refreshToken,
      scope: (user.scopes || []).join(' '),
      role: user.role,
    },
    refreshExp: jwt.decode(refreshToken).exp,
  };
}

/**
 * Password grant: a new session (refresh-token family). One session per user: the user's other sessions end
 * (nurses keep one phone and one desktop session, so only the one on the same kind of device ends).
 * @returns {{response:object, replaced:string[], sid:string}}
 */
function startSession(user, { deviceClass = 'desktop', userAgent = null, ip = null } = {}) {
  const replaced = sessionsToReplace(user.role, deviceClass, store.userSessions(user.id));
  for (const old of replaced) store.revokeSession(old, 'replaced');
  const sid = crypto.randomUUID();
  const jti = crypto.randomUUID();
  const { response, refreshExp } = tokenResponse(user, sid, jti);
  store.createSession({ sid, userId: user.id, jti, exp: refreshExp, role: user.role, deviceClass, userAgent, ip });
  return { response: { ...response, session: { id: sid, deviceClass, idleLockMinutes: idleLimitMinutes(user.role) } }, replaced, sid };
}

const SESSION_ENDED = {
  replaced: ['replaced', 'You signed in on another device, so this session ended. Sign in again to continue here.'],
  admin_revoked: ['revoked', 'An administrator ended this session. Sign in again.'],
  account_disabled: ['revoked', 'This account has been disabled.'],
};
/** Revoked -> TokenError with a reason the app can explain; locked or idle too long -> 'locked'. */
function checkSession(session, role) {
  if (!session || session.revokedAt) {
    const [code, msg] = SESSION_ENDED[session && session.reason] || ['revoked', 'Session has ended, please sign in again'];
    throw new TokenError(code, msg);
  }
  const idleSec = Date.now() / 1000 - (session.lastSeenAt || session.createdAt);
  if (session.lockedAt || idleSec > idleLimitMinutes(session.role || role) * 60) {
    throw new TokenError('locked', 'Locked after inactivity. Enter your password to continue.');
  }
}

/* ------------------------------------------------------------------ */
/* Verification                                                        */
/* ------------------------------------------------------------------ */
function verifyRefreshToken(token) {
  const claims = verifyWith(refreshKeys, token, REFRESH_AUDIENCE);
  if (claims.typ !== 'refresh') throw new TokenError('invalid', 'Not a refresh token');
  return claims;
}

/** Signature, expiry, type and every revocation check. Throws TokenError. */
function verifyAccessToken(token) {
  const claims = verifyWith(accessKeys, token, config.jwt.audience);
  if (claims.typ !== 'access') throw new TokenError('invalid', 'Token is not an access token');
  if (store.isDenied(claims.jti)) throw new TokenError('revoked', 'Access token has been revoked');
  if (claims.iat < store.userRevokedBefore(claims.sub)) throw new TokenError('revoked', 'Access token has been revoked');
  if (claims.sid) {
    checkSession(store.getSession(claims.sid), claims.role);
    store.touch(claims.sid);
  }
  return claims;
}

/* ------------------------------------------------------------------ */
/* Refresh rotation with reuse detection                               */
/* ------------------------------------------------------------------ */
/**
 * @param {string} refreshToken
 * @param {(userId:string) => object|null} findUser
 * @returns {object} token response
 */
async function refreshSession(refreshToken, findUser) {
  const claims = verifyRefreshToken(refreshToken);
  const session = store.getSession(claims.sid);
  if (session && session.userId !== claims.sub) throw new TokenError('revoked', 'Session has ended, please sign in again');
  checkSession(session, null);
  if (claims.iat < store.userRevokedBefore(claims.sub)) throw new TokenError('revoked', 'Session has ended, please sign in again');

  const user = await findUser(claims.sub);
  if (!user) {
    store.revokeSession(claims.sid, 'user_inactive');
    throw new TokenError('revoked', 'User no longer active');
  }

  if (claims.jti === session.currentJti) {
    const jti = crypto.randomUUID();
    const { response, refreshExp } = tokenResponse(user, claims.sid, jti);
    store.rotateSession(claims.sid, jti, refreshExp);
    return response;
  }

  // Two requests (e.g. two tabs) refreshed with the same token a moment apart: hand the loser the
  // current token instead of treating it as theft.
  const graceSec = config.jwt.refreshReuseGraceSec;
  if (claims.jti === session.previousJti && graceSec > 0 && Date.now() / 1000 - session.rotatedAt <= graceSec) {
    return tokenResponse(user, claims.sid, session.currentJti).response;
  }

  // A spent refresh token came back: either the client is buggy or the token was stolen. Either way,
  // end the session for everyone holding it (RFC 9700 section 4.14.2).
  store.revokeSession(claims.sid, 'refresh_token_reuse');
  logger.warn('refresh token reuse detected, session revoked', { userId: claims.sub, sid: claims.sid });
  throw new TokenError('reuse', 'Refresh token was already used; the session has been revoked for safety');
}

/* ------------------------------------------------------------------ */
/* Revocation                                                          */
/* ------------------------------------------------------------------ */
/**
 * RFC 7009 token revocation. Refresh token -> ends its session (and its access tokens).
 * Access token -> deny-lists that one jti until it expires. Unknown / invalid tokens are ignored.
 * @returns {{revoked:boolean, type?:string}}
 */
function revokeToken(token, hint) {
  const order = hint === 'access_token' ? ['access', 'refresh'] : ['refresh', 'access'];
  for (const type of order) {
    try {
      if (type === 'refresh') {
        const c = verifyWith(refreshKeys, token, REFRESH_AUDIENCE);
        if (c.typ !== 'refresh') continue;
        store.revokeSession(c.sid, 'revoked');
        return { revoked: true, type, userId: c.sub };
      }
      const c = verifyWith(accessKeys, token, config.jwt.audience);
      if (c.typ !== 'access') continue;
      store.denyJti(c.jti, c.exp);
      return { revoked: true, type, userId: c.sub };
    } catch {
      // not this type (or expired / invalid): try the next one
    }
  }
  return { revoked: false };
}

/** Logout: deny-list the presented access token and end its session. */
function logout(accessClaims) {
  store.denyJti(accessClaims.jti, accessClaims.exp);
  if (accessClaims.sid) store.revokeSession(accessClaims.sid, 'logout');
}

function revokeUserSessions(userId, reason = 'admin_revoked') {
  return store.revokeUser(userId, reason);
}

/* ------------------------------------------------------------------ */
/* Inactivity lock                                                     */
/* ------------------------------------------------------------------ */
/** The app reports that its user went idle: lock the session now (all API calls fail until unlocked). */
function lockSession(accessClaims) {
  return accessClaims.sid ? store.lockSession(accessClaims.sid, 'inactivity') : false;
}

/**
 * Lock screen: the refresh token identifies the session (its access token may have expired meanwhile) and the
 * user proves who they are with their password. Three wrong passwords end the session.
 * @param {(userId:string, password:string) => Promise<object|null>} checkPassword  active user when the password is right
 */
async function unlockSession(refreshToken, password, checkPassword) {
  const claims = verifyRefreshToken(refreshToken);
  const session = store.getSession(claims.sid);
  if (!session || session.revokedAt || session.userId !== claims.sub) {
    const [code, msg] = SESSION_ENDED[session && session.reason] || ['revoked', 'Session has ended, please sign in again'];
    throw new TokenError(code, msg);
  }
  if (claims.jti !== session.currentJti && claims.jti !== session.previousJti) throw new TokenError('revoked', 'Session has ended, please sign in again');
  const user = await checkPassword(claims.sub, password);
  if (!user) {
    if (store.unlockFailed(claims.sid) >= 3) {
      store.revokeSession(claims.sid, 'unlock_failed');
      throw new TokenError('revoked', 'Too many wrong passwords. You have been signed out.');
    }
    throw new TokenError('bad_password', 'Wrong password');
  }
  store.unlockSession(claims.sid);
  const jti = crypto.randomUUID();
  const { response, refreshExp } = tokenResponse(user, claims.sid, jti);
  store.rotateSession(claims.sid, jti, refreshExp);
  return { ...response, session: { id: claims.sid, deviceClass: session.deviceClass, idleLockMinutes: idleLimitMinutes(user.role) } };
}

/** Sessions of a user for the admin view (no token material). */
function listUserSessions(userId) {
  const t = Date.now() / 1000;
  return store.userSessions(userId).map((s) => ({
    id: s.sid, deviceClass: s.deviceClass || 'desktop', userAgent: s.userAgent, ip: s.ip,
    startedAt: new Date(s.createdAt * 1000).toISOString(), lastSeenAt: new Date((s.lastSeenAt || s.createdAt) * 1000).toISOString(),
    locked: Boolean(s.lockedAt) || t - (s.lastSeenAt || s.createdAt) > idleLimitMinutes(s.role) * 60,
  }));
}

function revokeOneSession(userId, sid, reason = 'admin_revoked') {
  const s = store.getSession(sid);
  if (!s || s.userId !== userId) return false;
  return store.revokeSession(sid, reason);
}

/** For GET /api/admin/security: key ids and rotation schedule (never key material). */
function keyStatus() {
  const rotatedAt = config.jwt.keyRotatedAt ? new Date(config.jwt.keyRotatedAt) : null;
  const valid = rotatedAt && !Number.isNaN(rotatedAt.getTime());
  const due = valid ? new Date(rotatedAt.getTime() + config.jwt.keyRotationDays * 86400000) : null;
  return {
    algorithm: config.jwt.algorithm,
    access: { activeKid: accessKeys.kid, verifyOnlyKids: Object.keys(config.jwt.previousKeys) },
    refresh: { activeKid: refreshKeys.kid, verifyOnlyKids: Object.keys(config.jwt.previousRefreshKeys) },
    rotation: {
      intervalDays: config.jwt.keyRotationDays,
      activeSince: valid ? rotatedAt.toISOString() : null,
      nextRotationDue: due ? due.toISOString() : null,
      overdue: due ? due.getTime() < Date.now() : null,
    },
    store: store.stats(),
  };
}

module.exports = {
  TokenError,
  startSession,
  refreshSession,
  verifyAccessToken,
  verifyRefreshToken,
  revokeToken,
  logout,
  revokeUserSessions,
  lockSession,
  unlockSession,
  listUserSessions,
  revokeOneSession,
  keyStatus,
  issueAccessToken,
};

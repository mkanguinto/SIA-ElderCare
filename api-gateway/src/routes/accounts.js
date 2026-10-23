'use strict';

/**
 * Account management (Batch 3a).
 *
 * Admin (system_admin), mounted at /api/admin/accounts and /api/admin/audit:
 *   GET    /api/admin/accounts                          accounts with status, sessions and the open activation code (no secrets)
 *   POST   /api/admin/accounts                          {username, name, role, phone, patients?} -> pending account + activation code by SMS
 *   POST   /api/admin/accounts/:id/activation-code      send a new activation code (the old one stops working)
 *   POST   /api/admin/accounts/:id/password-reset       send a password-reset link by SMS (the admin never sees it)
 *   POST   /api/admin/accounts/:id/disable              {reason}  signs the user out everywhere
 *   POST   /api/admin/accounts/:id/enable
 *   GET    /api/admin/accounts/:id/sessions             active sessions (device, last activity, locked)
 *   DELETE /api/admin/accounts/:id/sessions/:sid        end one session
 *   GET    /api/admin/audit?targetId=&action=&limit=    account audit log
 *
 * Public (rate limited like /oauth), mounted at /auth:
 *   POST /auth/activate                {username, code, password}   activation code from SMS -> own password
 *   POST /auth/password-reset/check    {token}                      is this reset link still valid, and for whom
 *   POST /auth/password-reset          {token, password}            set a new password, sign out everywhere
 *
 * Testing only (ACCOUNT_SMS_CAPTURE=true, never production), mounted at /internal/test:
 *   GET /internal/test/account-sms?to=&purpose=     X-Internal-Token   last captured account SMS
 */
const express = require('express');
const config = require('../config');
const logger = require('../lib/logger');
const { authenticate } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');
const { ROLES } = require('../config/roles');
const { store, hashPassword, publicAccount, audit } = require('../auth/userStore');
const { sendAccountSms, lastCaptured } = require('../auth/accountSms');
const { revokeUserSessions, listUserSessions, revokeOneSession } = require('../auth/tokenService');
const R = require('../auth/accountRules');

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const quiet = (p) => p.catch((err) => logger.error('account audit write failed', { error: err.message }));

/**
 * Creates a one-time secret for an account, replaces any open one for the same purpose, texts it to the
 * account's phone, and returns what the admin may see (masked number, delivery, expiry) - never the secret.
 */
async function issueSecret(req, account, purpose) {
  const secret = purpose === 'activation' ? R.newActivationCode() : R.newResetToken();
  const expiresAt = new Date(Date.now() + R.TOKEN_TTL_MIN[purpose] * 60000);
  await store.revokeOpenTokens(account.id, purpose);
  const token = await store.addToken({
    accountId: account.id, purpose, secretHash: R.hashSecret(secret, config.accountTokenPepper, purpose), expiresAt,
    sentTo: R.maskPhone(account.phone), createdBy: req.user.id,
  });
  const body = purpose === 'activation'
    ? `ElderCare: your activation code is ${secret} (valid 24 hours). Open ${config.publicWebUrl}/activate and sign in as ${account.username}. Do not share this code.`
    : `ElderCare: set a new password here (valid 1 hour): ${config.publicWebUrl}/reset-password#${secret} . If you did not ask for this, ignore this SMS.`;
  const delivery = await sendAccountSms({ to: account.phone, body, purpose, requestId: req.id });
  await store.updateToken(token.id, { delivery });
  await audit(req, purpose === 'activation' ? 'activation_code_sent' : 'password_reset_sent', account.id, { sentTo: token.sentTo, delivery, expiresAt });
  return { sentTo: token.sentTo, delivery, expiresAt: expiresAt.toISOString() };
}

/* =============================== admin =============================== */
const admin = express.Router();
admin.use(authenticate, authorize(ROLES.ADMIN));

async function loadTarget(req, res) {
  if (!ID_RE.test(req.params.id)) { res.status(404).json({ error: 'not_found', message: 'Account not found' }); return null; }
  const a = await store.getById(req.params.id);
  if (!a) res.status(404).json({ error: 'not_found', message: 'Account not found' });
  return a;
}

admin.get('/accounts', async (req, res, next) => {
  try {
    const accounts = await store.list();
    const rows = await Promise.all(accounts.map(async (a) => {
      const t = a.status === 'pending_activation' ? await store.latestToken(a.id, 'activation') : null;
      const state = t ? R.tokenState(t) : null;
      return {
        ...publicAccount(a),
        sessions: listUserSessions(a.id).length,
        activation: t ? { state, sentTo: t.sentTo, delivery: t.delivery, expiresAt: t.expiresAt, sentAt: t.createdAt } : null,
      };
    }));
    const byRole = rows.reduce((acc, u) => ({ ...acc, [u.role]: (acc[u.role] || 0) + 1 }), {});
    res.json({ total: rows.length, byRole, store: store.kind, accounts: rows });
  } catch (err) {
    next(err);
  }
});

admin.post('/accounts', async (req, res, next) => {
  try {
    const v = R.validateNewAccount(req.body);
    if (!v.ok) return res.status(422).json({ error: 'validation_failed', details: v.errors });
    if (await store.getByUsername(v.value.username)) return res.status(409).json({ error: 'conflict', message: `The username ${v.value.username} is taken` });
    let account = null;
    for (let i = 0; i < 3 && !account; i += 1) {
      const id = R.nextAccountId(v.value.role, (await store.list()).map((a) => a.id));
      try {
        account = await store.insert({ ...v.value, id, passwordHash: null, status: 'pending_activation', createdBy: req.user.id });
      } catch (err) {
        if (err.code !== 'conflict') throw err; // two admins at once took the same id: try the next one
      }
    }
    if (!account) return res.status(409).json({ error: 'conflict', message: 'Could not allocate an account id, try again' });
    await audit(req, 'account_created', account.id, { role: account.role, username: account.username, patients: account.patients });
    const sms = await issueSecret(req, account, 'activation');
    logger.info('account created', { requestId: req.id, accountId: account.id, role: account.role, by: req.user.id, delivery: sms.delivery });
    return res.status(201).json({ account: publicAccount(account), activation: sms });
  } catch (err) {
    return next(err);
  }
});

admin.post('/accounts/:id/activation-code', async (req, res, next) => {
  try {
    const a = await loadTarget(req, res);
    if (!a) return undefined;
    if (a.status !== 'pending_activation') return res.status(409).json({ error: 'conflict', message: 'This account is already activated. Send a password-reset link instead.' });
    if (!a.phone) return res.status(422).json({ error: 'validation_failed', details: ['The account has no phone number'] });
    return res.json({ activation: await issueSecret(req, a, 'activation') });
  } catch (err) {
    return next(err);
  }
});

admin.post('/accounts/:id/password-reset', async (req, res, next) => {
  try {
    const a = await loadTarget(req, res);
    if (!a) return undefined;
    if (a.status !== 'active') return res.status(409).json({ error: 'conflict', message: a.status === 'disabled' ? 'Enable the account first' : 'The account is not activated yet: send an activation code instead' });
    if (!a.phone) return res.status(422).json({ error: 'validation_failed', details: ['The account has no phone number for the reset link'] });
    return res.json({ passwordReset: await issueSecret(req, a, 'password_reset') });
  } catch (err) {
    return next(err);
  }
});

admin.post('/accounts/:id/disable', async (req, res, next) => {
  try {
    const a = await loadTarget(req, res);
    if (!a) return undefined;
    const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '';
    if (reason.length < 3 || reason.length > 300) return res.status(422).json({ error: 'validation_failed', details: ['reason is required (3-300 characters)'] });
    if (a.id === req.user.id) return res.status(409).json({ error: 'conflict', message: 'You cannot disable your own account' });
    if (a.status === 'disabled') return res.status(409).json({ error: 'conflict', message: 'Already disabled' });
    if (a.role === 'system_admin' && (await store.list()).filter((x) => x.role === 'system_admin' && x.status === 'active' && x.id !== a.id).length === 0) {
      return res.status(409).json({ error: 'conflict', message: 'This is the last active admin account' });
    }
    const updated = await store.update(a.id, { status: 'disabled', disabledAt: new Date(), disabledBy: req.user.id, disabledReason: reason });
    const r = revokeUserSessions(a.id, 'account_disabled');
    await store.revokeOpenTokens(a.id, 'activation');
    await store.revokeOpenTokens(a.id, 'password_reset');
    await audit(req, 'account_disabled', a.id, { reason, sessionsEnded: r.sessions });
    return res.json({ account: publicAccount(updated), sessionsEnded: r.sessions });
  } catch (err) {
    return next(err);
  }
});

admin.post('/accounts/:id/enable', async (req, res, next) => {
  try {
    const a = await loadTarget(req, res);
    if (!a) return undefined;
    if (a.status !== 'disabled') return res.status(409).json({ error: 'conflict', message: 'The account is not disabled' });
    const updated = await store.update(a.id, { status: a.passwordHash ? 'active' : 'pending_activation', disabledAt: null, disabledBy: null, disabledReason: null });
    await audit(req, 'account_enabled', a.id);
    return res.json({ account: publicAccount(updated) });
  } catch (err) {
    return next(err);
  }
});

admin.get('/accounts/:id/sessions', async (req, res, next) => {
  try {
    const a = await loadTarget(req, res);
    if (!a) return undefined;
    return res.json({ sessions: listUserSessions(a.id) });
  } catch (err) {
    return next(err);
  }
});

admin.delete('/accounts/:id/sessions/:sid', async (req, res, next) => {
  try {
    const a = await loadTarget(req, res);
    if (!a) return undefined;
    if (!revokeOneSession(a.id, req.params.sid)) return res.status(404).json({ error: 'not_found', message: 'Session not found or already ended' });
    await audit(req, 'session_revoked', a.id, { sessionId: req.params.sid });
    return res.json({ ended: req.params.sid });
  } catch (err) {
    return next(err);
  }
});

admin.get('/audit', async (req, res, next) => {
  try {
    const targetId = req.query.targetId && ID_RE.test(req.query.targetId) ? String(req.query.targetId) : undefined;
    const action = req.query.action && /^[a-z_]{2,40}$/.test(req.query.action) ? String(req.query.action) : undefined;
    const entries = await store.auditList({ limit: Math.min(Number(req.query.limit) || 100, 500), targetId, action });
    res.json({ entries });
  } catch (err) {
    next(err);
  }
});

/* =============================== public =============================== */
const pub = express.Router();
const fail = (res, status, error, message, details) => res.status(status).json({ error, message, ...(details ? { details } : {}) });

pub.post('/activate', async (req, res, next) => {
  try {
    const { username, code, password } = req.body || {};
    if (typeof username !== 'string' || typeof code !== 'string' || typeof password !== 'string') {
      return fail(res, 400, 'invalid_request', 'username, code and password are required');
    }
    const a = await store.getByUsername(username.trim());
    // Same answer for an unknown username and a wrong code, so the form cannot be used to find accounts.
    if (!a || a.status !== 'pending_activation') {
      quiet(audit(req, 'activation_failed', a ? a.id : null, { reason: a ? `account_${a.status}` : 'unknown_username' }));
      return fail(res, 400, 'invalid_code', a && a.status === 'active' ? R.TOKEN_MESSAGE.used : R.TOKEN_MESSAGE.missing);
    }
    let t = await store.findToken(R.hashSecret(code, config.accountTokenPepper, 'activation'), 'activation');
    if (t && t.accountId !== a.id) t = null;
    if (!t) {
      const open = await store.latestToken(a.id, 'activation');
      if (open && R.tokenState(open) === 'ok') await store.updateToken(open.id, { attempts: open.attempts + 1 });
      quiet(audit(req, 'activation_failed', a.id, { reason: 'wrong_code' }));
      return fail(res, 400, 'invalid_code', open && open.attempts + 1 >= R.MAX_ATTEMPTS ? R.TOKEN_MESSAGE.locked : R.TOKEN_MESSAGE.missing);
    }
    const state = R.tokenState(t);
    if (state !== 'ok') {
      quiet(audit(req, 'activation_failed', a.id, { reason: state }));
      return fail(res, 400, state === 'expired' ? 'code_expired' : 'invalid_code', R.TOKEN_MESSAGE[state]);
    }
    const problems = R.passwordProblems(password, a);
    if (problems.length) return fail(res, 422, 'weak_password', problems[0], problems);
    await store.updateToken(t.id, { usedAt: new Date() });
    const now = new Date();
    await store.update(a.id, { passwordHash: hashPassword(password), status: 'active', activatedAt: now, passwordChangedAt: now });
    await audit({ ip: req.ip, user: { id: a.id, role: a.role } }, 'account_activated', a.id);
    logger.info('account activated', { requestId: req.id, accountId: a.id });
    return res.json({ activated: true, username: a.username, role: a.role });
  } catch (err) {
    return next(err);
  }
});

async function resetToken(token) {
  if (typeof token !== 'string' || token.length < 20 || token.length > 100) return { state: 'missing' };
  const t = await store.findToken(R.hashSecret(token, config.accountTokenPepper, 'password_reset'), 'password_reset');
  const state = R.tokenState(t);
  const account = t ? await store.getById(t.accountId) : null;
  if (state === 'ok' && (!account || account.status !== 'active')) return { state: 'missing' };
  return { state, t, account };
}

pub.post('/password-reset/check', async (req, res, next) => {
  try {
    const r = await resetToken((req.body || {}).token);
    if (r.state !== 'ok') return fail(res, 400, r.state === 'expired' ? 'link_expired' : 'invalid_link', r.state === 'expired' ? 'This link has expired. Ask the clinic for a new one.' : 'This link is not valid any more. Ask the clinic for a new one.');
    return res.json({ valid: true, username: r.account.username, expiresAt: r.t.expiresAt });
  } catch (err) {
    return next(err);
  }
});

pub.post('/password-reset', async (req, res, next) => {
  try {
    const { token, password } = req.body || {};
    const r = await resetToken(token);
    if (r.state !== 'ok') {
      quiet(audit(req, 'password_reset_failed', r.account ? r.account.id : null, { reason: r.state }));
      return fail(res, 400, r.state === 'expired' ? 'link_expired' : 'invalid_link', r.state === 'expired' ? 'This link has expired. Ask the clinic for a new one.' : 'This link is not valid any more. Ask the clinic for a new one.');
    }
    const problems = R.passwordProblems(password, r.account);
    if (problems.length) return fail(res, 422, 'weak_password', problems[0], problems);
    await store.updateToken(r.t.id, { usedAt: new Date() });
    await store.update(r.account.id, { passwordHash: hashPassword(password), passwordChangedAt: new Date() });
    const ended = revokeUserSessions(r.account.id, 'password_changed');
    await audit({ ip: req.ip, user: { id: r.account.id, role: r.account.role } }, 'password_reset_completed', r.account.id, { sessionsEnded: ended.sessions });
    return res.json({ reset: true, username: r.account.username });
  } catch (err) {
    return next(err);
  }
});

/* =============================== testing only =============================== */
const testing = express.Router();
testing.get('/account-sms', (req, res) => {
  if (!config.accountSmsCapture) return res.status(404).json({ error: 'not_found' });
  if (req.get('x-internal-token') !== config.internalServiceToken) return res.status(401).json({ error: 'unauthorized' });
  const to = R.normalizePhone(req.query.to);
  const m = to ? lastCaptured(to, req.query.purpose) : null;
  return m ? res.json(m) : res.status(404).json({ error: 'not_found', message: 'No captured SMS for that number' });
});

module.exports = { admin, pub, testing };

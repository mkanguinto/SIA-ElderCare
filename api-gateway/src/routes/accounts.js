'use strict';

/**
 * Account management (Batch 3a).
 *
 * Admin (system_admin), mounted at /api/admin/accounts and /api/admin/audit:
 *   GET    /api/admin/accounts                          accounts with status, sessions and the open activation code (no secrets)
 *   POST   /api/admin/accounts                          {username, name, role, phone, patients?} -> pending account + activation code by SMS
 *   POST   /api/admin/accounts/:id/activation-code      send a new activation code (the old one stops working)
 *   POST   /api/admin/accounts/:id/password-reset       send a password-reset code by SMS (the admin never sees it)
 *   POST   /api/admin/accounts/:id/disable              {reason}  signs the user out everywhere
 *   POST   /api/admin/accounts/:id/enable
 *   GET    /api/admin/accounts/:id/sessions             active sessions (device, last activity, locked)
 *   DELETE /api/admin/accounts/:id/sessions/:sid        end one session
 *   GET    /api/admin/accounts/:id/messages             activation code / reset link: where it went and its SMS delivery state
 *   GET    /api/admin/audit?targetId=&staffId=&action=&limit=   account audit log (staffId: every account of one person)
 *   GET    /api/admin/sms-check                         is real SMS ready: mode, allow-list, sending phone, today's count
 *
 * Staff identity: nurse and admin accounts carry a staff ID (ST-001). A person who is both admin and nurse gets two
 * separate accounts with the same staff ID - separate passwords, sessions and roles, one identity in the audit log.
 * An admin cannot run account actions on another account of their own staff ID.
 *
 * SMS delivery is reported as it is: 'simulated' = NOT sent, 'queued' = waiting for the SMS phone, 'sent' = left
 * the phone, 'delivered' = the network confirmed it, 'failed'. Nothing but 'delivered' is shown as received.
 *
 * Public (rate limited like /oauth), mounted at /auth:
 *   POST /auth/activate                {username, code, password}   activation code from SMS -> own password
 *   POST /auth/password-reset          {username, code, password}   reset code from SMS -> new password, sign out everywhere
 *
 * Account SMS carry no web links: Philippine networks block or silently drop person-to-person texts with links
 * (and may still report them delivered), so the user types the code into the app instead of tapping a link.
 *
 * Testing only (ACCOUNT_SMS_CAPTURE=true, never production), mounted at /internal/test:
 *   GET /internal/test/account-sms?to=&purpose=     X-Internal-Token   last captured account SMS
 */
const express = require('express');
const config = require('../config');
const logger = require('../lib/logger');
const { authenticate } = require('../middleware/authMiddleware');
const { ROLES } = require('../config/roles');
const { adminOrTeamLead, isTeamLead } = require('../middleware/teamLead');
const { store, hashPassword, publicAccount, audit } = require('../auth/userStore');
const { sendAccountSms, checkAccountSms, smsHealth, lastCaptured } = require('../auth/accountSms');
const { revokeUserSessions, listUserSessions, revokeOneSession } = require('../auth/tokenService');
const R = require('../auth/accountRules');

const ID_RE = /^[A-Za-z0-9._-]{1,64}$/;
const quiet = (p) => p.catch((err) => logger.error('account audit write failed', { error: err.message }));

/**
 * Creates a one-time secret for an account, replaces any open one for the same purpose, texts it to the
 * account's phone, and returns what the admin may see (masked number, delivery, expiry) - never the secret.
 */
async function issueSecret(req, account, purpose) {
  const secret = R.newActivationCode();
  const expiresAt = new Date(Date.now() + R.TOKEN_TTL_MIN[purpose] * 60000);
  await store.revokeOpenTokens(account.id, purpose);
  const token = await store.addToken({
    accountId: account.id, purpose, secretHash: R.hashSecret(secret, config.accountTokenPepper, purpose), expiresAt,
    sentTo: R.maskPhone(account.phone), createdBy: req.user.id,
  });
  // No links (see the header): the person opens the app and types the code.
  const body = purpose === 'activation'
    ? `ElderCare: your activation code is ${secret} (valid 24 hours). Open the ElderCare app, tap Activate my account, then enter the username ${account.username} and this code. Do not share it.`
    : `ElderCare: your password reset code is ${secret} (valid 1 hour). Open the ElderCare app, tap Sign in, then Forgot password. If you did not ask for this, ignore this SMS.`;
  const sms = await sendAccountSms({ to: account.phone, body, purpose, requestId: req.id });
  await store.updateToken(token.id, { delivery: sms.delivery, deliveryNote: sms.note, providerRef: sms.ref, deliveryUpdatedAt: new Date() });
  await audit(req, purpose === 'activation' ? 'activation_code_sent' : 'password_reset_sent', account.id, { sentTo: token.sentTo, delivery: sms.delivery, note: sms.note, expiresAt });
  return messageView({ ...token, delivery: sms.delivery, deliveryNote: sms.note, deliveryUpdatedAt: new Date() });
}

const FOLLOW = ['queued', 'sent', 'unknown'];

/** Asks the SMS provider what became of a queued message; records a change (and audits delivered / failed). */
async function followDelivery(req, t) {
  if (!t || !t.providerRef || !FOLLOW.includes(t.delivery) || Date.now() - new Date(t.createdAt).getTime() > 48 * 3600000) return t;
  const r = await checkAccountSms(t.providerRef, req.id);
  if (!r || (r.delivery === t.delivery && r.note === t.deliveryNote)) return t;
  const next = { ...t, delivery: r.delivery, deliveryNote: r.note, deliveryUpdatedAt: new Date() };
  await store.updateToken(t.id, { delivery: next.delivery, deliveryNote: next.deliveryNote, deliveryUpdatedAt: next.deliveryUpdatedAt });
  if (r.delivery !== t.delivery) {
    await audit(null, 'sms_delivery_update', t.accountId, { actorId: 'system', actorRole: 'sms_provider', purpose: t.purpose, sentTo: t.sentTo, delivery: r.delivery, note: r.note });
  }
  return next;
}

/** What the admin may see about a code or link: never the secret. */
const messageView = (t) => (t ? {
  purpose: t.purpose, state: R.tokenState(t), sentTo: t.sentTo, delivery: t.delivery, note: t.deliveryNote || null,
  expiresAt: t.expiresAt, sentAt: t.createdAt, deliveryUpdatedAt: t.deliveryUpdatedAt || null,
} : null);

/** An admin's own accounts (same staff ID) are handled by another admin. */
const ownStaff = (req, a, me) => Boolean(a.staffId && me && me.staffId === a.staffId);

/* =============================== admin =============================== */
const admin = express.Router();
// The admin manages every account. A team-lead nurse creates and looks after caregiver and family accounts only
// (codes, resets, disable / enable) and reads the SMS check and the audit log; staff accounts and sessions stay
// with the admin.
admin.use(authenticate, adminOrTeamLead);
const COMMUNITY = ['caregiver', 'family_member'];
const adminOnly = (req, res, next) => (req.user.role === ROLES.ADMIN ? next() : res.status(403).json({ error: 'forbidden', message: 'Only the admin can do this' }));

async function loadTarget(req, res, { notOwn = false } = {}) {
  if (!ID_RE.test(req.params.id)) { res.status(404).json({ error: 'not_found', message: 'Account not found' }); return null; }
  const a = await store.getById(req.params.id);
  if (!a) { res.status(404).json({ error: 'not_found', message: 'Account not found' }); return null; }
  if (isTeamLead(req) && !COMMUNITY.includes(a.role)) {
    res.status(403).json({ error: 'forbidden', message: 'A team-lead nurse manages caregiver and family accounts only' });
    return null;
  }
  if (notOwn && a.id !== req.user.id && ownStaff(req, a, await store.getById(req.user.id))) {
    res.status(409).json({ error: 'own_account', message: `This is another account of yours (${a.staffId}). Ask another admin to do this.` });
    return null;
  }
  return a;
}

admin.get('/accounts', async (req, res, next) => {
  try {
    const accounts = (await store.list()).filter((a) => !isTeamLead(req) || COMMUNITY.includes(a.role));
    const rows = await Promise.all(accounts.map(async (a) => {
      const t = a.status === 'pending_activation' ? await followDelivery(req, await store.latestToken(a.id, 'activation')) : null;
      return { ...publicAccount(a), sessions: listUserSessions(a.id).length, activation: messageView(t) };
    }));
    const byRole = rows.reduce((acc, u) => ({ ...acc, [u.role]: (acc[u.role] || 0) + 1 }), {});
    // Staff identities: one person, possibly several accounts (e.g. admin + nurse).
    const staff = Object.values(rows.filter((u) => u.staffId).reduce((acc, u) => {
      const p = acc[u.staffId] || { staffId: u.staffId, name: u.name, accounts: [] };
      p.accounts.push({ id: u.id, username: u.username, role: u.role, status: u.status });
      return { ...acc, [u.staffId]: p };
    }, {})).sort((x, y) => x.staffId.localeCompare(y.staffId));
    res.json({ total: rows.length, byRole, store: store.kind, accounts: rows, staff });
  } catch (err) {
    next(err);
  }
});

admin.post('/accounts', async (req, res, next) => {
  try {
    const v = R.validateNewAccount(req.body);
    if (!v.ok) return res.status(422).json({ error: 'validation_failed', details: v.errors });
    if (isTeamLead(req) && !COMMUNITY.includes(v.value.role)) return res.status(403).json({ error: 'forbidden', message: 'A team-lead nurse creates caregiver and family accounts only' });
    if (await store.getByUsername(v.value.username)) return res.status(409).json({ error: 'conflict', message: `The username ${v.value.username} is taken` });
    const all = await store.list();
    let { staffId } = v.value;
    let linked = [];
    if (staffId) {
      linked = all.filter((a) => a.staffId === staffId);
      const problem = R.staffLinkProblem(staffId, v.value.role, v.value.name, linked);
      if (problem) return res.status(problem.status).json({ error: problem.status === 409 ? 'conflict' : 'validation_failed', message: problem.message, details: [problem.message] });
    } else if (R.STAFF_ROLES.includes(v.value.role)) {
      staffId = R.nextStaffId(all.map((a) => a.staffId));
    }
    let account = null;
    for (let i = 0; i < 3 && !account; i += 1) {
      const id = R.nextAccountId(v.value.role, (await store.list()).map((a) => a.id));
      try {
        account = await store.insert({ ...v.value, staffId, id, passwordHash: null, status: 'pending_activation', createdBy: req.user.id });
      } catch (err) {
        if (err.code !== 'conflict') throw err; // two admins at once took the same id: try the next one
      }
    }
    if (!account) return res.status(409).json({ error: 'conflict', message: 'Could not allocate an account id, try again' });
    await audit(req, 'account_created', account.id, {
      role: account.role, username: account.username, patients: account.patients, staffId: account.staffId || undefined,
      linkedAccounts: linked.length ? linked.map((a) => a.id) : undefined,
    });
    const sms = await issueSecret(req, account, 'activation');
    logger.info('account created', { requestId: req.id, accountId: account.id, role: account.role, by: req.user.id, delivery: sms.delivery });
    return res.status(201).json({ account: publicAccount(account), activation: sms });
  } catch (err) {
    return next(err);
  }
});

admin.post('/accounts/:id/activation-code', async (req, res, next) => {
  try {
    const a = await loadTarget(req, res, { notOwn: true });
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
    const a = await loadTarget(req, res, { notOwn: true });
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
    const a = await loadTarget(req, res, { notOwn: true });
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
    const a = await loadTarget(req, res, { notOwn: true });
    if (!a) return undefined;
    if (a.status !== 'disabled') return res.status(409).json({ error: 'conflict', message: 'The account is not disabled' });
    const updated = await store.update(a.id, { status: a.passwordHash ? 'active' : 'pending_activation', disabledAt: null, disabledBy: null, disabledReason: null });
    await audit(req, 'account_enabled', a.id);
    return res.json({ account: publicAccount(updated) });
  } catch (err) {
    return next(err);
  }
});

admin.get('/accounts/:id/messages', async (req, res, next) => {
  try {
    const a = await loadTarget(req, res);
    if (!a) return undefined;
    const [activation, passwordReset] = await Promise.all(['activation', 'password_reset'].map(async (p) => messageView(await followDelivery(req, await store.latestToken(a.id, p)))));
    return res.json({ accountId: a.id, status: a.status, activation, passwordReset });
  } catch (err) {
    return next(err);
  }
});

admin.get('/sms-check', async (req, res, next) => {
  try {
    const h = await smsHealth(req.id);
    const problems = [];
    if (!h.mode.live) problems.push(`SMS is not live: ${h.mode.reason}. Codes and links are NOT sent to anyone.`);
    if (h.gateway && h.gateway.error) problems.push(`The SMS provider could not be reached (${h.gateway.error}).`);
    if (h.gateway && h.gateway.deviceIdProblem) problems.push(h.gateway.deviceIdProblem);
    if (h.gateway && !h.gateway.error && !h.gateway.device) problems.push('No enabled SMS phone is linked to the TextBee account.');
    const seen = h.gateway && h.gateway.device && h.gateway.device.lastSeenAt ? Date.now() - new Date(h.gateway.device.lastSeenAt).getTime() : null;
    if (seen !== null && seen > 2 * 3600000) problems.push(`The SMS phone was last online ${Math.round(seen / 3600000)} h ago: messages wait until it is back online.`);
    if (h.gateway && h.gateway.needsSmsPermission) problems.push('The TextBee app on the SMS phone needs the SMS permission.');
    if (h.sentToday >= h.dailyLimit) problems.push(`Today's SMS limit (${h.dailyLimit}) is used up.`);
    res.json({ ready: problems.length === 0, problems, ...h });
  } catch (err) {
    res.status(502).json({ error: 'sms_check_failed', ready: false, problems: [`The SMS service could not be reached (${err.message}).`] });
  }
});

admin.get('/accounts/:id/sessions', adminOnly, async (req, res, next) => {
  try {
    const a = await loadTarget(req, res);
    if (!a) return undefined;
    return res.json({ sessions: listUserSessions(a.id) });
  } catch (err) {
    return next(err);
  }
});

admin.delete('/accounts/:id/sessions/:sid', adminOnly, async (req, res, next) => {
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
    const staffId = req.query.staffId && /^ST-\d{3,6}$/.test(String(req.query.staffId).toUpperCase()) ? String(req.query.staffId).toUpperCase() : undefined;
    const entries = await store.auditList({ limit: Math.min(Number(req.query.limit) || 100, 500), targetId, action, staffId });
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

pub.post('/password-reset', async (req, res, next) => {
  try {
    const { username, code, password } = req.body || {};
    if (typeof username !== 'string' || typeof code !== 'string' || typeof password !== 'string') {
      return fail(res, 400, 'invalid_request', 'username, code and password are required');
    }
    const a = await store.getByUsername(username.trim());
    // Same answer for an unknown username and a wrong code.
    if (!a || a.status !== 'active') {
      quiet(audit(req, 'password_reset_failed', a ? a.id : null, { reason: a ? `account_${a.status}` : 'unknown_username' }));
      return fail(res, 400, 'invalid_code', R.TOKEN_MESSAGE.missing);
    }
    let t = await store.findToken(R.hashSecret(code, config.accountTokenPepper, 'password_reset'), 'password_reset');
    if (t && t.accountId !== a.id) t = null;
    if (!t) {
      const open = await store.latestToken(a.id, 'password_reset');
      if (open && R.tokenState(open) === 'ok') await store.updateToken(open.id, { attempts: open.attempts + 1 });
      quiet(audit(req, 'password_reset_failed', a.id, { reason: 'wrong_code' }));
      return fail(res, 400, 'invalid_code', open && open.attempts + 1 >= R.MAX_ATTEMPTS ? R.TOKEN_MESSAGE.locked : R.TOKEN_MESSAGE.missing);
    }
    const state = R.tokenState(t);
    if (state !== 'ok') {
      quiet(audit(req, 'password_reset_failed', a.id, { reason: state }));
      return fail(res, 400, state === 'expired' ? 'code_expired' : 'invalid_code', state === 'used' ? 'This code was already used. Ask the clinic for a new one.' : R.TOKEN_MESSAGE[state]);
    }
    const problems = R.passwordProblems(password, a);
    if (problems.length) return fail(res, 422, 'weak_password', problems[0], problems);
    await store.updateToken(t.id, { usedAt: new Date() });
    await store.update(a.id, { passwordHash: hashPassword(password), passwordChangedAt: new Date() });
    const ended = revokeUserSessions(a.id, 'password_changed');
    await audit({ ip: req.ip, user: { id: a.id, role: a.role } }, 'password_reset_completed', a.id, { sessionsEnded: ended.sessions });
    return res.json({ reset: true, username: a.username });
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

'use strict';

// Accounts, sessions and the admin's limits (Batch 3a). File-backed account store, SMS captured in memory.
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');
const fs = require('fs');
const os = require('os');
const path = require('path');

process.env.JWT_SECRET = 'test-access-secret-0123456789abcdef0123';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';
process.env.LOG_LEVEL = 'error';
process.env.AUTH_DATABASE_URL = '';
process.env.ACCOUNT_SMS_CAPTURE = 'true';
process.env.NODE_ENV = 'test';
process.env.RATE_LIMIT_AUTH_MAX = '500';
const tmpUsers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ec-accounts-')), 'users.json');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'users.json'), tmpUsers);
process.env.USERS_FILE = tmpUsers;
process.env.TOKEN_STORE_FILE = 'memory';

const upstream = express();
upstream.use(express.json());
upstream.post('/internal/messages/sms', (req, res) => res.json({ status: 'simulated' }));
upstream.all('*', (req, res) => res.json({ path: req.originalUrl }));
const upstreamServer = upstream.listen(0);
const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
for (const s of ['CHECKIN', 'ALERT', 'CLINIC', 'CARE']) process.env[`${s}_SERVICE_URL`] = upstreamUrl;

const app = require('../server');
const { store } = require('../src/auth/accountStore');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); upstreamServer.close(); });

async function call(method, p, { token, body, ua } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(ua ? { 'user-agent': ua } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}
const signIn = (username, password = 'ElderCare@2026', device) => call('POST', '/oauth/token', { body: { grant_type: 'password', username, password, ...(device ? { device } : {}) } });
async function token(username, device) {
  const r = await signIn(username, undefined, device);
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body;
}
const sms = async (to, purpose) => {
  const res = await fetch(`${base}/internal/test/account-sms?to=${encodeURIComponent(to)}&purpose=${purpose}`, { headers: { 'x-internal-token': 'test-internal-token' } });
  return res.status === 200 ? res.json() : null;
};
const codeIn = (m) => m.body.match(/code is ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
const linkIn = (m) => m.body.match(/reset-password#([A-Za-z0-9_-]+)/)[1];

test('account creation -> activation -> login (caregiver); the admin never sees the code', async () => {
  const admin = (await token('admin.harold')).access_token;
  const r = await call('POST', '/api/admin/accounts', { token: admin, body: { username: 'caregiver.liza', name: 'Liza Ramos', role: 'caregiver', phone: '0917 555 0199', patients: ['P-1003'] } });
  assert.strictEqual(r.status, 201, JSON.stringify(r.body));
  assert.strictEqual(r.body.account.status, 'pending_activation');
  assert.match(r.body.account.id, /^U-CG-\d{3}$/);
  assert.strictEqual(r.body.activation.sentTo, '+63 9•• ••• 0199');
  assert.ok(!JSON.stringify(r.body).match(/[A-Z0-9]{4}-[A-Z0-9]{4}/), 'no code in the admin response');
  assert.ok(!JSON.stringify(r.body).includes('passwordHash'));

  const pending = await signIn('caregiver.liza', 'anything');
  assert.strictEqual(pending.status, 400);
  assert.strictEqual(pending.body.reason, 'account_pending');

  const code = codeIn(await sms('+639175550199', 'activation'));
  assert.strictEqual((await call('POST', '/auth/activate', { body: { username: 'caregiver.liza', code: 'ABCD-EFGH', password: 'Kalamansi2026' } })).status, 400, 'wrong code');
  const weak = await call('POST', '/auth/activate', { body: { username: 'caregiver.liza', code, password: 'short1' } });
  assert.strictEqual(weak.status, 422);
  assert.strictEqual(weak.body.error, 'weak_password');
  const ok = await call('POST', '/auth/activate', { body: { username: 'caregiver.liza', code: code.toLowerCase().replace('-', ' '), password: 'Kalamansi2026' } });
  assert.strictEqual(ok.status, 200, JSON.stringify(ok.body));
  assert.strictEqual((await call('POST', '/auth/activate', { body: { username: 'caregiver.liza', code, password: 'Kalamansi2026' } })).status, 400, 'single use');

  const liza = await signIn('caregiver.liza', 'Kalamansi2026');
  assert.strictEqual(liza.status, 200);
  assert.strictEqual(liza.body.role, 'caregiver');
});

test('activation code expires after 24 hours', async () => {
  const admin = (await token('admin.harold')).access_token;
  const r = await call('POST', '/api/admin/accounts', { token: admin, body: { username: 'nurse.dino', name: 'Dino Santos, RN', role: 'clinic_staff', phone: '+639175550198' } });
  assert.strictEqual(r.status, 201);
  assert.strictEqual(new Date(r.body.activation.expiresAt).getTime() - Date.now() > 23.9 * 3600000, true, 'valid for 24 h');
  const code = codeIn(await sms('+639175550198', 'activation'));
  // Move the clock: the code was sent more than 24 hours ago.
  const t = await store.latestToken(r.body.account.id, 'activation');
  store.tokens.find((x) => x.id === t.id).expiresAt = new Date(Date.now() - 1000);
  const late = await call('POST', '/auth/activate', { body: { username: 'nurse.dino', code, password: 'Malunggay2026' } });
  assert.strictEqual(late.status, 400);
  assert.strictEqual(late.body.error, 'code_expired');
  // A new code works; the old one stays dead.
  assert.strictEqual((await call('POST', `/api/admin/accounts/${r.body.account.id}/activation-code`, { token: admin })).status, 200);
  const fresh = codeIn(await sms('+639175550198', 'activation'));
  assert.notStrictEqual(fresh, code);
  assert.strictEqual((await call('POST', '/auth/activate', { body: { username: 'nurse.dino', code: fresh, password: 'Malunggay2026' } })).status, 200);
});

test('five wrong codes lock the activation code', async () => {
  const admin = (await token('admin.harold')).access_token;
  await call('POST', '/api/admin/accounts', { token: admin, body: { username: 'caregiver.tess', name: 'Tess Lim', role: 'caregiver', phone: '09175550197' } });
  const code = codeIn(await sms('+639175550197', 'activation'));
  for (let i = 0; i < 5; i += 1) await call('POST', '/auth/activate', { body: { username: 'caregiver.tess', code: 'ZZZZ-ZZZZ', password: 'Sampaguita2026' } });
  const r = await call('POST', '/auth/activate', { body: { username: 'caregiver.tess', code, password: 'Sampaguita2026' } });
  assert.strictEqual(r.status, 400);
  assert.match(r.body.message, /Too many wrong tries/);
});

test('password reset goes by SMS link; the admin never sees it; old sessions end', async () => {
  const admin = (await token('admin.harold')).access_token;
  const before = (await signIn('caregiver.liza', 'Kalamansi2026')).body;
  const { id } = await store.getByUsername('caregiver.liza');
  const r = await call('POST', `/api/admin/accounts/${id}/password-reset`, { token: admin });
  assert.strictEqual(r.status, 200);
  assert.ok(!JSON.stringify(r.body).includes('reset-password#'));
  const link = linkIn(await sms('+639175550199', 'password_reset'));
  assert.strictEqual((await call('POST', '/auth/password-reset/check', { body: { token: link } })).body.username, 'caregiver.liza');
  assert.strictEqual((await call('POST', '/auth/password-reset', { body: { token: link, password: 'Bayabas2027' } })).status, 200);
  assert.strictEqual((await call('POST', '/auth/password-reset', { body: { token: link, password: 'Bayabas2028' } })).status, 400, 'link is single use');
  assert.strictEqual((await signIn('caregiver.liza', 'Kalamansi2026')).status, 400, 'old password gone');
  assert.strictEqual((await signIn('caregiver.liza', 'Bayabas2027')).status, 200);
  assert.strictEqual((await call('GET', '/api/patients/P-1003', { token: before.access_token })).status, 401, 'old session ended');
});

test('single session per user; a nurse may keep one phone and one desktop session', async () => {
  const first = await token('caregiver.maria');
  const second = await token('caregiver.maria');
  const r = await call('GET', '/api/patients/P-1001', { token: first.access_token });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.reason, 'session_replaced');
  assert.strictEqual((await call('GET', '/api/patients/P-1001', { token: second.access_token })).status, 200);

  const phone = await token('nurse.ana', 'phone');
  const desktop = await token('nurse.ana', 'desktop');
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: phone.access_token })).status, 200, 'phone still on');
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: desktop.access_token })).status, 200, 'desktop on');
  const phone2 = await token('nurse.ana', 'phone');
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: phone.access_token })).body.reason, 'session_replaced', 'older phone session ended');
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: desktop.access_token })).status, 200, 'desktop kept');
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: phone2.access_token })).status, 200);
});

test('inactivity lock: API refused until the password is entered again', async () => {
  const s = await token('nurse.ben');
  assert.strictEqual((await call('POST', '/oauth/lock', { token: s.access_token })).status, 204);
  const r = await call('GET', '/api/clinic/my-cases', { token: s.access_token });
  assert.strictEqual(r.status, 401);
  assert.strictEqual(r.body.reason, 'session_locked');
  const refresh = await call('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: s.refresh_token } });
  assert.strictEqual(refresh.body.reason, 'session_locked', 'refresh does not bypass the lock');
  assert.strictEqual((await call('POST', '/oauth/unlock', { body: { refresh_token: s.refresh_token, password: 'wrong-one-1' } })).body.reason, 'bad_password');
  const u = await call('POST', '/oauth/unlock', { body: { refresh_token: s.refresh_token, password: 'ElderCare@2026' } });
  assert.strictEqual(u.status, 200);
  assert.strictEqual((await call('GET', '/api/clinic/my-cases', { token: u.body.access_token })).status, 200);
  // Three wrong passwords sign the user out.
  assert.strictEqual((await call('POST', '/oauth/lock', { token: u.body.access_token })).status, 204);
  for (let i = 0; i < 2; i += 1) await call('POST', '/oauth/unlock', { body: { refresh_token: u.body.refresh_token, password: 'nope-nope-1' } });
  assert.strictEqual((await call('POST', '/oauth/unlock', { body: { refresh_token: u.body.refresh_token, password: 'nope-nope-1' } })).body.reason, 'session_ended');
});

test('admin sessions view and revocation', async () => {
  const admin = (await token('admin.harold')).access_token;
  const s = await token('family.jose');
  const list = await call('GET', '/api/admin/accounts/U-FM-001/sessions', { token: admin });
  assert.strictEqual(list.body.sessions.length, 1);
  assert.strictEqual((await call('DELETE', `/api/admin/accounts/U-FM-001/sessions/${list.body.sessions[0].id}`, { token: admin })).status, 200);
  assert.strictEqual((await call('GET', '/api/patients/P-1001', { token: s.access_token })).status, 401);
});

test('disabled accounts cannot sign in and are signed out; admin cannot disable itself', async () => {
  const admin = (await token('admin.harold')).access_token;
  const s = await token('nurse.carla');
  assert.strictEqual((await call('POST', '/api/admin/accounts/U-CS-003/disable', { token: admin, body: {} })).status, 422, 'reason required');
  assert.strictEqual((await call('POST', '/api/admin/accounts/U-CS-003/disable', { token: admin, body: { reason: 'Left the clinic' } })).status, 200);
  assert.strictEqual((await call('GET', '/api/clinic/my-cases', { token: s.access_token })).status, 401);
  assert.strictEqual((await signIn('nurse.carla')).body.reason, 'account_disabled');
  assert.strictEqual((await call('POST', '/api/admin/accounts/U-CS-003/enable', { token: admin })).status, 200);
  assert.strictEqual((await signIn('nurse.carla')).status, 200);
  assert.strictEqual((await call('POST', '/api/admin/accounts/U-AD-001/disable', { token: (await token('admin.harold')).access_token, body: { reason: 'test' } })).status, 409);
});

test('admin is technical, not clinical: no patient records, no clinical actions', async () => {
  const admin = (await token('admin.harold')).access_token;
  const denied = [['GET', '/api/patients/P-1001'], ['GET', '/api/patients/P-1001/history'], ['GET', '/api/patients'], ['GET', '/api/patients/P-1001/medications'],
    ['GET', '/api/patients/P-1001/visits'], ['GET', '/api/patients/P-1001/care-plan'], ['GET', '/api/checkins/review-queue'], ['GET', '/api/checkins/abc'],
    ['GET', '/api/clinic/queue'], ['GET', '/api/clinic/queue/history'], ['GET', '/api/clinic/visits'], ['GET', '/api/clinic/patients/P-1001/emr-history'],
    ['POST', '/api/alerts/dispatch'], ['PATCH', '/api/clinic/queue/abc'], ['POST', '/api/checkins/abc/review']];
  for (const [m, p] of denied) assert.strictEqual((await call(m, p, { token: admin, body: m === 'GET' ? undefined : {} })).status, 403, `${m} ${p}`);
  for (const p of ['/api/clinic/queue/summary', '/api/admin/health', '/api/admin/accounts', '/api/admin/audit', '/api/clinic/care-teams']) {
    assert.strictEqual((await call('GET', p, { token: admin })).status, 200, p);
  }
});

test('every account action is in the audit log with who and when', async () => {
  const admin = (await token('admin.harold')).access_token;
  const r = await call('GET', '/api/admin/audit?limit=200', { token: admin });
  const actions = new Set(r.body.entries.map((e) => e.action));
  for (const a of ['account_created', 'activation_code_sent', 'account_activated', 'activation_failed', 'password_reset_sent', 'password_reset_completed',
    'account_disabled', 'account_enabled', 'session_revoked', 'login', 'login_failed', 'session_locked', 'session_unlocked']) {
    assert.ok(actions.has(a), `audit has ${a}`);
  }
  const created = r.body.entries.find((e) => e.action === 'account_created');
  assert.strictEqual(created.actorId, 'U-AD-001');
  assert.ok(created.at);
  assert.ok(!JSON.stringify(r.body).match(/code is|reset-password#|scrypt\$/), 'no secrets in the audit log');
  assert.strictEqual((await call('GET', '/api/admin/audit', { token: (await token('nurse.ana')).access_token })).status, 403);
});

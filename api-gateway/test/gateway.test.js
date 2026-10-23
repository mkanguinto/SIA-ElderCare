'use strict';

// Run: npm test   (uses Node's built-in test runner; no extra dependencies)
const test = require('node:test');
const assert = require('node:assert');
const express = require('express');

process.env.JWT_SECRET = 'test-access-secret-0123456789abcdef0123';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';
process.env.LOG_LEVEL = 'error';
// Work on a temporary copy of the users file: some tests change patient assignments.
const fs = require('fs');
const os = require('os');
const path = require('path');
const tmpUsers = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'ec-users-')), 'users.json');
fs.copyFileSync(path.join(__dirname, '..', 'data', 'users.json'), tmpUsers);
process.env.USERS_FILE = tmpUsers;
process.env.TOKEN_STORE_FILE = 'memory';

// Fake upstream that echoes what the gateway forwarded.
const upstream = express();
upstream.use(express.json());
upstream.all('*', (req, res) => res.json({ path: req.originalUrl, headers: req.headers, body: req.body }));
const upstreamServer = upstream.listen(0);
const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
process.env.CHECKIN_SERVICE_URL = upstreamUrl;
process.env.ALERT_SERVICE_URL = upstreamUrl;
process.env.CLINIC_SERVICE_URL = upstreamUrl;
process.env.CARE_SERVICE_URL = upstreamUrl;

const jwt = require('jsonwebtoken');
const app = require('../server');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;

async function call(method, path, { token, body } = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => ({})) };
}

async function login(username) {
  const r = await call('POST', '/oauth/token', { body: { grant_type: 'password', username, password: 'ElderCare@2026' } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  return r.body;
}

test.after(() => { server.close(); upstreamServer.close(); });

test('rejects requests without a token (401 + WWW-Authenticate)', async () => {
  const res = await fetch(`${base}/api/clinic/queue`);
  assert.strictEqual(res.status, 401);
  assert.match(res.headers.get('www-authenticate'), /Bearer/);
});

test('rejects bad credentials with RFC 6749 invalid_grant', async () => {
  const r = await call('POST', '/oauth/token', { body: { grant_type: 'password', username: 'nurse.ana', password: 'wrong' } });
  assert.strictEqual(r.status, 400);
  assert.strictEqual(r.body.error, 'invalid_grant');
});

test('caregiver can submit a check-in for an assigned patient; identity is forwarded', async () => {
  const { access_token } = await login('caregiver.maria');
  const r = await call('POST', '/api/checkins', { token: access_token, body: { patientId: 'P-1001' } });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.path, '/api/checkins');
  assert.strictEqual(r.body.headers['x-user-role'], 'caregiver');
  assert.strictEqual(r.body.headers['x-internal-token'], 'test-internal-token');
  assert.strictEqual(r.body.headers.authorization, `Bearer ${access_token}`);
});

test('caregiver cannot submit a check-in for an unassigned patient', async () => {
  const { access_token } = await login('caregiver.maria');
  const r = await call('POST', '/api/checkins', { token: access_token, body: { patientId: 'P-9999' } });
  assert.strictEqual(r.status, 403);
});

test('family member can read own relative history but not others', async () => {
  const { access_token } = await login('family.jose');
  assert.strictEqual((await call('GET', '/api/patients/P-1001/history', { token: access_token })).status, 200);
  assert.strictEqual((await call('GET', '/api/patients/P-1002/history', { token: access_token })).status, 403);
});

test('family member cannot access the clinic-wide risk queue', async () => {
  const { access_token } = await login('family.jose');
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: access_token })).status, 403);
});

test('clinic staff can read the queue and dispatch alerts; caregiver cannot dispatch', async () => {
  const nurse = await login('nurse.ana');
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: nurse.access_token })).status, 200);
  assert.strictEqual((await call('POST', '/api/alerts/dispatch', { token: nurse.access_token, body: { patientId: 'P-1001' } })).status, 200);
  const cg = await login('caregiver.maria');
  assert.strictEqual((await call('POST', '/api/alerts/dispatch', { token: cg.access_token, body: { patientId: 'P-1001' } })).status, 403);
});

test('spoofed X-User-Role header from the client is stripped', async () => {
  const { access_token } = await login('family.jose');
  const res = await fetch(`${base}/api/patients/P-1001/history`, { headers: { authorization: `Bearer ${access_token}`, 'x-user-role': 'system_admin' } });
  const body = await res.json();
  assert.strictEqual(body.headers['x-user-role'], 'family_member');
});

test('rejects alg=none and wrong-secret tokens', async () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const none = `${b64({ alg: 'none', typ: 'JWT' })}.${b64({ typ: 'access', role: 'system_admin', sub: 'x', iss: 'eldercare-connect-auth', aud: 'eldercare-connect-api', exp: Math.floor(Date.now() / 1000) + 600 })}.`;
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: none })).status, 401);
  const forged = jwt.sign({ typ: 'access', role: 'system_admin' }, 'wrong-secret', { subject: 'x', issuer: 'eldercare-connect-auth', audience: 'eldercare-connect-api' });
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: forged })).status, 401);
});

test('refresh token cannot be used as an access token, but can mint a new one', async () => {
  const { refresh_token } = await login('nurse.ana');
  assert.strictEqual((await call('GET', '/api/clinic/queue', { token: refresh_token })).status, 401);
  const r = await call('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token } });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.access_token);
});

test('expired token is rejected', async () => {
  const expired = jwt.sign({ typ: 'access', role: 'clinic_staff', exp: Math.floor(Date.now() / 1000) - 120 }, process.env.JWT_SECRET, { subject: 'x', issuer: 'eldercare-connect-auth', audience: 'eldercare-connect-api' });
  const r = await call('GET', '/api/clinic/queue', { token: expired });
  assert.strictEqual(r.status, 401);
  assert.match(r.body.message, /expired/);
});

test('admin health endpoint reports every downstream service', async () => {

  const admin = await login('admin.harold');
  const r = await call('GET', '/api/admin/health', { token: admin.access_token });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.services.find((s) => s.name === 'legacyAdapter'));
});

test('admin can list users without password hashes; nurse cannot', async () => {
  const admin = await login('admin.harold');
  const r = await call('GET', '/api/admin/users', { token: admin.access_token });
  assert.strictEqual(r.status, 200);
  assert.strictEqual(r.body.total, 6); // caregiver, family, three nurses (care team handover), admin
  assert.ok(r.body.users.every((u) => !('passwordHash' in u)));
  const nurse = await login('nurse.ana');
  assert.strictEqual((await call('GET', '/api/admin/users', { token: nurse.access_token })).status, 403);
});

test('clinic staff can list caregivers; family members cannot use the directory', async () => {
  const nurse = await login('nurse.ana');
  const r = await call('GET', '/api/directory/users?role=caregiver', { token: nurse.access_token });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.users.length >= 1 && r.body.users.every((u) => u.role === 'caregiver' && !('passwordHash' in u)));
  const fam = await login('family.jose');
  assert.strictEqual((await call('GET', '/api/directory/users', { token: fam.access_token })).status, 403);
});

test('assigning a new patient to a caregiver takes effect at next sign-in', async () => {
  const nurse = await login('nurse.ana');
  const r = await call('PUT', '/api/directory/users/U-CG-001/patients', { token: nurse.access_token, body: { add: ['P-1004'] } });
  assert.strictEqual(r.status, 200, JSON.stringify(r.body));
  assert.ok(r.body.user.patients.includes('P-1004'));
  const cg = await login('caregiver.maria');
  const ok = await call('GET', '/api/patients/P-1004/medications', { token: cg.access_token });
  assert.strictEqual(ok.status, 200);
  const bad = await call('PUT', '/api/directory/users/U-CS-001/patients', { token: nurse.access_token, body: { add: ['P-1004'] } });
  assert.strictEqual(bad.status, 422); // clinic staff are not patient-scoped
});

test('new v1.1 routes enforce roles', async () => {
  const cg = await login('caregiver.maria');
  const fam = await login('family.jose');
  const nurse = await login('nurse.ana');
  assert.strictEqual((await call('POST', '/api/patients', { token: cg.access_token, body: {} })).status, 403);
  assert.strictEqual((await call('GET', '/api/clinic/queue/history', { token: fam.access_token })).status, 403);
  assert.strictEqual((await call('GET', '/api/patients/P-1002/visits', { token: fam.access_token })).status, 403);
  const v = await call('GET', '/api/patients/P-1001/visits?view=recent', { token: fam.access_token });
  assert.strictEqual(v.status, 200);
  assert.strictEqual(v.body.path, '/api/clinic/visits?patientId=P-1001&view=recent');
  assert.strictEqual((await call('POST', '/api/clinic/queue/x/visits', { token: nurse.access_token, body: {} })).status, 200);
});

test('care team and handover routes: nurses hand over, only the admin manages teams, admin never sees handover content', async () => {
  const nurse = (await login('nurse.ana')).access_token;
  const admin = (await login('admin.harold')).access_token;
  const cg = (await login('caregiver.maria')).access_token;
  const fam = (await login('family.jose')).access_token;
  const nurseOnly = [['POST', '/api/clinic/handover'], ['POST', '/api/clinic/handover/abc/accept'], ['POST', '/api/clinic/handover/abc/decline'],
    ['POST', '/api/clinic/handover/abc/cancel'], ['GET', '/api/clinic/my-cases'], ['GET', '/api/clinic/queue/pending-handovers'],
    ['GET', '/api/clinic/patients/P-1001/care'], ['PUT', '/api/clinic/duty/me']];
  for (const [method, path] of nurseOnly) {
    const body = method === 'GET' ? undefined : {};
    assert.strictEqual((await call(method, path, { token: nurse, body })).status, 200, `${method} ${path} as nurse`);
    for (const [who, t] of [['admin', admin], ['caregiver', cg], ['family', fam]]) {
      assert.strictEqual((await call(method, path, { token: t, body })).status, 403, `${method} ${path} as ${who}`);
    }
  }
  const adminOnly = [['POST', '/api/clinic/care-teams'], ['POST', '/api/clinic/care-teams/CT-A/members'], ['DELETE', '/api/clinic/care-teams/CT-A/members/U-CS-002'],
    ['PUT', '/api/clinic/patients/P-1001/care'], ['GET', '/api/clinic/care-log']];
  for (const [method, path] of adminOnly) {
    const body = method === 'GET' ? undefined : {};
    assert.strictEqual((await call(method, path, { token: admin, body })).status, 200, `${method} ${path} as admin`);
    assert.strictEqual((await call(method, path, { token: nurse, body })).status, 403, `${method} ${path} as nurse`);
  }
  for (const path of ['/api/clinic/care-teams', '/api/clinic/duty']) {
    assert.strictEqual((await call('GET', path, { token: nurse })).status, 200);
    assert.strictEqual((await call('GET', path, { token: admin })).status, 200);
    assert.strictEqual((await call('GET', path, { token: cg })).status, 403);
  }
  assert.strictEqual((await call('POST', '/api/clinic/handover/abc/approve', { token: nurse, body: {} })).status, 404);
});

test('alert rules: clinic staff can read, only admins can change; pagination params are forwarded', async () => {
  const nurse = (await login('nurse.ana')).access_token;
  const admin = (await login('admin.harold')).access_token;
  const fam = (await login('family.jose')).access_token;
  const list = await call('GET', '/api/alerts/rules?page=2&pageSize=5', { token: nurse });
  assert.strictEqual(list.status, 200);
  assert.strictEqual(list.body.path, '/api/alerts/rules?page=2&pageSize=5');
  assert.strictEqual((await call('GET', '/api/alerts/rules', { token: fam })).status, 403);
  for (const [method, path] of [['POST', '/api/alerts/rules'], ['PATCH', '/api/alerts/rules/WEATHER_HEAT'], ['DELETE', '/api/alerts/rules/WEATHER_HEAT']]) {
    assert.strictEqual((await call(method, path, { token: nurse, body: {} })).status, 403, `${method} as nurse`);
    assert.strictEqual((await call(method, path, { token: admin, body: {} })).status, 200, `${method} as admin`);
  }
});

test('webhook bodies are forwarded byte-for-byte (needed for TextBee signatures)', async () => {
  const raw = '{"webhookEvent":"MESSAGE_RECEIVED",   "message":"HELP"}';
  const res = await fetch(`${base}/webhooks/textbee`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-signature': 'abc' }, body: raw });
  const body = await res.json();
  assert.strictEqual(body.headers['content-length'], String(Buffer.byteLength(raw)));
  assert.strictEqual(body.headers['x-signature'], 'abc');
});

test('care plan routes: patient scope at the gateway, clinic-only plan changes, caregiver-only completions', async () => {
  const cg = (await login('caregiver.maria')).access_token;
  const fam = (await login('family.jose')).access_token;
  const nurse = (await login('nurse.ana')).access_token;
  assert.strictEqual((await call('GET', '/api/care/categories', { token: fam })).status, 200);
  assert.strictEqual((await call('GET', '/api/patients/P-1001/care-plan/checklist?date=2026-10-22', { token: fam })).body.path, '/api/patients/P-1001/care-plan/checklist?date=2026-10-22');
  assert.strictEqual((await call('GET', '/api/patients/P-1002/care-plan', { token: fam })).status, 403);
  assert.strictEqual((await call('GET', '/api/patients/P-1003/care-plan/history', { token: cg })).status, 403);
  assert.strictEqual((await call('POST', '/api/patients/P-1001/care-plan/tasks', { token: cg, body: {} })).status, 403);
  assert.strictEqual((await call('POST', '/api/patients/P-1001/care-plan/tasks', { token: nurse, body: {} })).status, 200);
  assert.strictEqual((await call('POST', '/api/care/tasks/x/completions', { token: nurse, body: {} })).status, 403);
  assert.strictEqual((await call('POST', '/api/care/tasks/x/completions', { token: cg, body: {} })).status, 200);
});

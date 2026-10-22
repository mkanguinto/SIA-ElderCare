'use strict';

// Batch 2: revocation, refresh rotation + reuse detection, kid key rotation, *_FILE secrets.
const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const express = require('express');

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ec-sec-'));
// JWT_SECRET comes from a Docker-secret style file, not from the environment.
fs.writeFileSync(path.join(tmp, 'jwt_secret'), 'file-access-secret-0123456789abcdef0123\n');
process.env.JWT_SECRET_FILE = path.join(tmp, 'jwt_secret');
delete process.env.JWT_SECRET;
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';
process.env.JWT_KID = 'k2';
process.env.JWT_PREVIOUS_KEYS = JSON.stringify({ k1: 'old-access-secret-0123456789abcdef01234' });
process.env.JWT_KEY_ROTATED_AT = '2026-01-01';
process.env.REFRESH_REUSE_GRACE_SECONDS = '1';
process.env.TOKEN_STORE_FILE = 'memory';
process.env.LOG_LEVEL = 'error';
fs.copyFileSync(path.join(__dirname, '..', 'data', 'users.json'), path.join(tmp, 'users.json'));
process.env.USERS_FILE = path.join(tmp, 'users.json');

const upstream = express();
upstream.all('*', (req, res) => res.json({ ok: true }));
const upstreamServer = upstream.listen(0);
const upstreamUrl = `http://127.0.0.1:${upstreamServer.address().port}`;
process.env.CHECKIN_SERVICE_URL = upstreamUrl;
process.env.ALERT_SERVICE_URL = upstreamUrl;
process.env.CLINIC_SERVICE_URL = upstreamUrl;

const jwt = require('jsonwebtoken');
const app = require('../server');
const { TokenStore } = require('../src/auth/tokenStore');

const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); upstreamServer.close(); });

async function call(method, p, { token, body } = {}) {
  const res = await fetch(base + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: res.status === 204 ? null : await res.json().catch(() => ({})) };
}
const login = async (username) => (await call('POST', '/oauth/token', { body: { grant_type: 'password', username, password: 'ElderCare@2026' } })).body;
const refresh = (rt) => call('POST', '/oauth/token', { body: { grant_type: 'refresh_token', refresh_token: rt } });
const queue = (token) => call('GET', '/api/clinic/queue', { token });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

test('JWT_SECRET is read from JWT_SECRET_FILE and tokens carry kid + sid', async () => {
  const t = await login('nurse.ana');
  const { header, payload } = jwt.decode(t.access_token, { complete: true });
  assert.strictEqual(header.kid, 'k2');
  assert.ok(payload.sid && payload.jti);
  assert.strictEqual(jwt.decode(t.refresh_token, { complete: true }).payload.sid, payload.sid);
  jwt.verify(t.access_token, 'file-access-secret-0123456789abcdef0123'); // signed with the file secret
});

test('key rotation: tokens from the previous kid still verify, unknown kids do not', async () => {
  const opts = { subject: 'U-CS-001', issuer: 'eldercare-connect-auth', audience: 'eldercare-connect-api', expiresIn: '5m' };
  const claims = { typ: 'access', role: 'clinic_staff', name: 'Nurse', patients: [] };
  const old = jwt.sign(claims, 'old-access-secret-0123456789abcdef01234', { ...opts, keyid: 'k1' });
  assert.strictEqual((await queue(old)).status, 200);
  const retired = jwt.sign(claims, 'old-access-secret-0123456789abcdef01234', { ...opts, keyid: 'k0' });
  const r = await queue(retired);
  assert.strictEqual(r.status, 401);
  // A token claiming the active kid but signed with the old key is rejected too.
  assert.strictEqual((await queue(jwt.sign(claims, 'old-access-secret-0123456789abcdef01234', { ...opts, keyid: 'k2' }))).status, 401);
});

test('refresh rotates the refresh token; a spent token revokes the whole session', async () => {
  const t1 = await login('nurse.ana');
  const r1 = await refresh(t1.refresh_token);
  assert.strictEqual(r1.status, 200);
  assert.notStrictEqual(r1.body.refresh_token, t1.refresh_token);
  assert.strictEqual((await queue(r1.body.access_token)).status, 200);

  await sleep(1100); // past the 1 s race grace window
  const replay = await refresh(t1.refresh_token); // attacker replays the old token
  assert.strictEqual(replay.status, 400);
  assert.match(replay.body.error_description, /already used/);
  // The legitimate client's tokens from the same session are dead too.
  assert.strictEqual((await refresh(r1.body.refresh_token)).status, 400);
  const q = await queue(r1.body.access_token);
  assert.strictEqual(q.status, 401);
  assert.match(q.body.message, /Session has ended/);
});

test('two tabs refreshing with the same token at once both succeed (grace window)', async () => {
  const t = await login('nurse.ana');
  const [a, b] = await Promise.all([refresh(t.refresh_token), refresh(t.refresh_token)]);
  assert.deepStrictEqual([a.status, b.status], [200, 200]);
  // Both end up on the same (current) refresh token family member.
  assert.strictEqual(jwt.decode(a.body.refresh_token).jti, jwt.decode(b.body.refresh_token).jti);
  assert.strictEqual((await refresh(b.body.refresh_token)).status, 200);
});

test('POST /oauth/logout ends the session: access and refresh tokens stop working', async () => {
  const t = await login('nurse.ana');
  assert.strictEqual((await call('POST', '/oauth/logout', { token: t.access_token })).status, 204);
  assert.strictEqual((await queue(t.access_token)).status, 401);
  assert.strictEqual((await refresh(t.refresh_token)).status, 400);
  assert.strictEqual((await call('POST', '/oauth/logout')).status, 401);
});

test('POST /oauth/revoke (RFC 7009): access token -> deny-list, refresh token -> session', async () => {
  const t = await login('nurse.ana');
  assert.strictEqual((await call('POST', '/oauth/revoke', { body: { token: t.access_token, token_type_hint: 'access_token' } })).status, 200);
  assert.strictEqual((await queue(t.access_token)).status, 401);
  assert.strictEqual((await refresh(t.refresh_token)).status, 200, 'revoking one access token keeps the session');

  const t2 = await login('nurse.ana');
  assert.strictEqual((await call('POST', '/oauth/revoke', { body: { token: t2.refresh_token } })).status, 200);
  assert.strictEqual((await refresh(t2.refresh_token)).status, 400);
  assert.strictEqual((await queue(t2.access_token)).status, 401, 'session revocation also kills its access tokens');

  // Garbage tokens get the same 200 (no token probing); a missing token is a 400.
  assert.strictEqual((await call('POST', '/oauth/revoke', { body: { token: 'not-a-jwt' } })).status, 200);
  assert.strictEqual((await call('POST', '/oauth/revoke', { body: {} })).status, 400);
  assert.strictEqual((await call('POST', '/oauth/revoke', { body: { token: 'x', token_type_hint: 'id_token' } })).body.error, 'unsupported_token_type');
});

test('admin can sign a user out everywhere and see key rotation status', async () => {
  const admin = (await login('admin.harold')).access_token;
  const nurse = await login('nurse.ana');
  const nurseId = jwt.decode(nurse.access_token).sub;
  assert.strictEqual((await call('POST', `/api/admin/users/${nurseId}/revoke-sessions`, { token: nurse.access_token })).status, 403);

  await sleep(1000); // revocation is per second: keep the admin's own token clearly older/newer than the cut-off
  const r = await call('POST', `/api/admin/users/${nurseId}/revoke-sessions`, { token: admin });
  assert.strictEqual(r.status, 200);
  assert.ok(r.body.sessionsRevoked >= 1);
  assert.strictEqual((await queue(nurse.access_token)).status, 401);
  assert.strictEqual((await refresh(nurse.refresh_token)).status, 400);
  await sleep(1000);
  assert.strictEqual((await queue((await login('nurse.ana')).access_token)).status, 200, 'signing in again works');
  assert.strictEqual((await call('POST', '/api/admin/users/U-NOPE/revoke-sessions', { token: admin })).status, 404);

  const s = await call('GET', '/api/admin/security', { token: admin });
  assert.strictEqual(s.status, 200);
  assert.strictEqual(s.body.jwt.access.activeKid, 'k2');
  assert.deepStrictEqual(s.body.jwt.access.verifyOnlyKids, ['k1']);
  assert.strictEqual(s.body.jwt.rotation.nextRotationDue, '2026-04-01T00:00:00.000Z');
  assert.strictEqual(JSON.stringify(s.body).includes('secret'), false, 'no key material in the response');
});

test('token store survives a restart when persisted to a file', () => {
  const file = path.join(tmp, 'store.json');
  const exp = Math.floor(Date.now() / 1000) + 600;
  const a = new TokenStore(file);
  a.denyJti('jti-1', exp);
  a.createSession({ sid: 's1', userId: 'U1', jti: 'r1', exp });
  a.revokeSession('s1', 'logout');
  a.denyJti('jti-old', Math.floor(Date.now() / 1000) - 10); // already expired: pruned
  const b = new TokenStore(file);
  assert.strictEqual(b.isDenied('jti-1'), true);
  assert.strictEqual(b.isDenied('jti-old'), false);
  assert.strictEqual(b.getSession('s1').reason, 'logout');
  assert.strictEqual((fs.statSync(file).mode & 0o777).toString(8), '600');
});

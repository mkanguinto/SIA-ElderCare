'use strict';

const test = require('node:test');
const assert = require('node:assert');
const R = require('../src/auth/accountRules');

test('activation codes: readable alphabet, XXXX-XXXX, typed in any case or spacing', () => {
  const c = R.newActivationCode();
  assert.match(c, /^[A-HJ-KM-NP-Z2-9]{4}-[A-HJ-KM-NP-Z2-9]{4}$/);
  assert.strictEqual(R.hashSecret(c, 'k', 'activation'), R.hashSecret(c.toLowerCase().replace('-', ' '), 'k', 'activation'));
  assert.notStrictEqual(R.hashSecret(c, 'k', 'activation'), R.hashSecret(c, 'other-key', 'activation'));
});

test('code state: expired after its time, single use, replaced, locked after 5 tries', () => {
  const now = new Date('2026-10-23T08:00:00Z');
  const t = { expiresAt: new Date(now.getTime() + 24 * 3600000), attempts: 0 };
  assert.strictEqual(R.tokenState(t, now), 'ok');
  assert.strictEqual(R.tokenState(t, new Date(now.getTime() + 24 * 3600000 + 1)), 'expired');
  assert.strictEqual(R.tokenState({ ...t, usedAt: now }, now), 'used');
  assert.strictEqual(R.tokenState({ ...t, revokedAt: now }, now), 'replaced');
  assert.strictEqual(R.tokenState({ ...t, attempts: 5 }, now), 'locked');
  assert.strictEqual(R.tokenState(null, now), 'missing');
  assert.strictEqual(R.TOKEN_TTL_MIN.activation, 24 * 60);
});

test('Philippine mobile numbers are normalised and masked', () => {
  assert.strictEqual(R.normalizePhone('0917 555 0102'), '+639175550102');
  assert.strictEqual(R.normalizePhone('639175550102'), '+639175550102');
  assert.strictEqual(R.normalizePhone('(02) 8123 4567'), null);
  assert.strictEqual(R.maskPhone('+639175550102'), '+63 9•• ••• 0102');
});

test('password policy', () => {
  assert.deepStrictEqual(R.passwordProblems('Kalamansi2026', { username: 'caregiver.liza', name: 'Liza Ramos' }), []);
  assert.ok(R.passwordProblems('short1').length);
  assert.ok(R.passwordProblems('onlyletterslong').some((e) => e.includes('letters and numbers')));
  assert.ok(R.passwordProblems('Ramos20262026', { name: 'Liza Ramos' }).some((e) => e.includes('name')));
  assert.ok(R.passwordProblems('ElderCare2026').some((e) => e.includes('easy')));
});

test('new accounts: validated, family not linked directly, ids per role', () => {
  const ok = R.validateNewAccount({ username: 'Caregiver.Liza', name: 'Liza Ramos', role: 'caregiver', phone: '09175550199', patients: ['P-1003'] });
  assert.strictEqual(ok.ok, true);
  assert.strictEqual(ok.value.username, 'caregiver.liza');
  assert.deepStrictEqual(ok.value.scopes, ['checkins:write', 'patients:read']);
  assert.ok(R.validateNewAccount({ username: 'x', name: '', role: 'boss', phone: '123' }).errors.length >= 4);
  assert.ok(R.validateNewAccount({ username: 'family.ana', name: 'Ana', role: 'family_member', phone: '09175550111', patients: ['P-1001'] })
    .errors.some((e) => e.includes('family verification')));
  assert.ok(R.validateNewAccount({ username: 'nurse.x', name: 'X', role: 'clinic_staff', phone: '09175550111', patients: ['P-1001'] }).ok === false);
  assert.strictEqual(R.nextAccountId('clinic_staff', ['U-CS-001', 'U-CS-003', 'U-CG-009']), 'U-CS-004');
  assert.strictEqual(R.nextAccountId('family_member', []), 'U-FM-001');
});

test('session policy: one session, nurses one per device class; idle limits', () => {
  const active = [{ sid: 'a', deviceClass: 'phone' }, { sid: 'b', deviceClass: 'desktop' }];
  assert.deepStrictEqual(R.sessionsToReplace('caregiver', 'phone', active), ['a', 'b']);
  assert.deepStrictEqual(R.sessionsToReplace('system_admin', 'desktop', active), ['a', 'b']);
  assert.deepStrictEqual(R.sessionsToReplace('clinic_staff', 'phone', active), ['a']);
  assert.deepStrictEqual(R.sessionsToReplace('clinic_staff', 'desktop', active), ['b']);
  assert.strictEqual(R.deviceClass(undefined, 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0)'), 'phone');
  assert.strictEqual(R.deviceClass(undefined, 'Mozilla/5.0 (Macintosh; Intel Mac OS X 14_0)'), 'desktop');
  assert.strictEqual(R.deviceClass('desktop', 'Android'), 'desktop');
  assert.strictEqual(R.idleLimitMinutes('clinic_staff', {}), 15);
  assert.strictEqual(R.idleLimitMinutes('caregiver', {}), 30);
});

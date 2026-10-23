'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { ORDER, plan, validateNote } = require('../src/reviewStatus');
const { validateCheckin } = require('../src/validation');

test('review moves received / awaiting_review to reviewed', () => {
  assert.deepStrictEqual(plan('awaiting_review', 'review'), { ok: true, steps: ['reviewed'] });
  assert.deepStrictEqual(plan('received', 'review'), { ok: true, steps: ['reviewed'] });
});

test('a check-in cannot be reviewed twice', () => {
  assert.strictEqual(plan('reviewed', 'review').ok, false);
  assert.strictEqual(plan('action_recorded', 'review').ok, false);
});

test('recording an action logs the skipped review step', () => {
  assert.deepStrictEqual(plan('awaiting_review', 'action').steps, ['reviewed', 'action_recorded']);
  assert.deepStrictEqual(plan('reviewed', 'action').steps, ['action_recorded']);
  assert.deepStrictEqual(plan('action_recorded', 'action').steps, ['action_recorded']); // follow-up action
});

test('action text is required, notes are optional and bounded', () => {
  assert.ok(validateNote(undefined, { required: true }));
  assert.strictEqual(validateNote('Called the caregiver', { required: true }), null);
  assert.strictEqual(validateNote(undefined), null);
  assert.ok(validateNote('x'.repeat(501)));
});

test('measurement devices are validated', () => {
  const ok = validateCheckin({ patientId: 'P-1001', vitals: { systolic: 130, diastolic: 85 }, measurementDevice: { bp: 'upper_arm_digital', thermometer: 'digital_oral' } });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.value.measurementDevice, { bp: 'upper_arm_digital', thermometer: 'digital_oral' });
  const bad = validateCheckin({ patientId: 'P-1001', vitals: { systolic: 130, diastolic: 85 }, measurementDevice: { bp: 'phone_camera', scale: 'x' } });
  assert.strictEqual(bad.ok, false);
  assert.ok(bad.errors.some((e) => e.startsWith('measurementDevice.bp must be one of')));
  assert.ok(bad.errors.some((e) => e.includes('measurementDevice.scale is not a known device type')));
});

test('status transitions only move forward (immutable history)', () => {
  // Every step plan() returns is later than the current status; nothing can go back to an earlier one.
  for (const from of ORDER) {
    for (const op of ['review', 'action']) {
      const r = plan(from, op);
      if (r.ok) for (const s of r.steps) assert.ok(ORDER.indexOf(s) >= ORDER.indexOf(from), `${op} from ${from} went back to ${s}`);
    }
  }
  assert.strictEqual(plan('action_recorded', 'review').ok, false);
});

test('a missing vital is a reason, never zero', () => {
  const ok = validateCheckin({ patientId: 'P-1001', vitals: { heartRate: 72 }, vitalsMissing: { bp: 'no_device', spo2: 'not_measured', bloodGlucose: 'unknown' } });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.value.vitalsMissing, { bp: 'no_device', spo2: 'not_measured', bloodGlucose: 'unknown' });
  const zero = validateCheckin({ patientId: 'P-1001', vitals: { spo2: 0 } });
  assert.ok(zero.errors.some((e) => e.includes('vitals.spo2 cannot be 0')));
  const both = validateCheckin({ patientId: 'P-1001', vitals: { systolic: 130, diastolic: 85 }, vitalsMissing: { bp: 'unknown', weight: 'unknown', spo2: 'broken' } });
  assert.ok(both.errors.includes('vitalsMissing.bp cannot be given together with a value'));
  assert.ok(both.errors.some((e) => e.startsWith('vitalsMissing.weight is not a vital sign')));
  assert.ok(both.errors.some((e) => e.startsWith('vitalsMissing.spo2 must be one of')));
  // "All readings missing, with reasons" is still a valid check-in.
  assert.strictEqual(validateCheckin({ patientId: 'P-1001', vitalsMissing: { bp: 'no_device' } }).ok, true);
});

test('demo / test records are identified only by an explicit marker', () => {
  const { isTestRecordKey } = require('../src/validation');
  for (const k of ['pm-status-1', 'offline-1792677485146', 'sms-smoke1792676313565', 'sms-pm1792677204215951', 'env-test-0001']) assert.ok(isTestRecordKey(k), k);
  for (const k of ['pwa-0b7c1c9e-1', 'sms-1792677485146', 'mobile-pm-1', null, undefined]) assert.ok(!isTestRecordKey(k), String(k));
  assert.strictEqual(validateCheckin({ patientId: 'P-1001', vitals: { heartRate: 70 } }).value.dataOrigin, 'live');
  assert.strictEqual(validateCheckin({ patientId: 'P-1001', vitals: { heartRate: 70 }, dataOrigin: 'demo' }).value.dataOrigin, 'demo');
  assert.ok(validateCheckin({ patientId: 'P-1001', vitals: { heartRate: 70 }, dataOrigin: 'old' }).errors.includes('dataOrigin must be live or demo'));
});

'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { plan, validateNote } = require('../src/reviewStatus');
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

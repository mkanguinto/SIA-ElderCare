'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validatePatient, validateMedication, validateStop } = require('../src/patientValidation');

const now = new Date('2026-10-14T00:00:00Z');
const valid = {
  fullName: 'Lolo Andres Bautista',
  birthDate: '1944-05-20',
  sex: 'M',
  addressLine: '123 Rizal St., Brgy. 105, Tondo, Manila',
  zipCode: '1012',
  conditions: ['Hypertension', 'heart disease'],
  mobilityRestricted: true,
  baseline: { systolic: 130, diastolic: 82, heartRate: 74 },
  emergencyContact: { name: 'Ana Bautista', phone: '0917 123 4567', relation: 'daughter' },
  medications: [{ name: 'Amlodipine', dosage: '5 mg', frequency: 'Once daily', times: ['08:00'], source: { type: 'physician_order', prescriber: 'Dr. L. Reyes' } }],
};

test('accepts a complete onboarding payload and normalises it', () => {
  const r = validatePatient(valid, now);
  assert.ok(r.ok, JSON.stringify(r.errors));
  assert.deepStrictEqual(r.value.conditions, ['hypertension', 'heart_disease']);
  assert.strictEqual(r.value.countryCode, 'PH');
  assert.strictEqual(r.value.emergencyContact.phone, '09171234567');
  assert.strictEqual(r.value.medications.length, 1);
});

test('rejects missing required fields, bad dates and out-of-range baseline', () => {
  const r = validatePatient({ fullName: 'Al', birthDate: '2030-02-30', zipCode: '!', baseline: { systolic: 999 } }, now);
  assert.strictEqual(r.ok, false);
  for (const field of ['fullName', 'birthDate', 'addressLine', 'zipCode', 'baseline.systolic']) {
    assert.ok(r.errors.some((e) => e.includes(field)), `expected error for ${field}: ${r.errors.join(' | ')}`);
  }
});

test('rejects patients younger than 18 and invalid medication rows', () => {
  const r = validatePatient({ ...valid, birthDate: '2015-01-01', medications: [{ name: 'X', times: ['25:00'] }] }, now);
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('between 18 and 125')));
  assert.ok(r.errors.some((e) => e.includes('medications[0].name')));
  assert.ok(r.errors.some((e) => e.includes('medications[0].times')));
});

test('a prescription is recorded from its source; nothing is filled in for the nurse', () => {
  const today = '2026-10-25';
  const src = { type: 'physician_order', prescriber: 'Dr. L. Reyes', facility: 'RHU-MNL-01', date: '2026-10-20' };
  const noSource = validateMedication({ name: 'Losartan', strength: '50 mg tablet', frequency: 'once a day' });
  assert.strictEqual(noSource.ok, false);
  assert.match(noSource.errors.join(), /source is required/);
  const ok = validateMedication({ name: 'Losartan', strength: '50 mg tablet', dose: '1 tablet', route: 'oral', frequency: 'once a day', times: ['20:00'],
    foodInstructions: 'after dinner', source: src, verification: { method: 'written_order', verifiedOn: today } }, '', { today });
  assert.strictEqual(ok.ok, true, ok.errors && ok.errors.join());
  assert.strictEqual(ok.value.dosage, '50 mg tablet, 1 tablet');
  assert.strictEqual(ok.value.prescribedBy, 'Dr. L. Reyes');
  assert.strictEqual(validateMedication({ name: 'Losartan', strength: '50 mg', frequency: 'daily', source: src }).value.times, undefined, 'no default time');
  const bad = validateMedication({ name: 'Losartan', strength: '50 mg', frequency: 'daily', route: 'by mouth', source: { type: 'friend', prescriber: 'x' },
    startDate: '2026-10-10', endDate: '2026-10-01', active: false }, '', { today });
  const msg = bad.errors.join(' | ');
  for (const part of ['route must be one of', 'source.type must be one of', 'source.prescriber is required', 'endDate cannot be before startDate', 'unknown field(s): active']) assert.ok(msg.includes(part), `${part} in ${msg}`);
  assert.match(validateMedication({ name: 'X1', strength: '1 mg', frequency: 'daily', source: { ...src, type: 'prescription_document' } }).errors.join(), /reference is required/);
  assert.match(validateMedication({ name: 'X1', strength: '1 mg', frequency: 'daily', source: { ...src, date: '2026-10-26' } }, '', { today }).errors.join(), /cannot be in the future/);
});

test('missed-dose instructions need their own clinical source; stopping needs the reason and the order', () => {
  const src = { type: 'physician_order', prescriber: 'Dr. L. Reyes' };
  const m = { name: 'Metformin', strength: '500 mg', frequency: 'twice a day', source: src, missedDoseInstructions: 'If more than 4 hours late, skip that dose.' };
  assert.match(validateMedication(m).errors.join(), /missedDoseSource is required/);
  assert.strictEqual(validateMedication({ ...m, missedDoseSource: src }).ok, true);
  assert.match(validateMedication({ name: 'Metformin', strength: '500 mg', frequency: 'twice a day', source: src, missedDoseSource: src }).errors.join(), /only given with missedDoseInstructions/);
  assert.strictEqual(validateStop({ reason: 'Stopped by the doctor', source: src }).ok, true);
  assert.match(validateStop({ reason: 'x' }).errors.join(), /reason is required.*source is required/);
});

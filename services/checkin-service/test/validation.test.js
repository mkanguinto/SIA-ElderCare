'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateCheckin } = require('../src/validation');

const base = { patientId: 'P-1001', vitals: { systolic: 130, diastolic: 85 } };

test('rejects impossible vitals (negative, above the range)', () => {
  const r = validateCheckin({ patientId: 'P-1001', vitals: { systolic: -120, diastolic: 1200 } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.some((e) => e.includes('vitals.systolic must be between 50 and 300')));
  assert.ok(r.errors.some((e) => e.includes('vitals.diastolic must be between 30 and 200')));
});

test('environment is optional and stored rounded', () => {
  const none = validateCheckin(base);
  assert.strictEqual(none.ok, true);
  assert.strictEqual(none.value.environment, null);

  const r = validateCheckin({ ...base, environment: { outsideTempC: 31.54, heatIndexC: 37.08, humidity: 64, locationName: ' Manila ', source: 'device_location' } });
  assert.strictEqual(r.ok, true);
  assert.deepStrictEqual(r.value.environment, { outsideTempC: 31.5, heatIndexC: 37.1, humidity: 64, locationName: 'Manila', source: 'device_location' });
});

test('environment values are range-checked', () => {
  const r = validateCheckin({ ...base, environment: { outsideTempC: 99, humidity: -1, source: 'satellite', locationName: 'x'.repeat(81) } });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.includes('environment.outsideTempC must be between -30 and 60'));
  assert.ok(r.errors.includes('environment.humidity must be between 0 and 100'));
  assert.ok(r.errors.some((e) => e.startsWith('environment.source must be one of')));
  assert.ok(r.errors.some((e) => e.startsWith('environment.locationName')));
});

test('environment must be an object', () => {
  const r = validateCheckin({ ...base, environment: [1, 2] });
  assert.strictEqual(r.ok, false);
  assert.ok(r.errors.includes('environment must be an object'));
});

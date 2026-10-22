'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateRule, toRuleDto, evaluateRule, matchesTarget } = require('../src/alertRules');
const { parsePagination, pageInfo } = require('../src/lib/pagination');

const heatRule = {
  code: 'HEAT_TEST',
  hazard: 'heat',
  trigger_condition: { metric: 'heat_index_c', operator: '>', value: 40 },
  vulnerability_target: { conditions: ['hypertension', 'copd'] },
  action: { severity: 'high', channels: ['sms', 'in_app'], create_clinic_item: true, cooldown_hours: 24 },
};
const stormRule = {
  code: 'STORM_TEST',
  hazard: 'storm',
  trigger_condition: { metric: 'wind_ms', operator: '>=', value: 17.2, include_advisories: true },
  vulnerability_target: { mobility_restricted: true },
  action: { severity: 'high' },
};

test('a complete weather rule validates', () => {
  const { errors, value } = validateRule({ ...heatRule, description: 'Heat index above 40 C' });
  assert.deepStrictEqual(errors, []);
  assert.strictEqual(value.code, 'HEAT_TEST');
  assert.deepStrictEqual(value.action.channels, ['sms', 'in_app']);
});

test('create rejects bad codes, reserved codes, unknown fields and bad triggers', () => {
  const bad = validateRule({ code: 'x', description: 'no', hazard: 'flood', trigger_condition: { metric: 'rain', operator: '=', value: 'hot' }, vulnerability_target: { conditions: ['Hypertension!'] }, action: { channels: [] }, extra: 1 });
  const msg = bad.errors.join(' | ');
  for (const part of ['unknown field(s): extra', 'code must be', 'description must be', 'hazard must be', 'metric must be', 'operator must be', 'value must be', 'conditions must be', 'channels must be']) {
    assert.ok(msg.includes(part), `missing "${part}" in ${msg}`);
  }
  assert.match(validateRule({ ...heatRule, code: 'MANUAL', description: 'reserved code' }).errors.join(), /reserved system rule/);
});

test('PATCH: partial update merges action, cannot rename, system rules only change enabled/description/action', () => {
  const existing = { code: 'WEATHER_HEAT', action: { severity: 'high', create_clinic_item: true, cooldown_hours: 24 } };
  const r = validateRule({ action: { cooldown_hours: 12 } }, { partial: true, existing });
  assert.deepStrictEqual(r.errors, []);
  assert.deepStrictEqual(r.value.action, { severity: 'high', create_clinic_item: true, cooldown_hours: 12 });
  assert.match(validateRule({ code: 'NEW' }, { partial: true, existing }).errors.join(), /cannot be changed/);
  assert.match(validateRule({}, { partial: true, existing }).errors.join(), /nothing to update/);
  const sys = { code: 'HEALTH_ANOMALY', action: {} };
  assert.deepStrictEqual(validateRule({ enabled: false }, { partial: true, existing: sys }).errors, []);
  assert.match(validateRule({ trigger_condition: heatRule.trigger_condition }, { partial: true, existing: sys }).errors.join(), /system rules/);
});

test('DTO merges channels / min_severity columns into action', () => {
  const dto = toRuleDto({ code: 'MANUAL', description: 'd', enabled: true, hazard: null, trigger_condition: null, vulnerability_target: null, action: {}, channels: ['in_app'], min_severity: 'low' });
  assert.strictEqual(dto.type, 'system');
  assert.deepStrictEqual(dto.action, { channels: ['in_app'], min_severity: 'low' });
});

test('trigger evaluation: thresholds, operators and storm advisories', () => {
  assert.strictEqual(evaluateRule(heatRule, { heatIndexC: 41 }).triggered, true);
  assert.strictEqual(evaluateRule(heatRule, { heatIndexC: 40 }).triggered, false, '> is strict');
  assert.strictEqual(evaluateRule(heatRule, { heatIndexC: null }).triggered, false);
  assert.strictEqual(evaluateRule(stormRule, { windMs: 17.2 }).triggered, true, '>= includes the threshold');
  const advisory = evaluateRule(stormRule, { windMs: 3, alerts: [{ event: 'Tropical Storm Warning Signal No. 2' }] });
  assert.strictEqual(advisory.triggered, true);
  assert.match(advisory.reasons[0], /official advisory/);
  assert.strictEqual(evaluateRule({ ...stormRule, trigger_condition: { ...stormRule.trigger_condition, include_advisories: false } }, { windMs: 3, alerts: [{ event: 'Typhoon' }] }).triggered, false);
});

test('vulnerability target: any listed condition, optional mobility filter, empty = everyone', () => {
  assert.strictEqual(matchesTarget(heatRule, { conditions: ['COPD'] }), true);
  assert.strictEqual(matchesTarget(heatRule, { conditions: ['arthritis'] }), false);
  assert.strictEqual(matchesTarget(stormRule, { mobilityRestricted: true }), true);
  assert.strictEqual(matchesTarget(stormRule, { mobilityRestricted: false }), false);
  assert.strictEqual(matchesTarget({ vulnerability_target: {} }, { conditions: [] }), true);
});

test('pagination: defaults, legacy limit, strict page/pageSize, envelope', () => {
  assert.deepStrictEqual(parsePagination({}), { page: 1, pageSize: 50, offset: 0, errors: [] });
  assert.deepStrictEqual(parsePagination({ page: '3', pageSize: '20' }), { page: 3, pageSize: 20, offset: 40, errors: [] });
  assert.strictEqual(parsePagination({ limit: '9999' }).pageSize, 200, 'legacy limit is clamped, not rejected');
  assert.strictEqual(parsePagination({ page: '0' }).errors.length, 1);
  assert.strictEqual(parsePagination({ pageSize: '201' }).errors.length, 1);
  assert.strictEqual(parsePagination({ page: '2abc' }).errors.length, 1);
  assert.deepStrictEqual(pageInfo({ page: 2, pageSize: 20 }, 45), { page: 2, pageSize: 20, totalItems: 45, totalPages: 3, hasNext: true, hasPrev: true });
  assert.deepStrictEqual(pageInfo({ page: 1, pageSize: 20 }, 0), { page: 1, pageSize: 20, totalItems: 0, totalPages: 1, hasNext: false, hasPrev: false });
});

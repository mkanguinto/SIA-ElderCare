'use strict';

const test = require('node:test');
const assert = require('node:assert');
const fs = require('fs');
const path = require('path');
const ec = require('../src/eldercare');

const received = (message, extra = {}) => ({ webhookEvent: 'MESSAGE_RECEIVED', sender: '+639175550101', message, smsId: 'sms-12345', ...extra });
const route = (message) => ec.classifyTextbeeEvent(received(message)).route;

test('content-based router: inbound SMS keywords', () => {
  assert.strictEqual(route('CHECKIN P-1001 BP 150/90 HR 80 MED Y'), 'checkin');
  assert.strictEqual(route('check-in bp 120/80'), 'checkin');
  assert.strictEqual(route('BP 150/90 HR 80'), 'checkin', 'bare vitals count as a check-in');
  assert.strictEqual(route('SOS nahulog si lola'), 'emergency');
  assert.strictEqual(route('emergency'), 'emergency');
  assert.strictEqual(route('Saklolo'), 'emergency');
  assert.strictEqual(route('STOP'), 'opt_out');
  assert.strictEqual(route(' unsubscribe '), 'opt_out');
  assert.strictEqual(route('START'), 'opt_in');
  assert.strictEqual(route('help'), 'help');
  assert.strictEqual(route('TULONG'), 'help', 'TULONG alone asks for the format, like the v1 parser');
  assert.strictEqual(route('?'), 'help');
  assert.strictEqual(route('hello po'), 'unknown');
  assert.strictEqual(route(''), 'unknown');
  assert.strictEqual(route('stop sending me the BP 120/80 reminders'), 'checkin', 'STOP only counts as a whole message');
});

test('content-based router: SOS wins over a check-in in the same text', () => {
  assert.strictEqual(route('SOS BP 200/120 chest pain'), 'emergency');
});

test('content-based router: delivery receipts and ignored events', () => {
  const c = ec.classifyTextbeeEvent({ webhookEvent: 'MESSAGE_FAILED', smsId: 'abc123', errorMessage: 'no signal' });
  assert.deepStrictEqual(c.status, { id: 'abc123', status: 'failed', error: 'no signal' });
  assert.strictEqual(c.route, 'delivery_status');
  assert.strictEqual(ec.classifyTextbeeEvent({ event: 'MESSAGE_DELIVERED', smsBatchId: 'b1' }).status.id, 'b1');
  assert.strictEqual(ec.classifyTextbeeEvent({ webhookEvent: 'MESSAGE_SENT' }).route, 'ignored');
  assert.strictEqual(ec.classifyTextbeeEvent({ webhookEvent: 'DEVICE_OFFLINE' }).route, 'ignored');
  assert.strictEqual(ec.classifyTextbeeEvent(received('SOS', { sender: '' })).route, 'ignored');
  assert.strictEqual(ec.classifyTextbeeEvent(null).route, 'ignored');
  assert.deepStrictEqual(ec.classifyTextbeeEvent(received('HELP')).sms, { from: '+639175550101', body: 'HELP', smsId: 'sms-12345', receivedAt: null });
});

test('weather aggregator: ok, partial, not configured', () => {
  const okPart = (zip, heat, warned) => ({
    zipCode: zip, status: 200,
    body: { summary: {}, results: [{ zipCode: zip, heatIndexC: heat, heat: { triggered: heat > 40 }, storm: { triggered: false },
      rules: [{ code: 'WEATHER_HEAT', triggered: heat > 40 }], actions: warned ? [{ sms: { suppressed: false }, clinic: { created: true } }] : [] }] },
  });
  const all = ec.summarizeWeatherRun([okPart('1012', 42, true), okPart('1000', 35, false)]);
  assert.strictEqual(all.status, 'ok');
  assert.deepStrictEqual(all.heatAreas, ['1012']);
  assert.deepStrictEqual(all.rulesFired, ['WEATHER_HEAT']);
  assert.strictEqual(all.patientsWarned, 1);
  assert.strictEqual(all.triageItemsCreated, 1);
  assert.deepStrictEqual(all.hottest, { zipCode: '1012', heatIndexC: 42 });
  const partial = ec.summarizeWeatherRun([okPart('1012', 30), { zipCode: '1000', status: 502, body: { error: 'bad_gateway' } }]);
  assert.strictEqual(partial.status, 'partial');
  assert.deepStrictEqual(partial.failed, [{ zipCode: '1000', status: 502, error: 'bad_gateway' }]);
  assert.strictEqual(ec.summarizeWeatherRun([{ zipCode: '1012', status: 503, body: { error: 'not_configured' } }]).status, 'not_configured');
  assert.strictEqual(ec.summarizeWeatherRun([]).status, 'ok');
});

test('DLQ monitor: dead letters, unreachable services', () => {
  const status = (service, dlq) => ({ service, status: 200, body: { mode: 'rabbitmq', connected: true, published: 3, deadLettered: dlq,
    queues: [{ queue: `${service}-service.events`, messages: 0, consumers: 1 }, { queue: `${service}-service.events.dlq`, messages: dlq, consumers: 0 }], outbox: { delivered: 9 } } });
  const healthy = ec.summarizeMessaging([status('checkin', 0), status('alert', 0), status('clinic', 0)]);
  assert.strictEqual(healthy.healthy, true);
  const sick = ec.summarizeMessaging([status('checkin', 0), status('alert', 2), { service: 'clinic', status: 'ECONNREFUSED', body: 'Error' }]);
  assert.strictEqual(sick.healthy, false);
  assert.strictEqual(sick.totalDeadLetters, 2);
  assert.deepStrictEqual(sick.deadLetters, [{ service: 'alert', queue: 'alert-service.events.dlq', messages: 2 }]);
  assert.strictEqual(sick.services[2].reachable, false);
  assert.strictEqual(sick.services[1].counters.deadLettered, 2);
});

test('replay validation accepts the DLQ or the work queue name', () => {
  assert.deepStrictEqual(ec.validateReplay({ service: 'alert', queue: 'alert-service.sms-dispatch.dlq' }), { errors: [], value: { service: 'alert', queue: 'alert-service.sms-dispatch', limit: 50 } });
  assert.strictEqual(ec.validateReplay({ service: 'alert', queue: 'alert-service.sms-dispatch', limit: 5 }).value.limit, 5);
  assert.strictEqual(ec.validateReplay({ service: 'gateway', queue: 'x;rm', limit: 0 }).errors.length, 3);
});

test('credential checks fail closed', () => {
  const basic = (u, p) => `Basic ${Buffer.from(`${u}:${p}`).toString('base64')}`;
  assert.strictEqual(ec.checkBasicAuth(basic('ops', 's3cret:x'), 'ops', 's3cret:x'), true, 'colons in the password are fine');
  assert.strictEqual(ec.checkBasicAuth(basic('ops', 'wrong'), 'ops', 's3cret'), false);
  assert.strictEqual(ec.checkBasicAuth(basic('ops', ''), 'ops', ''), false, 'no password configured = dashboard closed');
  assert.strictEqual(ec.checkBasicAuth('Bearer abc', 'ops', 's3cret'), false);
  assert.strictEqual(ec.checkInternalToken('tok', 'tok'), true);
  assert.strictEqual(ec.checkInternalToken('tok', ''), false);
  assert.strictEqual(ec.checkInternalToken(undefined, 'tok'), false);
});

test('flows.json is valid and fully wired', () => {
  const flows = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'flows.json'), 'utf8'));
  const ids = new Set(flows.map((n) => n.id));
  assert.strictEqual(ids.size, flows.length, 'unique node ids');
  for (const n of flows) {
    for (const out of n.wires || []) for (const w of out) assert.ok(ids.has(w), `${n.id} -> ${w}`);
    for (const l of n.links || []) assert.ok(ids.has(l), `${n.id} link -> ${l}`);
    if (n.type === 'function') assert.doesNotThrow(() => new Function('msg', 'node', 'global', 'flow', 'env', 'RED', n.func), `${n.name} compiles`);
  }
  const urls = flows.filter((n) => n.type === 'http in').map((n) => `${n.method} ${n.url}`);
  for (const u of ['post /webhooks/textbee', 'get /dlq', 'get /dlq/api/status', 'post /dlq/api/replay', 'get /health']) assert.ok(urls.includes(u), u);
});

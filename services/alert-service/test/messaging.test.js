'use strict';

// Message-oriented middleware semantics (Topic 12): routing, retry tiers, DLQ, replay, contracts.
// Runs against the in-process transport, which implements the same rules as the RabbitMQ topology.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const { createBus, topicMatches, classifyFailure } = require('../src/lib/messageBus');
const { validateEvent } = require('../src/lib/eventContracts');

const quiet = { info() {}, warn() {}, error() {}, debug() {} };
const FAST = [5, 10, 15];

function anomalyEvent(overrides = {}) {
  return {
    eventId: crypto.randomUUID(),
    type: 'checkin.anomaly_detected',
    occurredAt: new Date().toISOString(),
    source: 'checkin-service',
    patient: { id: 'P-1001', fullName: 'Lola Remedios' },
    checkin: { id: 42, recordedAt: new Date().toISOString(), vitals: { systolic: 186, diastolic: 118 } },
    anomalies: [{ code: 'BP_HIGH', level: 'high', message: 'Blood pressure very high' }],
    severity: 'high',
    severityScore: 70,
    ...overrides,
  };
}

test('topic bindings: * = one word, # = zero or more', () => {
  assert.ok(topicMatches('checkin.*', 'checkin.missed'));
  assert.ok(!topicMatches('checkin.*', 'checkin.missed.extra'));
  assert.ok(topicMatches('#', 'weather.risk_detected'));
  assert.ok(topicMatches('notification.#', 'notification.sms.requested'));
  assert.ok(!topicMatches('checkin.normal', 'checkin.missed'));
});

test('failure classification: permanent and bad contracts skip retries', () => {
  assert.deepStrictEqual(classifyFailure(new Error('timeout'), 1, 3), { action: 'retry', tier: 0 });
  assert.deepStrictEqual(classifyFailure(new Error('timeout'), 4, 3), { action: 'dlq', reason: 'max_retries_exceeded' });
  assert.strictEqual(classifyFailure(Object.assign(new Error('x'), { permanent: true }), 1, 3).reason, 'permanent_error');
  assert.strictEqual(classifyFailure(Object.assign(new Error('x'), { reason: 'ambiguous_delivery' }), 1, 3).reason, 'ambiguous_delivery');
});

test('publish/subscribe: one event fans out to every bound queue (pub-sub)', async () => {
  const bus = createBus({ url: 'memory://', serviceName: 't', logger: quiet });
  const got = { alert: [], clinic: [] };
  await bus.subscribe({ queue: 'alert-service.checkin-events', bindings: ['checkin.anomaly_detected', 'checkin.missed'], handler: async (e) => { got.alert.push(e.type); } });
  await bus.subscribe({ queue: 'clinic-risk-service.events', bindings: ['checkin.*', 'weather.risk_detected'], handler: async (e) => { got.clinic.push(e.type); } });
  await bus.publish('checkin.anomaly_detected', anomalyEvent());
  await bus.publish('checkin.normal', anomalyEvent({ type: 'checkin.normal', anomalies: [], severity: 'none', severityScore: 0 }));
  await bus.idle();
  assert.deepStrictEqual(got.alert, ['checkin.anomaly_detected']);
  assert.deepStrictEqual(got.clinic.sort(), ['checkin.anomaly_detected', 'checkin.normal']);
  await bus.close();
});

test('producer refuses an event that breaks its contract', async () => {
  const bus = createBus({ url: 'memory://', serviceName: 't', logger: quiet });
  await assert.rejects(bus.publish('checkin.anomaly_detected', anomalyEvent({ severity: 'terrible' })), /violates its contract/);
});

test('transient failures are retried through the retry tiers, then succeed', async () => {
  const bus = createBus({ url: 'memory://', serviceName: 't', logger: quiet });
  let calls = 0;
  await bus.subscribe({ queue: 'q.retry-test', bindings: ['checkin.*'], retryDelaysMs: FAST, handler: async (e, meta) => { calls += 1; if (meta.attempts < 3) throw new Error('db timeout'); } });
  await bus.publish('checkin.missed', anomalyEvent({ type: 'checkin.missed', checkin: undefined }));
  await bus.idle();
  assert.strictEqual(calls, 3);
  assert.strictEqual(bus.deadLetters('q.retry-test').length, 0);
  assert.strictEqual(bus.status().retried, 2);
});

test('poison messages go to the DLQ with the reason, and can be replayed', async () => {
  const bus = createBus({ url: 'memory://', serviceName: 't', logger: quiet });
  let fixed = false;
  let processed = 0;
  await bus.subscribe({
    queue: 'q.dlq-test', bindings: ['checkin.*'], retryDelaysMs: FAST,
    handler: async () => { if (!fixed) throw new Error('downstream still broken'); processed += 1; },
  });
  await bus.publish('checkin.anomaly_detected', anomalyEvent());
  await bus.idle();
  const [dead] = bus.deadLetters('q.dlq-test');
  assert.strictEqual(dead.headers['x-death-reason'], 'max_retries_exceeded');
  assert.strictEqual(dead.headers['x-attempts'], 4);
  assert.strictEqual(dead.headers['x-original-routing-key'], 'checkin.anomaly_detected');
  assert.match(dead.headers['x-error'], /still broken/);

  fixed = true; // operator fixes the cause, then replays
  assert.deepStrictEqual(await bus.replayDlq('q.dlq-test'), { replayed: 1 });
  await bus.idle();
  assert.strictEqual(processed, 1);
  assert.strictEqual(bus.deadLetters('q.dlq-test').length, 0);
});

test('a permanent error is dead-lettered immediately (no retry storm)', async () => {
  const bus = createBus({ url: 'memory://', serviceName: 't', logger: quiet });
  let calls = 0;
  await bus.subscribe({ queue: 'q.perm', bindings: ['checkin.*'], retryDelaysMs: FAST, handler: async () => { calls += 1; throw Object.assign(new Error('unknown patient'), { permanent: true }); } });
  await bus.publish('checkin.anomaly_detected', anomalyEvent());
  await bus.idle();
  assert.strictEqual(calls, 1);
  assert.strictEqual(bus.deadLetters('q.perm')[0].headers['x-death-reason'], 'permanent_error');
});

test('contracts: the SMS dispatch event from the evaluation validates, a bad phone does not', () => {
  const sms = {
    eventId: crypto.randomUUID(),
    type: 'notification.sms.requested',
    occurredAt: '2026-09-02T12:20:00Z',
    source: 'alert-service',
    notificationId: crypto.randomUUID(),
    alertId: crypto.randomUUID(),
    recipientPhone: '+639170000000',
    timestamp: '2026-09-02T12:20:00Z',
    alertType: 'HEATWAVE_DEHYDRATION_WARNING',
    severity: 'high',
    message: '[ElderCare Connect] HEAT WARNING ...',
    payload: { patientId: 'p_1029', heatIndex: 41.5 },
  };
  assert.deepStrictEqual(validateEvent(sms).errors, []);
  const bad = validateEvent({ ...sms, recipientPhone: '09170000000' });
  assert.strictEqual(bad.valid, false);
  assert.match(bad.errors.join(), /recipientPhone/);
  assert.strictEqual(validateEvent({ type: 'nope' }).known, false);
});

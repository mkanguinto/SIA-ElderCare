'use strict';

// TextBee SMS worker idempotency (professor's evaluation: "idempotent consumer logic to prevent duplicate
// notifications during carrier timeouts"). The DB and the TextBee sender are replaced by in-memory fakes.
const test = require('node:test');
const assert = require('node:assert');
const path = require('path');
const crypto = require('crypto');

/* ---------- fake notification_log ---------- */
const rows = new Map();
const fakePool = {
  async query(sql, params) {
    if (/SET status = 'sending'/.test(sql)) {
      const r = rows.get(params[0]);
      if (r && params[2].includes(r.status)) { r.status = 'sending'; r.attempts = params[1]; return { rowCount: 1, rows: [] }; }
      return { rowCount: 0, rows: [] };
    }
    if (/^SELECT status FROM notification_log/.test(sql)) {
      const r = rows.get(params[0]);
      return { rows: r ? [{ status: r.status }] : [] };
    }
    if (/count\(\*\).* AS n/s.test(sql)) return { rows: [{ n: 0 }] }; // sentToday (alert + account SMS)
    if (/^UPDATE notification_log SET/.test(sql)) {
      const keys = [...sql.matchAll(/(\w+) = \$(\d+)/g)].filter(([, k]) => k !== 'id');
      const r = rows.get(params[0]);
      for (const [, k, i] of keys) r[k] = params[Number(i) - 1];
      return { rowCount: 1, rows: [] };
    }
    throw new Error(`unexpected SQL in test: ${sql}`);
  },
};

/* ---------- fake TextBee sender ---------- */
const sent = [];
let nextFailure = null;
const fakeSender = {
  mode: () => ({ live: true, provider: 'textbee' }),
  sendSms: async ({ to, body }) => {
    if (nextFailure) { const f = nextFailure; nextFailure = null; throw f; }
    sent.push({ to, body });
    return { sid: `batch-${sent.length}`, status: 'sent', provider: 'textbee' };
  },
};

require.cache[path.resolve(__dirname, '../src/db/index.js')] = { id: 'db', filename: 'db', loaded: true, exports: { pool: fakePool } };
require.cache[path.resolve(__dirname, '../src/smsSender.js')] = { id: 'sms', filename: 'sms', loaded: true, exports: fakeSender };
process.env.SMS_MIN_INTERVAL_MS = '0';
const { handleSmsRequested, RETRY_DELAYS } = require('../src/smsWorker');

function newNotification() {
  const id = crypto.randomUUID();
  rows.set(id, { status: 'queued' });
  return {
    eventId: crypto.randomUUID(), type: 'notification.sms.requested', notificationId: id, alertId: crypto.randomUUID(),
    recipientPhone: '+639170000000', alertType: 'HEATWAVE_DEHYDRATION_WARNING', severity: 'high', message: 'HEAT WARNING', payload: { patientId: 'P-1001' },
  };
}

test('a redelivered message for an already-sent SMS is acknowledged without sending again', async () => {
  const evt = newNotification();
  const before = sent.length;
  assert.deepStrictEqual(await handleSmsRequested(evt, { attempts: 1, headers: {} }), { sent: true, simulated: false });
  assert.deepStrictEqual(await handleSmsRequested(evt, { attempts: 1, headers: {} }), { duplicate: true });
  assert.strictEqual(sent.length - before, 1);
  assert.strictEqual(rows.get(evt.notificationId).status, 'sent');
});

test('transient TextBee error releases the claim so the retry can send exactly once', async () => {
  const evt = newNotification();
  nextFailure = Object.assign(new Error('TextBee 503'), { permanent: false });
  await assert.rejects(handleSmsRequested(evt, { attempts: 1, headers: {} }), /503/);
  assert.strictEqual(rows.get(evt.notificationId).status, 'queued');
  const before = sent.length;
  await handleSmsRequested(evt, { attempts: 2, headers: {} });
  assert.strictEqual(sent.length - before, 1);
  assert.strictEqual(rows.get(evt.notificationId).status, 'sent');
});

test('carrier/TextBee timeout is ambiguous: parked as unconfirmed for review, never auto-resent', async () => {
  const evt = newNotification();
  nextFailure = Object.assign(new Error('TextBee ECONNABORTED'), { ambiguous: true });
  await assert.rejects(handleSmsRequested(evt, { attempts: 1, headers: {} }), (e) => e.reason === 'ambiguous_delivery');
  assert.strictEqual(rows.get(evt.notificationId).status, 'unconfirmed');
  // a later redelivery of the same message must not send it
  assert.deepStrictEqual(await handleSmsRequested(evt, { attempts: 1, headers: {} }), { duplicate: true });
});

test('a worker that died mid-send leaves "sending": the redelivery goes to the DLQ instead of resending', async () => {
  const evt = newNotification();
  rows.get(evt.notificationId).status = 'sending';
  await assert.rejects(handleSmsRequested(evt, { attempts: 1, headers: {} }), (e) => e.reason === 'ambiguous_delivery');
  assert.strictEqual(rows.get(evt.notificationId).status, 'unconfirmed');
});

test('an operator DLQ replay may resend an unconfirmed SMS once', async () => {
  const evt = newNotification();
  rows.get(evt.notificationId).status = 'unconfirmed';
  const before = sent.length;
  await handleSmsRequested(evt, { attempts: 1, headers: { 'x-replayed-at': new Date().toISOString() } });
  await handleSmsRequested(evt, { attempts: 1, headers: { 'x-replayed-at': new Date().toISOString() } });
  assert.strictEqual(sent.length - before, 1);
});

test('permanent error (bad number / bad API key) marks failed and is not retried', async () => {
  const evt = newNotification();
  nextFailure = Object.assign(new Error('TextBee 401'), { permanent: true });
  await assert.rejects(handleSmsRequested(evt, { attempts: 1, headers: {} }), (e) => e.permanent === true);
  assert.strictEqual(rows.get(evt.notificationId).status, 'failed');
});

test('last retry tier exhausted -> failed (the in-app alert stays as the fallback channel)', async () => {
  const evt = newNotification();
  nextFailure = new Error('TextBee 500');
  await assert.rejects(handleSmsRequested(evt, { attempts: RETRY_DELAYS.length + 1, headers: {} }), (e) => e.permanent === true);
  assert.strictEqual(rows.get(evt.notificationId).status, 'failed');
});

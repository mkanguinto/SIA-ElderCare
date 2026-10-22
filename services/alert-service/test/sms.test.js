'use strict';

const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');

const ENV = { ...process.env };
function resetEnv(extra = {}) {
  for (const k of Object.keys(process.env)) if (k.startsWith('SMS_') || k.startsWith('TEXTBEE_') || k === 'NODE_ENV') delete process.env[k];
  Object.assign(process.env, extra);
}
test.after(() => { process.env = ENV; });

const { normalizePhone, mode, sendSms } = require('../src/smsSender');
const { sendViaTextbee, verifyWebhookSignature } = require('../src/textbeeClient');

test('normalises Philippine numbers to E.164', () => {
  assert.strictEqual(normalizePhone('0917 123 4567'), '+639171234567');
  assert.strictEqual(normalizePhone('639171234567'), '+639171234567');
  assert.strictEqual(normalizePhone('+639171234567'), '+639171234567');
  assert.strictEqual(normalizePhone('12345'), null);
});

test('without an allow-list, development never sends real texts', () => {
  resetEnv({ TEXTBEE_API_KEY: 'k', NODE_ENV: 'development' });
  const m = mode();
  assert.strictEqual(m.provider, 'textbee');
  assert.strictEqual(m.live, false);
  assert.match(m.reason, /ALLOWLIST/);
});

test('numbers outside the allow-list are simulated, not sent', async () => {
  resetEnv({ TEXTBEE_API_KEY: 'k', SMS_RECIPIENT_ALLOWLIST: '09171234567', NODE_ENV: 'development' });
  assert.strictEqual(mode().live, true);
  const r = await sendSms({ to: '+639175550101', body: 'hi' });
  assert.strictEqual(r.simulated, true);
  assert.match(r.note, /ALLOWLIST/);
});

test('TextBee request matches the API contract', async () => {
  resetEnv({ TEXTBEE_API_KEY: 'txb_test', TEXTBEE_DEVICE_ID: 'dev123' });
  let captured;
  const fakeHttp = { post: async (url, body, opts) => { captured = { url, body, opts }; return { data: { data: { success: true, smsBatchId: 'batch1', successCount: 1 } } }; } };
  const r = await sendViaTextbee({ to: '+639171234567', body: 'Hello' }, fakeHttp);
  assert.strictEqual(captured.url, 'https://api.textbee.dev/api/v1/gateway/send-sms');
  assert.deepStrictEqual(captured.body, { recipients: ['+639171234567'], message: 'Hello', deviceId: 'dev123' });
  assert.strictEqual(captured.opts.headers['x-api-key'], 'txb_test');
  assert.strictEqual(captured.opts.headers['Content-Type'], 'application/json');
  assert.deepStrictEqual({ sid: r.sid, status: r.status }, { sid: 'batch1', status: 'sent' });
});

test('TextBee 401 is permanent, 503 is retryable', async () => {
  resetEnv({ TEXTBEE_API_KEY: 'bad' });
  const failing = (status) => ({ post: async () => { const e = new Error('x'); e.response = { status, data: { message: 'nope' } }; throw e; } });
  await assert.rejects(sendViaTextbee({ to: '+639171234567', body: 'x' }, failing(401)), (e) => e.permanent === true);
  await assert.rejects(sendViaTextbee({ to: '+639171234567', body: 'x' }, failing(503)), (e) => e.permanent === false);
});

test('webhook signature: HMAC-SHA256 hex over the raw body', () => {
  const raw = Buffer.from('{"webhookEvent":"MESSAGE_RECEIVED","sender":"+639171234567","message":"HELP"}');
  const secret = 'a-very-long-webhook-secret-1234';
  const sig = crypto.createHmac('sha256', secret).update(raw).digest('hex');
  assert.strictEqual(verifyWebhookSignature(raw, sig, secret), true);
  assert.strictEqual(verifyWebhookSignature(raw, sig.replace(/.$/, '0'), secret), false);
  assert.strictEqual(verifyWebhookSignature(raw, undefined, secret), false);
});

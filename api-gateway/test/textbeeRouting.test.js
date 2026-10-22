'use strict';

// Batch 3: TextBee webhooks verified at the gateway, then routed to the Node-RED SMS router.
const test = require('node:test');
const assert = require('node:assert');
const crypto = require('crypto');
const express = require('express');

process.env.JWT_SECRET = 'test-access-secret-0123456789abcdef0123';
process.env.JWT_REFRESH_SECRET = 'test-refresh-secret-0123456789abcdef012';
process.env.INTERNAL_SERVICE_TOKEN = 'test-internal-token';
process.env.TOKEN_STORE_FILE = 'memory';
process.env.LOG_LEVEL = 'error';
process.env.TEXTBEE_WEBHOOK_TARGET = 'node-red';
process.env.TEXTBEE_WEBHOOK_SECRET = 'textbee-test-secret';
delete process.env.TEXTBEE_VALIDATE_WEBHOOK;

const seen = [];
const nodeRed = express();
nodeRed.use(express.raw({ type: '*/*' }));
nodeRed.all('*', (req, res) => { seen.push({ path: req.originalUrl, headers: req.headers, body: req.body.toString() }); res.json({ ok: true }); });
const nodeRedServer = nodeRed.listen(0);
process.env.NODE_RED_URL = `http://127.0.0.1:${nodeRedServer.address().port}`;

const app = require('../server');
const server = app.listen(0);
const base = `http://127.0.0.1:${server.address().port}`;
test.after(() => { server.close(); nodeRedServer.close(); });

const sign = (raw) => crypto.createHmac('sha256', 'textbee-test-secret').update(raw).digest('hex');
const post = (raw, signature) => fetch(`${base}/webhooks/textbee`, {
  method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'x-signature': signature } : {}) }, body: raw,
});

test('unsigned or wrongly signed TextBee webhooks never reach Node-RED', async () => {
  const raw = '{"webhookEvent":"MESSAGE_RECEIVED","sender":"+639175550101","message":"SOS"}';
  assert.strictEqual((await post(raw)).status, 401);
  assert.strictEqual((await post(raw, sign(`${raw} `))).status, 401);
  assert.strictEqual(seen.length, 0);
});

test('signed webhook is forwarded to Node-RED byte-for-byte with the internal token', async () => {
  const raw = '{"webhookEvent":"MESSAGE_RECEIVED",  "sender":"+639175550101","message":"HELP"}';
  const res = await post(raw, `sha256=${sign(raw)}`);
  assert.strictEqual(res.status, 200);
  assert.strictEqual(seen.length, 1);
  assert.strictEqual(seen[0].path, '/webhooks/textbee');
  assert.strictEqual(seen[0].body, raw);
  assert.strictEqual(seen[0].headers['x-internal-token'], 'test-internal-token');
});

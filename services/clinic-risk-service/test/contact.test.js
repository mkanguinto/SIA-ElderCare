'use strict';

const test = require('node:test');
const assert = require('node:assert');
const C = require('../src/contact');

test('contact request: channel and reason required, "other" needs words, call back only for messages', () => {
  assert.ok(!C.validateContact({}).ok);
  assert.ok(!C.validateContact({ channel: 'fax', reason: 'worried' }).ok);
  assert.ok(!C.validateContact({ channel: 'message', reason: 'other' }).ok);
  assert.ok(C.validateContact({ channel: 'message', reason: 'other', message: 'Need new BP cuff' }).ok);
  assert.strictEqual(C.validateContact({ channel: 'message', reason: 'callback' }).value.callback, true);
  assert.strictEqual(C.validateContact({ channel: 'call', reason: 'worried', callback: true }).value.callback, false);
  assert.ok(!C.validateContact({ channel: 'message', reason: 'worried', message: 'x'.repeat(1001) }).ok);
});

test('contact request steps only move forward', () => {
  assert.ok(C.canMove('sent', 'seen'));
  assert.ok(C.canMove('seen', 'answered'));
  assert.ok(C.canMove('answered', 'closed'));
  assert.ok(!C.canMove('answered', 'seen'));
  assert.ok(!C.canMove('closed', 'answered'));
  assert.ok(!C.canMove('closed', 'closed'));
});

test('the SMS to the clinic phone names who and why, never the message or readings', () => {
  const t = C.hotlineText({ id: 'CR-000012', fromName: 'Jose Dela Cruz', fromRole: 'family_member', patientName: 'Lola Remedios', channel: 'message', reason: 'worried', callback: true });
  assert.match(t, /CR-000012/);
  assert.match(t, /family of Lola Remedios/);
  assert.match(t, /call them back/);
  assert.ok(t.length <= 480);
  assert.strictEqual(C.contactId(12), 'CR-000012');
});

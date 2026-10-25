'use strict';

const test = require('node:test');
const assert = require('node:assert');
const c = require('../src/concerns');

test('a concern needs a category and a description; related ids are checked', () => {
  assert.match(c.validateConcern({}).errors.join(), /category must be one of.*description is required/);
  assert.match(c.validateConcern({ category: 'fall', description: 'Slipped in the bathroom', related: { checkinId: 'x' } }).errors.join(), /related\.checkinId/);
  const ok = c.validateConcern({ category: 'medicine', description: 'Refused the evening dose twice', related: { medicationReportId: '11111111-1111-4111-8111-111111111111' } });
  assert.strictEqual(ok.ok, true);
  assert.deepStrictEqual(ok.value.related, { medicationReportId: '11111111-1111-4111-8111-111111111111' });
});

test('only a nurse resolution with an assessment and the action taken closes a concern', () => {
  assert.match(c.validateResolution({ assessment: 'ok' }).errors.join(), /assessment is required.*actionTaken is required/);
  assert.strictEqual(c.validateResolution({ assessment: 'BP back to usual on recheck', actionTaken: 'Phoned caregiver; visit booked' }).ok, true);
  assert.strictEqual(c.canMove('resolved', 'resolve').ok, false);
  assert.strictEqual(c.canMove('resolved', 'note').ok, false);
  assert.strictEqual(c.canMove('acknowledged', 'acknowledge').ok, false);
  assert.strictEqual(c.canMove('open', 'resolve').ok, true);
  assert.strictEqual(c.canMove('acknowledged', 'note').ok, true);
});

test('accepting a handover with open concerns needs the incoming nurse to acknowledge them', () => {
  assert.strictEqual(c.handoverAcknowledgement([], {}).ok, true);
  const open = [{ id: 'CC-000001' }];
  assert.strictEqual(c.handoverAcknowledgement(open, {}).ok, false);
  assert.strictEqual(c.handoverAcknowledgement(open, { acknowledgeOpenItems: 'yes' }).ok, false);
  assert.strictEqual(c.handoverAcknowledgement(open, { acknowledgeOpenItems: true }).ok, true);
});

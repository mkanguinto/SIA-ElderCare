'use strict';

const test = require('node:test');
const assert = require('node:assert');
const { validateHandover, canSubmit, respond, isOverdue } = require('../src/handover');

const NOW = new Date('2026-10-23T08:00:00Z');
const body = {
  patientId: 'P-1001', toNurseId: 'U-CS-002', concern: 'BP 168/100 this morning, dizzy',
  actionTaken: 'Called caregiver, advised rest', pendingAction: 'Recheck BP and call back', dueTime: '2026-10-23T10:00:00Z',
};
const care = { caseNurseId: 'U-CS-001', teamNurseIds: ['U-CS-001', 'U-CS-002'] };
const pending = { status: 'pending', fromNurse: 'U-CS-001', toNurse: 'U-CS-002' };

test('a handover needs concern, action taken, pending action and a due time', () => {
  assert.strictEqual(validateHandover(body, NOW).ok, true);
  const bad = validateHandover({ patientId: 'P-1001', toNurseId: 'U-CS-002', concern: 'x' }, NOW);
  assert.strictEqual(bad.ok, false);
  for (const f of ['concern', 'actionTaken', 'pendingAction', 'dueTime']) assert.ok(bad.errors.some((e) => e.startsWith(f)), f);
  assert.ok(validateHandover({ ...body, dueTime: '2026-10-23T06:00:00Z' }, NOW).errors[0].includes('in the past'));
  assert.ok(validateHandover({ ...body, dueTime: '2026-11-30T00:00:00Z' }, NOW).errors[0].includes('days ahead'));
});

test('only the nurse holding the case can hand it over, to a nurse on the care team', () => {
  assert.deepStrictEqual(canSubmit(care, 'U-CS-001', 'U-CS-002'), { ok: true });
  assert.strictEqual(canSubmit(care, 'U-CS-002', 'U-CS-001').status, 403);
  assert.strictEqual(canSubmit(care, 'U-CS-001', 'U-CS-001').status, 422);
  assert.strictEqual(canSubmit(care, 'U-CS-001', 'U-CS-009').error, 'not_on_team');
  assert.strictEqual(canSubmit(null, 'U-CS-001', 'U-CS-002').status, 404);
});

test('handover requires acceptance before the case transfers', () => {
  // Only "accept" by the incoming nurse moves the case; declining or cancelling leaves it with the outgoing nurse.
  assert.deepStrictEqual(respond(pending, 'accept', 'U-CS-002'), { ok: true, status: 'accepted', transfersCase: true });
  assert.strictEqual(respond(pending, 'decline', 'U-CS-002').transfersCase, false);
  assert.strictEqual(respond(pending, 'cancel', 'U-CS-001').transfersCase, false);
  // Nobody else can accept for the incoming nurse - not the outgoing nurse, not another nurse.
  assert.strictEqual(respond(pending, 'accept', 'U-CS-001').status, 403);
  assert.strictEqual(respond(pending, 'accept', 'U-CS-003').status, 403);
  assert.strictEqual(respond(pending, 'cancel', 'U-CS-002').status, 403);
});

test('a handover is answered once', () => {
  for (const status of ['accepted', 'declined', 'cancelled']) {
    const r = respond({ ...pending, status }, 'accept', 'U-CS-002');
    assert.strictEqual(r.status, 409);
    assert.strictEqual(r.error, 'already_answered');
  }
  assert.strictEqual(respond(null, 'accept', 'U-CS-002').status, 404);
});

test('a pending handover past its due time is overdue', () => {
  assert.strictEqual(isOverdue({ status: 'pending', dueTime: '2026-10-23T07:00:00Z' }, NOW), true);
  assert.strictEqual(isOverdue({ status: 'pending', dueTime: '2026-10-23T09:00:00Z' }, NOW), false);
  assert.strictEqual(isOverdue({ status: 'accepted', dueTime: '2026-10-23T07:00:00Z' }, NOW), false);
});

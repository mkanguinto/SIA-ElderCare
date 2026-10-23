'use strict';

/**
 * Nurse handover rules (pure, unit tested in test/handover.test.js).
 *
 *   outgoing nurse submits ──> pending ──(incoming nurse accepts)──> accepted   case moves to the incoming nurse
 *                                      ──(incoming nurse declines)─> declined   case stays with the outgoing nurse
 *                                      ──(outgoing nurse cancels)──> cancelled  case stays with the outgoing nurse
 *
 * While a handover is pending the outgoing nurse still holds the case. Login sessions play no part: signing
 * out, or a session being revoked, never moves or drops a case.
 */
const TEXT = { min: 3, max: 1000 };
const DUE_MAX_DAYS = 14;
const DUE_PAST_GRACE_MIN = 60; // a pending action may already be slightly overdue at handover time

function text(v, field, errors) {
  if (typeof v !== 'string' || v.trim().length < TEXT.min || v.trim().length > TEXT.max) {
    errors.push(`${field} is required (${TEXT.min}-${TEXT.max} characters)`);
    return null;
  }
  return v.trim();
}

/**
 * @param {object} body {patientId, toNurseId, concern, actionTaken, pendingAction, dueTime}
 * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
 */
function validateHandover(body, now = new Date()) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errors: ['Body must be a JSON object'] };
  const patientId = typeof body.patientId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.patientId) ? body.patientId : null;
  if (!patientId) errors.push('patientId is required');
  const toNurseId = typeof body.toNurseId === 'string' && /^[A-Za-z0-9_-]{1,64}$/.test(body.toNurseId) ? body.toNurseId : null;
  if (!toNurseId) errors.push('toNurseId is required');
  const concern = text(body.concern, 'concern', errors);
  const actionTaken = text(body.actionTaken, 'actionTaken', errors);
  const pendingAction = text(body.pendingAction, 'pendingAction', errors);
  let dueTime = null;
  if (body.dueTime === undefined || body.dueTime === null || body.dueTime === '') errors.push('dueTime is required (ISO-8601)');
  else {
    const d = new Date(body.dueTime);
    if (Number.isNaN(d.getTime())) errors.push('dueTime must be an ISO-8601 timestamp');
    else if (d.getTime() < now.getTime() - DUE_PAST_GRACE_MIN * 60000) errors.push('dueTime cannot be more than an hour in the past');
    else if (d.getTime() > now.getTime() + DUE_MAX_DAYS * 86400000) errors.push(`dueTime cannot be more than ${DUE_MAX_DAYS} days ahead`);
    else dueTime = d;
  }
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { patientId, toNurseId, concern, actionTaken, pendingAction, dueTime } };
}

/**
 * Who may submit a handover for an elder.
 * @param {{caseNurseId:string|null, teamNurseIds:string[]}} care  patient_care row + active team members
 * @returns {{ok:true} | {ok:false, status:number, error:string, message:string}}
 */
function canSubmit(care, fromNurseId, toNurseId) {
  if (!care) return { ok: false, status: 404, error: 'not_found', message: 'This elder has no care team yet' };
  if (care.caseNurseId !== fromNurseId) {
    return { ok: false, status: 403, error: 'not_case_nurse', message: 'Only the nurse holding the case can hand it over' };
  }
  if (toNurseId === fromNurseId) return { ok: false, status: 422, error: 'validation_failed', message: 'You cannot hand a case over to yourself' };
  if (!care.teamNurseIds.includes(toNurseId)) {
    return { ok: false, status: 422, error: 'not_on_team', message: "The incoming nurse must be on the elder's care team" };
  }
  return { ok: true };
}

/**
 * Answering a pending handover.
 * @param {'accept'|'decline'|'cancel'} op
 * @returns {{ok:true, status:string, transfersCase:boolean} | {ok:false, status:number, error:string, message:string}}
 */
function respond(handover, op, userId) {
  if (!handover) return { ok: false, status: 404, error: 'not_found', message: 'Handover not found' };
  if (handover.status !== 'pending') return { ok: false, status: 409, error: 'already_answered', message: `This handover is already ${handover.status}` };
  if (op === 'cancel') {
    if (handover.fromNurse !== userId) return { ok: false, status: 403, error: 'forbidden', message: 'Only the outgoing nurse can cancel a handover' };
    return { ok: true, status: 'cancelled', transfersCase: false };
  }
  if (handover.toNurse !== userId) return { ok: false, status: 403, error: 'forbidden', message: 'Only the incoming nurse can answer this handover' };
  if (op === 'accept') return { ok: true, status: 'accepted', transfersCase: true };
  if (op === 'decline') return { ok: true, status: 'declined', transfersCase: false };
  return { ok: false, status: 400, error: 'bad_request', message: `Unknown operation ${op}` };
}

/** A pending handover whose pending action is past due (shown first, flagged to both nurses). */
const isOverdue = (h, now = new Date()) => h.status === 'pending' && new Date(h.dueTime).getTime() < now.getTime();

module.exports = { validateHandover, canSubmit, respond, isOverdue, TEXT, DUE_MAX_DAYS };

'use strict';

/**
 * Check-in review status (pure, unit tested in test/reviewStatus.test.js).
 *
 *   received ──(event delivered to the clinic queue)──> awaiting_review ──(nurse)──> reviewed ──(nurse)──> action_recorded
 *
 * A nurse may review a check-in that is still "received" (broker slow) and may record an action straight
 * away; the steps that were skipped are still written to the log so the timeline is complete.
 */
const ORDER = ['received', 'awaiting_review', 'reviewed', 'action_recorded'];

/**
 * @param {string} current  current status
 * @param {'review'|'action'} op
 * @returns {{ok:true, steps:string[]} | {ok:false, error:string}} steps = statuses to log, in order
 */
function plan(current, op) {
  const from = ORDER.indexOf(current);
  if (from < 0) return { ok: false, error: `Unknown status ${current}` };
  if (op === 'review') {
    if (from >= ORDER.indexOf('reviewed')) return { ok: false, error: `Check-in is already ${current.replace('_', ' ')}` };
    return { ok: true, steps: ['reviewed'] };
  }
  if (op === 'action') {
    if (current === 'action_recorded') return { ok: true, steps: ['action_recorded'] }; // another follow-up action
    return { ok: true, steps: current === 'reviewed' ? ['action_recorded'] : ['reviewed', 'action_recorded'] };
  }
  return { ok: false, error: `Unknown operation ${op}` };
}

function validateNote(v, { required = false, min = 3, max = 500 } = {}) {
  if (v === undefined || v === null || v === '') return required ? `is required (${min}-${max} characters)` : null;
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) return `must be ${min}-${max} characters`;
  return null;
}

module.exports = { ORDER, plan, validateNote };

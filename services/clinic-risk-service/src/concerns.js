'use strict';

/**
 * Concern rules (pure, unit tested in test/concerns.test.js).
 *
 *   open ──(nurse acknowledges)──> acknowledged ──(nurse resolves with assessment + action)──> resolved
 *     └──────────────────────────(nurse resolves with assessment + action)──────────────────────┘
 *
 * Nothing else moves a concern: not a finished checklist, not a normal reading, not a reviewed check-in.
 */
const CATEGORIES = {
  health_change: 'Change in health or behaviour',
  fall: 'Fall or near fall',
  medicine: 'Medicine problem (refused, side effect, ran out)',
  eating_drinking: 'Eating, drinking or swallowing',
  skin: 'Skin, wound or pressure area',
  mobility: 'Moving, walking or transfers',
  mood: 'Mood, confusion or sleep',
  equipment: 'Equipment or supplies',
  caregiver_capacity: 'I cannot do a task safely',
  other: 'Something else',
};
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function text(v, field, errors, min, max) {
  if (typeof v !== 'string' || v.trim().length < min || v.trim().length > max) {
    errors.push(`${field} is required (${min}-${max} characters)`);
    return null;
  }
  return v.trim();
}

/** A new concern: {category, description, related?: {taskReportId, medicationReportId, checkinId}} */
function validateConcern(b) {
  const errors = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, errors: ['Body must be a JSON object'] };
  if (!CATEGORIES[b.category]) errors.push(`category must be one of: ${Object.keys(CATEGORIES).join(', ')}`);
  const description = text(b.description, 'description', errors, 3, 1000);
  const related = {};
  if (b.related !== undefined && b.related !== null) {
    if (typeof b.related !== 'object' || Array.isArray(b.related)) errors.push('related must be an object');
    else {
      for (const k of ['taskReportId', 'medicationReportId', 'checkinId']) {
        if (b.related[k] === undefined || b.related[k] === null) continue;
        if (!UUID_RE.test(b.related[k])) errors.push(`related.${k} must be an id`);
        else related[k] = b.related[k];
      }
    }
  }
  return errors.length ? { ok: false, errors } : { ok: true, value: { category: b.category, description, related } };
}

/** Resolving needs the nurse's assessment and the action taken. */
function validateResolution(b) {
  const errors = [];
  const assessment = text(b && b.assessment, 'assessment', errors, 3, 1000);
  const actionTaken = text(b && b.actionTaken, 'actionTaken', errors, 3, 1000);
  return errors.length ? { ok: false, errors } : { ok: true, value: { assessment, actionTaken } };
}

/** Is the step allowed from this status? */
function canMove(status, op) {
  if (status === 'resolved') return { ok: false, error: 'already_resolved', message: 'This concern is resolved. Raise a new concern if it comes back.' };
  if (op === 'acknowledge' && status !== 'open') return { ok: false, error: 'already_acknowledged', message: 'This concern was already acknowledged' };
  return { ok: true };
}

/**
 * Accepting a handover with open concerns needs the incoming nurse to say they have read them.
 * @returns {{ok:true} | {ok:false, message:string}}
 */
function handoverAcknowledgement(openItems, body) {
  if (!openItems || !openItems.length) return { ok: true };
  if (body && body.acknowledgeOpenItems === true) return { ok: true };
  return { ok: false, message: `This handover has ${openItems.length} open concern(s). Read them and confirm (acknowledgeOpenItems: true) to accept.` };
}

module.exports = { CATEGORIES, ID_RE, validateConcern, validateResolution, canMove, handoverAcknowledgement };

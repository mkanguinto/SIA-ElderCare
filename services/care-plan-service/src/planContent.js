'use strict';

/**
 * Care plan content and version rules - pure functions (no I/O), unit tested in test/planContent.test.js.
 *
 * The nurse writes the plan with the elder and the caregiver. Instructions that are clinical (diet, fluids,
 * swallowing, skin / wound care, restrictions) and the after-hours / emergency instructions must name where
 * they come from (a physician's order, the partner clinic, a hospital discharge, a clinic protocol). Those
 * marked as needing partner-clinic approval are verified by a clinician before the plan can be activated, and
 * the verification is recorded with the version. Nothing here invents a diet, a fluid target, a medicine time
 * or a clinical threshold: everything comes from what the nurse enters.
 */

const ASSIST_AREAS = ['eating', 'meal_preparation', 'fluids', 'hygiene', 'oral_care', 'dressing', 'toileting', 'mobility', 'transfers', 'communication', 'other'];
const ASSIST_LEVELS = ['independent', 'supervision', 'some_help', 'full_help'];
const INSTRUCTION_KINDS = ['diet', 'fluids', 'swallowing', 'skin_wound', 'restriction', 'other'];
// Instructions only a clinical source can give; a nurse's own assessment is not enough for these.
const SPECIALISED_KINDS = ['diet', 'fluids', 'swallowing', 'skin_wound'];
const SOURCE_TYPES = ['physician_order', 'partner_clinic', 'hospital_discharge', 'clinic_protocol', 'nurse_assessment'];
const CLINICAL_SOURCES = SOURCE_TYPES.filter((s) => s !== 'nurse_assessment');
const VERIFY_METHODS = ['in_person', 'phone', 'written_order', 'referral_document'];
const ALLERGY_STATUS = ['none_known', 'listed', 'not_assessed'];
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`));
const MAX_REVIEW_DAYS = 366;

function str(v, field, errors, { max = 2000, min = 0 } = {}) {
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') { errors.push(`${field} must be text`); return undefined; }
  const t = v.trim();
  if (t.length > max) { errors.push(`${field} must be at most ${max} characters`); return undefined; }
  if (t.length < min) { errors.push(`${field} must be at least ${min} characters`); return undefined; }
  return t || undefined;
}

/** Where an instruction comes from. clinicalOnly: a nurse's own assessment is not accepted. */
function source(v, field, errors, { clinicalOnly = false } = {}) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${field}.source is required (who gave this instruction)`); return undefined; }
  const types = clinicalOnly ? CLINICAL_SOURCES : SOURCE_TYPES;
  const out = {};
  if (!types.includes(v.type)) errors.push(`${field}.source.type must be one of: ${types.join(', ')}`);
  else out.type = v.type;
  out.clinician = str(v.clinician, `${field}.source.clinician`, errors, { max: 120 });
  out.facility = str(v.facility, `${field}.source.facility`, errors, { max: 120 });
  out.reference = str(v.reference, `${field}.source.reference`, errors, { max: 160 });
  if (v.date !== undefined && v.date !== null && !isDate(v.date)) errors.push(`${field}.source.date must be YYYY-MM-DD`);
  else if (v.date) out.date = v.date;
  if (out.type && out.type !== 'nurse_assessment' && out.type !== 'clinic_protocol' && !out.clinician && !out.facility) {
    errors.push(`${field}.source needs the clinician or the facility that gave it`);
  }
  if (out.type === 'clinic_protocol' && !out.reference) errors.push(`${field}.source.reference must name the protocol`);
  return JSON.parse(JSON.stringify(out));
}

function approval(v, field, errors, { forced = false } = {}) {
  if (forced) return 'required';
  if (v === undefined || v === null) return 'required';
  if (!['required', 'not_required'].includes(v)) { errors.push(`${field}.partnerApproval must be required or not_required`); return 'required'; }
  return v;
}

/**
 * Validates plan content. partial: only the given sections are checked and returned (the rest stays).
 * @returns {{errors:string[], value:object}}
 */
function validateContent(body, { partial = true } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = [];
  const allowed = ['preferences', 'goals', 'notes', 'assistanceNeeds', 'allergies', 'clinicalInstructions', 'caregiver', 'monitoring', 'contact'];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) errors.push(`unknown content field(s): ${unknown.join(', ')}`);
  const has = (k) => b[k] !== undefined;
  const value = {};

  for (const k of ['preferences', 'goals', 'notes']) if (has(k)) value[k] = str(b[k], k, errors) ?? null;

  if (has('assistanceNeeds')) {
    if (!Array.isArray(b.assistanceNeeds) || b.assistanceNeeds.length > 15) errors.push('assistanceNeeds must be a list of up to 15 needs');
    else {
      value.assistanceNeeds = b.assistanceNeeds.map((n, i) => {
        const f = `assistanceNeeds[${i}]`;
        if (!n || typeof n !== 'object') { errors.push(`${f} must be an object`); return null; }
        if (!ASSIST_AREAS.includes(n.area)) errors.push(`${f}.area must be one of: ${ASSIST_AREAS.join(', ')}`);
        if (!ASSIST_LEVELS.includes(n.level)) errors.push(`${f}.level must be one of: ${ASSIST_LEVELS.join(', ')}`);
        return JSON.parse(JSON.stringify({ area: n.area, level: n.level, details: str(n.details, `${f}.details`, errors, { max: 500 }) }));
      }).filter(Boolean);
    }
  }

  if (has('allergies')) {
    const a = b.allergies;
    if (!a || typeof a !== 'object' || !ALLERGY_STATUS.includes(a.status)) errors.push(`allergies.status must be one of: ${ALLERGY_STATUS.join(', ')}`);
    else {
      const items = Array.isArray(a.items) ? a.items : [];
      if (a.status === 'listed' && !items.length) errors.push('allergies.items must list at least one allergy when status is listed');
      if (a.status !== 'listed' && items.length) errors.push('allergies.items is only for status listed');
      value.allergies = {
        status: a.status,
        items: items.slice(0, 20).map((it, i) => {
          const f = `allergies.items[${i}]`;
          const substance = str(it && it.substance, `${f}.substance`, errors, { max: 120, min: 2 });
          if (!substance) errors.push(`${f}.substance is required`);
          return JSON.parse(JSON.stringify({ substance, reaction: str(it && it.reaction, `${f}.reaction`, errors, { max: 200 }), source: str(it && it.source, `${f}.source`, errors, { max: 160 }) }));
        }),
      };
    }
  }

  if (has('clinicalInstructions')) {
    if (!Array.isArray(b.clinicalInstructions) || b.clinicalInstructions.length > 20) errors.push('clinicalInstructions must be a list of up to 20 instructions');
    else {
      value.clinicalInstructions = b.clinicalInstructions.map((ci, i) => {
        const f = `clinicalInstructions[${i}]`;
        if (!ci || typeof ci !== 'object') { errors.push(`${f} must be an object`); return null; }
        if (!INSTRUCTION_KINDS.includes(ci.kind)) errors.push(`${f}.kind must be one of: ${INSTRUCTION_KINDS.join(', ')}`);
        const specialised = SPECIALISED_KINDS.includes(ci.kind);
        const text = str(ci.text, `${f}.text`, errors, { max: 1000, min: 3 });
        if (!text) errors.push(`${f}.text is required`);
        return {
          kind: ci.kind,
          text,
          source: source(ci.source, f, errors, { clinicalOnly: specialised }),
          // Specialised instructions always need the partner clinic's approval.
          partnerApproval: approval(ci.partnerApproval, f, errors, { forced: specialised }),
        };
      }).filter(Boolean);
    }
  }

  if (has('caregiver')) {
    const c = b.caregiver && typeof b.caregiver === 'object' ? b.caregiver : {};
    value.caregiver = JSON.parse(JSON.stringify({
      responsibilities: str(c.responsibilities, 'caregiver.responsibilities', errors),
      trainingAndCapacity: str(c.trainingAndCapacity, 'caregiver.trainingAndCapacity', errors),
      notForCaregiver: str(c.notForCaregiver, 'caregiver.notForCaregiver', errors),
    }));
  }

  if (has('monitoring')) {
    const m = b.monitoring && typeof b.monitoring === 'object' ? b.monitoring : {};
    value.monitoring = JSON.parse(JSON.stringify({ followUp: str(m.followUp, 'monitoring.followUp', errors) }));
  }

  if (has('contact')) {
    const c = b.contact && typeof b.contact === 'object' ? b.contact : {};
    const out = {
      clinicName: str(c.clinicName, 'contact.clinicName', errors, { max: 160 }),
      phone: str(c.phone, 'contact.phone', errors, { max: 40 }),
      monitoringHours: str(c.monitoringHours, 'contact.monitoringHours', errors, { max: 200 }),
    };
    if (out.phone && !/^[+0-9][0-9\s-]{5,30}$/.test(out.phone)) errors.push('contact.phone must be a phone number');
    // After-hours and emergency instructions are approved instructions, never free advice.
    for (const k of ['afterHours', 'emergency']) {
      const x = c[k];
      if (x === undefined || x === null) continue;
      const text = str(x.text, `contact.${k}.text`, errors, { max: 1000, min: 3 });
      out[k] = { text, source: source(x.source, `contact.${k}`, errors, { clinicalOnly: true }), partnerApproval: 'required' };
    }
    value.contact = JSON.parse(JSON.stringify(out));
  }

  if (!partial) {
    for (const k of allowed) if (value[k] === undefined && k !== 'notes') value[k] = null;
  }
  return { errors, value };
}

/** The clinician's verification of the instructions that need partner-clinic approval. */
function validateVerification(body, today) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = [];
  const v = {
    clinicianName: str(b.clinicianName, 'clinicianName', errors, { max: 120, min: 3 }),
    clinicianRole: str(b.clinicianRole, 'clinicianRole', errors, { max: 80, min: 2 }),
    facility: str(b.facility, 'facility', errors, { max: 160 }),
    reference: str(b.reference, 'reference', errors, { max: 160 }),
    method: b.method,
    verifiedOn: b.verifiedOn,
  };
  if (!v.clinicianName) errors.push('clinicianName is required');
  if (!v.clinicianRole) errors.push('clinicianRole is required (e.g. physician, partner-clinic nurse)');
  if (!VERIFY_METHODS.includes(b.method)) errors.push(`method must be one of: ${VERIFY_METHODS.join(', ')}`);
  if (!isDate(b.verifiedOn)) errors.push('verifiedOn must be YYYY-MM-DD');
  else if (today && b.verifiedOn > today) errors.push('verifiedOn cannot be in the future');
  if (['written_order', 'referral_document'].includes(b.method) && !v.reference) errors.push('reference is required for a written order or referral document');
  return { errors, value: JSON.parse(JSON.stringify(v)) };
}

/** Instructions in this content that need partner-clinic approval (so the plan needs a verification). */
function approvalItems(content = {}) {
  const items = [];
  for (const ci of content.clinicalInstructions || []) if (ci.partnerApproval === 'required') items.push({ kind: ci.kind, text: ci.text });
  for (const k of ['afterHours', 'emergency']) if (content.contact && content.contact[k]) items.push({ kind: k, text: content.contact[k].text });
  return items;
}

/** Tasks that need a clinical source to be part of a plan (specialised care). */
function taskProblems(tasks) {
  return tasks.filter((t) => t.active && t.specialised && !(t.source && t.source.type && t.source.type !== 'nurse_assessment'))
    .map((t) => `task "${t.title}" is specialised and needs a clinical source`);
}

/**
 * What is still missing before a draft can be activated (empty = ready).
 * @param {object} v       the draft version (camelCase DTO)
 * @param {object[]} tasks the draft's tasks
 * @param {string} today   YYYY-MM-DD in the clinic's time zone
 */
function activationProblems(v, tasks, today) {
  const p = [];
  const c = v.content || {};
  if (v.status !== 'draft') p.push('only a draft can be activated');
  if (!c.goals) p.push('care goals are missing');
  if (!c.preferences) p.push("the elder's preferences are missing");
  if (!c.allergies || !c.allergies.status) p.push('allergies are not recorded (choose none known, listed or not assessed)');
  if (!c.caregiver || !c.caregiver.responsibilities) p.push("the caregiver's responsibilities are missing");
  if (!c.contact || !c.contact.phone || !c.contact.monitoringHours) p.push('the clinic phone and monitoring hours are missing');
  if (!c.contact || !c.contact.emergency || !c.contact.emergency.text) p.push('the approved emergency instructions are missing');
  if (!v.responsibleNurseId) p.push('the responsible nurse is not set');
  if (typeof v.elderInvolved !== 'boolean' || typeof v.caregiverInvolved !== 'boolean') p.push('say whether the elder and the caregiver took part in planning');
  else if ((!v.elderInvolved || !v.caregiverInvolved) && !v.involvementNote) p.push('explain why the elder or the caregiver did not take part');
  if (!v.effectiveDate) p.push('the effective date is missing');
  else if (today && v.effectiveDate > today) p.push('the effective date is in the future: activate the plan on that day');
  if (!v.reviewDate) p.push('the review date is missing');
  else if (v.effectiveDate && (v.reviewDate <= v.effectiveDate || daysBetween(v.effectiveDate, v.reviewDate) > MAX_REVIEW_DAYS)) p.push(`the review date must be after the effective date and within ${MAX_REVIEW_DAYS} days`);
  if (approvalItems(c).length && !v.verification) p.push('instructions that need partner-clinic approval have not been verified by a clinician');
  p.push(...taskProblems(tasks));
  return p;
}

function daysBetween(a, b) {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86400000);
}

/**
 * What a family member sees of the active plan: goals, preferences, who is responsible, how to reach the
 * clinic and the approved emergency instructions. Not the clinical instructions' sources, verification or drafts.
 */
function familySummary(v) {
  if (!v) return null;
  const c = v.content || {};
  return {
    version: v.version, status: v.status, effectiveDate: v.effectiveDate, reviewDate: v.reviewDate, legacy: v.legacy,
    goals: c.goals || null, preferences: c.preferences || null,
    responsibleNurse: v.responsibleNurseName || null,
    contact: c.contact ? { clinicName: c.contact.clinicName || null, phone: c.contact.phone || null, monitoringHours: c.contact.monitoringHours || null,
      afterHours: c.contact.afterHours ? c.contact.afterHours.text : null, emergency: c.contact.emergency ? c.contact.emergency.text : null } : null,
  };
}

module.exports = {
  ASSIST_AREAS, ASSIST_LEVELS, INSTRUCTION_KINDS, SPECIALISED_KINDS, SOURCE_TYPES, CLINICAL_SOURCES, VERIFY_METHODS, ALLERGY_STATUS,
  validateContent, validateVerification, approvalItems, taskProblems, activationProblems, familySummary, isDate, source,
};

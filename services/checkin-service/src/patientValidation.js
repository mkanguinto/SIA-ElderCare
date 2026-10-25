'use strict';

/**
 * Validation for patient onboarding and prescribed medications. Pure functions (unit tested).
 * Returns { ok: true, value } or { ok: false, errors: string[] } like validateCheckin().
 */
const { RANGES } = require('./validation');

const SEX = ['F', 'M', 'X'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

const str = (v) => (typeof v === 'string' ? v.trim() : '');

function isRealDate(s) {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

function ageOn(birth, now) {
  const [y, m, d] = birth.split('-').map(Number);
  let a = now.getUTCFullYear() - y;
  if (now.getUTCMonth() + 1 < m || (now.getUTCMonth() + 1 === m && now.getUTCDate() < d)) a -= 1;
  return a;
}

// Where a prescription comes from. A nurse documents it; the system never makes one up.
const RX_SOURCES = ['physician_order', 'partner_clinic', 'hospital_discharge', 'prescription_document', 'other'];
const ROUTES = ['oral', 'sublingual', 'inhaled', 'topical', 'eye', 'ear', 'nasal', 'injection', 'patch', 'other'];
const VERIFY_METHODS = ['in_person', 'phone', 'written_order', 'prescription_document', 'other'];

/** "Other" in a list: the nurse's own words are required (2-80 characters). */
function otherText(v, field, errors) {
  const t = str(v);
  if (t.length < 2 || t.length > 80) { errors.push(`${field} is required when "other" is chosen (2-80 characters)`); return undefined; }
  return t;
}

/** {type, prescriber, facility, reference, date} - who ordered it, and from which document or contact. */
function validateRxSource(src, field, errors, today) {
  if (!src || typeof src !== 'object' || Array.isArray(src)) { errors.push(`${field} is required: who prescribed or ordered it`); return undefined; }
  const out = {};
  if (!RX_SOURCES.includes(src.type)) errors.push(`${field}.type must be one of: ${RX_SOURCES.join(', ')}`);
  else out.type = src.type;
  if (out.type === 'other') out.typeOther = otherText(src.typeOther, `${field}.typeOther`, errors);
  const prescriber = str(src.prescriber);
  if (prescriber.length < 3 || prescriber.length > 120) errors.push(`${field}.prescriber is required (3-120 characters)`);
  else out.prescriber = prescriber;
  for (const k of ['facility', 'reference']) {
    const v = str(src[k]);
    if (v.length > 160) errors.push(`${field}.${k} must be at most 160 characters`);
    else if (v) out[k] = v;
  }
  if (src.date !== undefined && src.date !== null && src.date !== '') {
    if (!isRealDate(String(src.date))) errors.push(`${field}.date must be YYYY-MM-DD`);
    else if (today && String(src.date) > today) errors.push(`${field}.date cannot be in the future`);
    else out.date = String(src.date);
  }
  if (['prescription_document', 'hospital_discharge'].includes(out.type) && !out.reference) errors.push(`${field}.reference is required for a ${out.type.replace('_', ' ')}`);
  return out;
}

/** How the nurse checked the record against its source. */
function validateRxVerification(v, field, errors, today) {
  if (!v || typeof v !== 'object' || Array.isArray(v)) { errors.push(`${field} must be an object`); return undefined; }
  const out = {};
  if (!VERIFY_METHODS.includes(v.method)) errors.push(`${field}.method must be one of: ${VERIFY_METHODS.join(', ')}`);
  else out.method = v.method;
  if (out.method === 'other') out.methodOther = otherText(v.methodOther, `${field}.methodOther`, errors);
  if (!isRealDate(String(v.verifiedOn || ''))) errors.push(`${field}.verifiedOn must be YYYY-MM-DD`);
  else if (today && String(v.verifiedOn) > today) errors.push(`${field}.verifiedOn cannot be in the future`);
  else out.verifiedOn = String(v.verifiedOn);
  const withWhom = str(v.verifiedWith);
  if (withWhom.length > 120) errors.push(`${field}.verifiedWith must be at most 120 characters`);
  else if (withWhom) out.verifiedWith = withWhom;
  return out;
}

/**
 * One prescription as the nurse records it from its source. `prefix` is used in error messages
 * (e.g. "medications[0]."). No time, dose or frequency is filled in for the nurse.
 */
function validateMedication(m, prefix = '', { today = null } = {}) {
  const errors = [];
  const value = {};
  if (!m || typeof m !== 'object' || Array.isArray(m)) return { ok: false, errors: [`${prefix || 'medication '}must be an object`] };
  const allowed = ['name', 'strength', 'dose', 'dosage', 'route', 'routeOther', 'frequency', 'times', 'foodInstructions', 'instructions', 'prescribedBy', 'startDate', 'endDate',
    'source', 'verification', 'missedDoseInstructions', 'missedDoseSource', 'changeReason'];
  const unknown = Object.keys(m).filter((k) => !allowed.includes(k));
  if (unknown.length) errors.push(`${prefix}unknown field(s): ${unknown.join(', ')}`);

  const text = (key, min, max, required) => {
    if (m[key] === undefined || m[key] === null || m[key] === '') {
      if (required) errors.push(`${prefix}${key} is required`);
      return;
    }
    const v = str(m[key]);
    if (v.length < min || v.length > max) errors.push(`${prefix}${key} must be ${min}-${max} characters`);
    else value[key] = v;
  };
  text('name', 2, 80, true);
  text('strength', 1, 40, !m.dosage);   // e.g. "500 mg tablet"
  text('dose', 1, 40, false);           // e.g. "1 tablet"
  text('dosage', 1, 40, false);         // older single field (strength and dose together)
  text('frequency', 2, 60, true);       // as written on the prescription, e.g. "twice a day"
  text('foodInstructions', 2, 200, false);
  text('instructions', 0, 300, false);
  text('prescribedBy', 2, 80, false);
  text('changeReason', 3, 300, false);
  if (m.route !== undefined && m.route !== null && m.route !== '') {
    if (!ROUTES.includes(m.route)) errors.push(`${prefix}route must be one of: ${ROUTES.join(', ')}`);
    // "other": the route as written on the prescription is kept in its place.
    else value.route = m.route === 'other' ? otherText(m.routeOther, `${prefix}routeOther`, errors) : m.route;
  }
  if (!value.dosage) value.dosage = [value.strength, value.dose].filter(Boolean).join(', ') || undefined;

  if (m.times !== undefined) {
    if (!Array.isArray(m.times) || m.times.length > 6 || m.times.some((t) => !TIME_RE.test(String(t)))) {
      errors.push(`${prefix}times must be up to 6 times in 24-hour HH:MM format, e.g. ["08:00","20:00"]`);
    } else value.times = [...new Set(m.times.map(String))].sort();
  }
  for (const key of ['startDate', 'endDate']) {
    if (m[key] === undefined || m[key] === null || m[key] === '') continue;
    if (!isRealDate(String(m[key]))) errors.push(`${prefix}${key} must be a date in YYYY-MM-DD format`);
    else value[key] = String(m[key]);
  }
  if (value.startDate && value.endDate && value.endDate < value.startDate) errors.push(`${prefix}endDate cannot be before startDate`);

  value.source = validateRxSource(m.source, `${prefix}source`, errors, today);
  if (value.source && value.source.prescriber && !value.prescribedBy) value.prescribedBy = value.source.prescriber;
  if (m.verification !== undefined && m.verification !== null) value.verification = validateRxVerification(m.verification, `${prefix}verification`, errors, today);
  // What to do after a missed or refused dose is clinical advice: only with its own clinical source.
  if (m.missedDoseInstructions !== undefined && m.missedDoseInstructions !== null && m.missedDoseInstructions !== '') {
    text('missedDoseInstructions', 5, 500, false);
    value.missedDoseSource = validateRxSource(m.missedDoseSource, `${prefix}missedDoseSource`, errors, today);
  } else if (m.missedDoseSource) errors.push(`${prefix}missedDoseSource is only given with missedDoseInstructions`);

  return errors.length ? { ok: false, errors } : { ok: true, value: JSON.parse(JSON.stringify(value)) };
}

/** Stopping a prescription: the reason and who ordered the stop. */
function validateStop(b, today) {
  const errors = [];
  const reason = str(b && b.reason);
  if (reason.length < 3 || reason.length > 300) errors.push('reason is required (3-300 characters)');
  const source = validateRxSource(b && b.source, 'source', errors, today);
  return errors.length ? { ok: false, errors } : { ok: true, value: { reason, source } };
}

/** New-patient onboarding payload. */
function validatePatient(b, now = new Date()) {
  const errors = [];
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, errors: ['Body must be a JSON object'] };
  const v = {};

  const fullName = str(b.fullName);
  if (fullName.length < 3 || fullName.length > 120) errors.push('fullName is required (3-120 characters)');
  else v.fullName = fullName;

  const birth = str(b.birthDate);
  if (!isRealDate(birth)) errors.push('birthDate is required in YYYY-MM-DD format');
  else {
    const a = ageOn(birth, now);
    if (a < 0) errors.push('birthDate cannot be in the future');
    else if (a < 18 || a > 125) errors.push('Patient age must be between 18 and 125 years');
    else v.birthDate = birth;
  }

  if (b.sex !== undefined && b.sex !== null && b.sex !== '') {
    if (!SEX.includes(b.sex)) errors.push(`sex must be one of: ${SEX.join(', ')}`);
    else v.sex = b.sex;
  }

  const address = str(b.addressLine);
  if (address.length < 3 || address.length > 200) errors.push('addressLine is required (3-200 characters): street, barangay, city');
  else v.addressLine = address;

  const zip = str(b.zipCode);
  if (!/^[A-Za-z0-9 -]{3,10}$/.test(zip)) errors.push('zipCode is required (3-10 letters/digits, e.g. 1012)');
  else v.zipCode = zip;

  const cc = b.countryCode === undefined ? 'PH' : str(b.countryCode).toUpperCase();
  if (!/^[A-Z]{2}$/.test(cc)) errors.push('countryCode must be a 2-letter code, e.g. PH');
  else v.countryCode = cc;

  for (const [key, lo, hi] of [['latitude', -90, 90], ['longitude', -180, 180]]) {
    if (b[key] === undefined || b[key] === null || b[key] === '') continue;
    const n = Number(b[key]);
    if (!Number.isFinite(n) || n < lo || n > hi) errors.push(`${key} must be between ${lo} and ${hi}`);
    else v[key] = n;
  }
  if ((v.latitude === undefined) !== (v.longitude === undefined)) errors.push('latitude and longitude must be provided together');

  const conditions = b.conditions === undefined ? [] : b.conditions;
  if (!Array.isArray(conditions) || conditions.length > 15) errors.push('conditions must be a list of up to 15 conditions');
  else {
    const slugs = conditions.map((c) => str(c).toLowerCase().replace(/[\s-]+/g, '_'));
    if (slugs.some((c) => !/^[a-z][a-z0-9_]{1,39}$/.test(c))) errors.push('Each condition must be 2-40 letters, e.g. "hypertension" or "heart_disease"');
    else v.conditions = [...new Set(slugs)];
  }

  if (b.mobilityRestricted !== undefined && typeof b.mobilityRestricted !== 'boolean') errors.push('mobilityRestricted must be true or false');
  else v.mobilityRestricted = Boolean(b.mobilityRestricted);

  v.baseline = {};
  if (b.baseline !== undefined) {
    if (!b.baseline || typeof b.baseline !== 'object') errors.push('baseline must be an object of usual vitals');
    else {
      for (const [key, [lo, hi]] of Object.entries(RANGES)) {
        const val = b.baseline[key];
        if (val === undefined || val === null || val === '') continue;
        const n = Number(val);
        if (!Number.isFinite(n) || n < lo || n > hi) errors.push(`baseline.${key} must be between ${lo} and ${hi}`);
        else v.baseline[key] = n;
      }
    }
  }

  if (b.assignedClinic !== undefined && b.assignedClinic !== '') {
    const c = str(b.assignedClinic);
    if (c.length < 2 || c.length > 40) errors.push('assignedClinic must be 2-40 characters');
    else v.assignedClinic = c;
  }

  v.emergencyContact = {};
  if (b.emergencyContact) {
    const ec = b.emergencyContact;
    const name = str(ec.name);
    const phone = str(ec.phone).replace(/[\s()-]/g, '');
    if (name && (name.length < 2 || name.length > 80)) errors.push('emergencyContact.name must be 2-80 characters');
    if (phone && !/^(\+?\d{10,15}|0\d{10})$/.test(phone)) errors.push('emergencyContact.phone must be a mobile number, e.g. +639171234567 or 09171234567');
    if (name || phone) v.emergencyContact = { name, phone, relation: str(ec.relation).slice(0, 40) };
  }

  if (b.notes !== undefined) {
    if (typeof b.notes !== 'string' || b.notes.length > 2000) errors.push('notes must be at most 2000 characters');
    else v.notes = b.notes.trim() || null;
  }

  v.medications = [];
  if (b.medications !== undefined) {
    if (!Array.isArray(b.medications) || b.medications.length > 20) errors.push('medications must be a list of up to 20 prescriptions');
    else {
      b.medications.forEach((m, i) => {
        const r = validateMedication(m, `medications[${i}].`);
        if (r.ok) v.medications.push(r.value);
        else errors.push(...r.errors);
      });
    }
  }

  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}

/** The clinical part of a patient's profile, recorded by a nurse: conditions and limited mobility. */
function validateHealth(b) {
  const errors = [];
  const v = {};
  if (!b || typeof b !== 'object' || Array.isArray(b)) return { ok: false, errors: ['body must be an object'] };
  const unknown = Object.keys(b).filter((k) => !['conditions', 'mobilityRestricted'].includes(k));
  if (unknown.length) errors.push(`unknown field(s): ${unknown.join(', ')}`);
  if (b.conditions !== undefined) {
    if (!Array.isArray(b.conditions) || b.conditions.length > 15) errors.push('conditions must be a list of up to 15 conditions');
    else {
      const slugs = b.conditions.map((c) => str(c).toLowerCase().replace(/[\s-]+/g, '_'));
      if (slugs.some((c) => !/^[a-z][a-z0-9_]{1,39}$/.test(c))) errors.push('Each condition must be 2-40 letters, e.g. "hypertension" or "heart_disease"');
      else v.conditions = [...new Set(slugs)];
    }
  }
  if (b.mobilityRestricted !== undefined) {
    if (typeof b.mobilityRestricted !== 'boolean') errors.push('mobilityRestricted must be true or false');
    else v.mobilityRestricted = b.mobilityRestricted;
  }
  if (!errors.length && !Object.keys(v).length) errors.push('Give conditions and/or mobilityRestricted');
  return errors.length ? { ok: false, errors } : { ok: true, value: v };
}

module.exports = { validateHealth, validatePatient, validateMedication, validateStop, validateRxVerification, isRealDate, RX_SOURCES, ROUTES, VERIFY_METHODS };

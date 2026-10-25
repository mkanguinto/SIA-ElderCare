'use strict';

/**
 * Structured vitals validation (Section 9: "validates structured vitals input ... against basic
 * range checks before storage"). Ranges reject physiologically impossible / typo values; they
 * are NOT clinical alert thresholds (those live in anomaly.js).
 *
 * Pure function, no dependencies - unit tested in test/validation.test.js.
 */
const RANGES = {
  systolic: [50, 300],
  diastolic: [30, 200],
  heartRate: [20, 250],
  temperatureC: [30, 45],
  spo2: [50, 100],
  bloodGlucose: [20, 800],
};
const MOBILITY = ['normal', 'assisted', 'wheelchair', 'bedridden', 'fall_reported'];
const MOOD = ['good', 'neutral', 'low', 'confused', 'agitated'];
const MAX_NOTES = 2000;
const ENV_SOURCES = ['device_location', 'patient_address'];
// Which device each reading came from (health safeguard: readings from wrist cuffs or forehead thermometers
// are less reliable, and a nurse should know when a reading came from a different device than usual).
const DEVICES = {
  bp: ['upper_arm_digital', 'wrist_digital', 'manual_aneroid', 'bluetooth_monitor', 'other'],
  thermometer: ['digital_oral', 'digital_axillary', 'infrared_forehead', 'infrared_ear', 'other'],
  oximeter: ['fingertip', 'other'],
};
// "other" (a device or a reason not in the list) comes with the caregiver's words under "<key>Other", e.g. bpOther.
const otherWords = (obj, k, field, errors) => {
  const t = typeof obj[`${k}Other`] === 'string' ? obj[`${k}Other`].trim() : '';
  if (t.length < 2 || t.length > 80) { errors.push(`${field}.${k}Other is required when "other" is chosen (2-80 characters)`); return undefined; }
  return t;
};
// Why a vital sign has no value. A missing reading is never sent or stored as 0.
const MISSING_REASONS = ['not_measured', 'no_device', 'unknown', 'other'];
const MISSING_KEYS = { bp: ['systolic', 'diastolic'], heartRate: ['heartRate'], temperatureC: ['temperatureC'], spo2: ['spo2'], bloodGlucose: ['bloodGlucose'] };

/** Idempotency keys used only by the automated test suites (Postman, smoke test, SMS tests). */
const TEST_KEY = /^(pm-|offline-|sms-smoke|sms-pm|env-test-)/;
const isTestRecordKey = (key) => typeof key === 'string' && TEST_KEY.test(key);

function isNum(v) {
  return typeof v === 'number' && Number.isFinite(v);
}

/**
 * @returns {{ ok: true, value: object } | { ok: false, errors: string[] }}
 */
function validateCheckin(body, now = new Date()) {
  const errors = [];
  if (!body || typeof body !== 'object' || Array.isArray(body)) return { ok: false, errors: ['Body must be a JSON object'] };

  const patientId = typeof body.patientId === 'string' ? body.patientId.trim() : '';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(patientId)) errors.push('patientId is required (1-64 chars: letters, digits, _ or -)');

  const v = body.vitals && typeof body.vitals === 'object' ? body.vitals : {};
  const vitals = {};
  for (const [field, [min, max]] of Object.entries(RANGES)) {
    if (v[field] === undefined || v[field] === null) continue;
    if (!isNum(v[field])) errors.push(`vitals.${field} must be a number`);
    else if (v[field] === 0) errors.push(`vitals.${field} cannot be 0; leave it out and give a reason in vitalsMissing (${MISSING_REASONS.join(', ')})`);
    else if (v[field] < min || v[field] > max) errors.push(`vitals.${field} must be between ${min} and ${max}`);
    else vitals[field] = field === 'temperatureC' ? Math.round(v[field] * 10) / 10 : Math.round(v[field]);
  }
  if ((vitals.systolic === undefined) !== (vitals.diastolic === undefined)) {
    errors.push('vitals.systolic and vitals.diastolic must be provided together');
  } else if (vitals.systolic !== undefined && vitals.diastolic >= vitals.systolic) {
    errors.push('vitals.diastolic must be lower than vitals.systolic');
  }

  const med = body.medication || {};
  if (med.taken !== undefined && typeof med.taken !== 'boolean') errors.push('medication.taken must be true or false');
  const missed = med.missed === undefined ? [] : med.missed;
  if (!Array.isArray(missed) || missed.some((m) => typeof m !== 'string' || m.length > 100)) {
    errors.push('medication.missed must be an array of medication names');
  }

  if (body.mobilityStatus !== undefined && !MOBILITY.includes(body.mobilityStatus)) {
    errors.push(`mobilityStatus must be one of: ${MOBILITY.join(', ')}`);
  }
  if (body.mood !== undefined && !MOOD.includes(body.mood)) errors.push(`mood must be one of: ${MOOD.join(', ')}`);
  if (body.notes !== undefined && (typeof body.notes !== 'string' || body.notes.length > MAX_NOTES)) {
    errors.push(`notes must be a string of at most ${MAX_NOTES} characters`);
  }

  let recordedAt = now;
  if (body.recordedAt !== undefined) {
    const d = new Date(body.recordedAt);
    if (Number.isNaN(d.getTime())) errors.push('recordedAt must be an ISO-8601 timestamp');
    else if (d.getTime() > now.getTime() + 5 * 60 * 1000) errors.push('recordedAt cannot be in the future');
    else if (d.getTime() < now.getTime() - 7 * 24 * 3600 * 1000) errors.push('recordedAt cannot be older than 7 days');
    else recordedAt = d;
  }

  if (body.idempotencyKey !== undefined && !/^[A-Za-z0-9_-]{8,100}$/.test(String(body.idempotencyKey))) {
    errors.push('idempotencyKey must be 8-100 chars (letters, digits, _ or -)');
  }

  // Optional outdoor conditions at the time of the check-in (shown to nurses next to body temperature).
  let environment = null;
  if (body.environment !== undefined && body.environment !== null) {
    const e = body.environment;
    if (typeof e !== 'object' || Array.isArray(e)) errors.push('environment must be an object');
    else {
      const num = (k, lo, hi) => {
        if (e[k] === undefined || e[k] === null) return undefined;
        if (!isNum(e[k]) || e[k] < lo || e[k] > hi) { errors.push(`environment.${k} must be between ${lo} and ${hi}`); return undefined; }
        return Math.round(e[k] * 10) / 10;
      };
      environment = {
        outsideTempC: num('outsideTempC', -30, 60),
        heatIndexC: num('heatIndexC', -30, 80),
        humidity: num('humidity', 0, 100),
      };
      if (e.locationName !== undefined && e.locationName !== null) {
        if (typeof e.locationName !== 'string' || e.locationName.length > 80) errors.push('environment.locationName must be a string of at most 80 characters');
        else environment.locationName = e.locationName.trim();
      }
      if (e.source !== undefined && !ENV_SOURCES.includes(e.source)) errors.push(`environment.source must be one of: ${ENV_SOURCES.join(', ')}`);
      else if (e.source) environment.source = e.source;
      environment = Object.fromEntries(Object.entries(environment).filter(([, v]) => v !== undefined));
      if (!Object.keys(environment).length) environment = null;
    }
  }

  let measurementDevice = null;
  if (body.measurementDevice !== undefined && body.measurementDevice !== null) {
    const d = body.measurementDevice;
    if (typeof d !== 'object' || Array.isArray(d)) errors.push('measurementDevice must be an object');
    else {
      measurementDevice = {};
      for (const [k, v] of Object.entries(d)) {
        if (k.endsWith('Other') && DEVICES[k.slice(0, -5)]) continue;
        if (!DEVICES[k]) errors.push(`measurementDevice.${k} is not a known device type (bp, thermometer, oximeter)`);
        else if (!DEVICES[k].includes(v)) errors.push(`measurementDevice.${k} must be one of: ${DEVICES[k].join(', ')}`);
        else {
          measurementDevice[k] = v;
          if (v === 'other') measurementDevice[`${k}Other`] = otherWords(d, k, 'measurementDevice', errors);
        }
      }
      if (!Object.keys(measurementDevice).length) measurementDevice = null;
    }
  }

  let vitalsMissing = null;
  if (body.vitalsMissing !== undefined && body.vitalsMissing !== null) {
    const m = body.vitalsMissing;
    if (typeof m !== 'object' || Array.isArray(m)) errors.push('vitalsMissing must be an object');
    else {
      vitalsMissing = {};
      for (const [k, reason] of Object.entries(m)) {
        if (k.endsWith('Other') && MISSING_KEYS[k.slice(0, -5)]) continue;
        if (!MISSING_KEYS[k]) errors.push(`vitalsMissing.${k} is not a vital sign (${Object.keys(MISSING_KEYS).join(', ')})`);
        else if (!MISSING_REASONS.includes(reason)) errors.push(`vitalsMissing.${k} must be one of: ${MISSING_REASONS.join(', ')}`);
        else if (MISSING_KEYS[k].some((f) => vitals[f] !== undefined)) errors.push(`vitalsMissing.${k} cannot be given together with a value`);
        else {
          vitalsMissing[k] = reason;
          if (reason === 'other') vitalsMissing[`${k}Other`] = otherWords(m, k, 'vitalsMissing', errors);
        }
      }
      if (!Object.keys(vitalsMissing).length) vitalsMissing = null;
    }
  }

  // Demo / test data is marked by the client that creates it (test suites); the route decides whether it is accepted.
  if (body.dataOrigin !== undefined && !['live', 'demo'].includes(body.dataOrigin)) errors.push('dataOrigin must be live or demo');

  if (!Object.keys(vitals).length && !vitalsMissing && med.taken === undefined && !body.mobilityStatus && !body.notes) {
    errors.push('Provide at least one vital sign, medication status, mobility status or note');
  }

  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    value: {
      patientId,
      vitals,
      medication: { taken: med.taken, missed },
      mobilityStatus: body.mobilityStatus || null,
      mood: body.mood || null,
      notes: body.notes ? body.notes.trim() : null,
      recordedAt,
      idempotencyKey: body.idempotencyKey ? String(body.idempotencyKey) : null,
      environment,
      measurementDevice,
      vitalsMissing,
      dataOrigin: body.dataOrigin || 'live',
    },
  };
}

module.exports = { validateCheckin, isTestRecordKey, RANGES, MOBILITY, MOOD, DEVICES, MISSING_REASONS, MISSING_KEYS };

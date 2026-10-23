// Data helpers shared by the phone screens: offline outbox, today's medicine status, plain-language alerts.
import { api } from '../api';
import { manilaDay, isToday, hhmm, shortName } from './kit';

/* ------------------------------ offline outbox (C6) ------------------------------ */
// A check-in that could not reach the server is kept on the phone with its idempotency key and the time it
// was taken (recordedAt), then re-sent when the signal returns. The key makes the retry safe: the check-in
// service returns the first result for a repeated key instead of saving a second check-in.
const outboxKey = (userId) => `eldercare.outbox.${userId}`;
const OUTBOX_EVENT = 'eldercare:outbox';

export function readOutbox(userId) {
  try { return JSON.parse(localStorage.getItem(outboxKey(userId))) || []; } catch { return []; }
}
function writeOutbox(userId, items) {
  try { localStorage.setItem(outboxKey(userId), JSON.stringify(items)); } catch { /* storage blocked: nothing to persist */ }
  window.dispatchEvent(new Event(OUTBOX_EVENT));
}
export function queueCheckin(userId, entry) {
  writeOutbox(userId, [...readOutbox(userId), entry]);
}
export const onOutboxChange = (fn) => {
  window.addEventListener(OUTBOX_EVENT, fn);
  window.addEventListener('online', fn);
  window.addEventListener('offline', fn);
  return () => {
    window.removeEventListener(OUTBOX_EVENT, fn);
    window.removeEventListener('online', fn);
    window.removeEventListener('offline', fn);
  };
};

let flushing = null;
/** Sends every queued check-in. Stops at the first network failure; drops entries the server rejects (4xx). */
export function flushOutbox(userId) {
  if (flushing) return flushing;
  flushing = (async () => {
    let sent = 0;
    for (const item of readOutbox(userId)) {
      try {
        await api('/api/checkins', { method: 'POST', body: item.body });
        sent += 1;
      } catch (err) {
        if (err.status === 0 || err.status >= 500 || err.status === 401 || err.status === 429) break; // try again later
      }
      writeOutbox(userId, readOutbox(userId).filter((x) => x.body.idempotencyKey !== item.body.idempotencyKey));
    }
    return sent;
  })().finally(() => { flushing = null; });
  return flushing;
}

/* ------------------------------ medicines ------------------------------ */
export const SLOTS = [
  { key: 'morning', en: 'Morning', fil: 'Umaga', from: 0, to: 12 },
  { key: 'afternoon', en: 'Afternoon', fil: 'Hapon', from: 12, to: 17 },
  { key: 'evening', en: 'Evening', fil: 'Gabi', from: 17, to: 24 },
];
export const slotOf = (time) => {
  const h = Number(time.split(':')[0]);
  return SLOTS.find((s) => h >= s.from && h < s.to).key;
};

/**
 * One row per medicine dose today, with what today's check-ins say about it:
 * missed (named in medication.missed), taken (a check-in after the dose time reported medicines taken),
 * due (time not reached yet) or unknown (time passed, nothing recorded).
 */
export function todaysDoses(meds = [], checkins = []) {
  const today = checkins.filter((c) => isToday(c.recordedAt));
  const nowHm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' }).format(new Date());
  const doses = [];
  for (const m of meds.filter((x) => x.active !== false)) {
    for (const time of m.times.length ? m.times : ['08:00']) {
      const after = today.filter((c) => new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' }).format(new Date(c.recordedAt)) >= time);
      const missed = after.find((c) => (c.medication.missed || []).some((x) => x.toLowerCase().startsWith(m.name.toLowerCase())));
      const taken = after.find((c) => c.medication.taken === true || (c.medication.taken === false && !(c.medication.missed || []).some((x) => x.toLowerCase().startsWith(m.name.toLowerCase()))));
      let status = 'unknown';
      let at = null;
      if (missed) { status = 'missed'; at = missed.recordedAt; } else if (taken) { status = 'taken'; at = taken.recordedAt; } else if (time > nowHm) status = 'due';
      const reason = missed && (missed.medication.missed.find((x) => x.toLowerCase().startsWith(m.name.toLowerCase())) || '').split(' – ')[1];
      doses.push({ id: `${m.id}-${time}`, med: m, time, slot: slotOf(time), status, at, reason });
    }
  }
  return doses.sort((a, b) => a.time.localeCompare(b.time));
}

/* ------------------------------ plain-language alerts ------------------------------ */
const pronoun = (name = '') => (/^lolo\b/i.test(name) ? ['His', 'his', 'him'] : /^lola\b/i.test(name) ? ['Her', 'her', 'her'] : ['Their', 'their', 'them']);

/** The most important anomaly decides the headline: "Blood pressure very high", 186/118 mmHg. */
export function alertHeadline(n) {
  const a = (n.metadata && n.metadata.anomalies) || [];
  const rank = { critical: 3, high: 2, moderate: 1, low: 0 };
  const top = [...a].sort((x, y) => (rank[y.level] || 0) - (rank[x.level] || 0))[0];
  if (!top) return { title: n.title, value: null, unit: null };
  const c = top.code;
  if (c === 'BP_HYPERTENSIVE_CRISIS') return { title: 'Blood pressure very high', fil: 'Napakataas ng presyon', value: top.value, unit: 'mmHg' };
  if (c.startsWith('BP_LOW')) return { title: 'Blood pressure low', fil: 'Mababa ang presyon', value: top.value, unit: 'mmHg' };
  if (c.startsWith('BP_')) return { title: 'Blood pressure high', fil: 'Mataas ang presyon', value: top.value, unit: 'mmHg' };
  if (c.startsWith('SPO2')) return { title: 'Oxygen level low', fil: 'Mababa ang oxygen', value: top.value, unit: '%' };
  if (c.startsWith('TEMP_HYPO')) return { title: 'Body temperature low', fil: 'Mababa ang temperatura', value: top.value, unit: '°C' };
  if (c.startsWith('TEMP')) return { title: 'Fever', fil: 'Lagnat', value: top.value, unit: '°C' };
  if (c.startsWith('HR')) return { title: 'Heart rate unusual', fil: 'Kakaiba ang tibok ng puso', value: top.value, unit: 'bpm' };
  if (c.startsWith('GLUCOSE')) return { title: 'Blood sugar out of range', fil: 'Hindi normal ang blood sugar', value: top.value, unit: 'mg/dL' };
  if (c === 'FALL_REPORTED') return { title: 'Fall reported', fil: 'May naiulat na pagkahulog', value: null };
  if (c === 'MEDICATION_MISSED') return { title: 'Medicine missed', fil: 'Hindi nainom ang gamot', value: top.value, unit: '' };
  if (c === 'MISSED_CHECKIN') return { title: 'No check-in today', fil: 'Walang check-in ngayon', value: null };
  return { title: top.message, value: top.value, unit: '' };
}

/** One or two sentences answering "Why am I seeing this?" from the anomaly codes and the patient's usual values. */
export function explainAlert(n, patient) {
  const name = patient ? shortName(patient.fullName) : 'Your relative';
  const [Her, her] = pronoun(name);
  const base = (patient && patient.baseline) || {};
  const out = [];
  for (const a of (n.metadata && n.metadata.anomalies) || []) {
    const c = a.code;
    if (c.startsWith('BP_') && !out.some((s) => s.includes('blood pressure'))) {
      const usual = base.systolic ? `${Her} usual blood pressure is about ${base.systolic}/${base.diastolic}. ` : '';
      out.push(`${usual}Today it was ${a.value}${c === 'BP_HYPERTENSIVE_CRISIS' ? ', and anything above 180/120 is very high' : c === 'BP_LOW' ? ', which is lower than safe' : ', which is above the healthy range'}.`);
    } else if (c.startsWith('HR')) out.push(`${her.charAt(0).toUpperCase() + her.slice(1)} heart rate was ${a.value} bpm${base.heartRate ? ` (usually about ${base.heartRate})` : ''}.`);
    else if (c.startsWith('SPO2')) out.push(`Oxygen should be 95% or higher; today it was ${a.value}%.`);
    else if (c.startsWith('TEMP')) out.push(`${Her} temperature was ${a.value} °C (normal is about 36.5 to 37.5).`);
    else if (c.startsWith('GLUCOSE')) out.push(`Blood sugar was ${a.value} mg/dL.`);
    else if (c === 'MEDICATION_MISSED') {
      const [med, why] = String(a.value || 'A medicine').split(' – ');
      out.push(`${med} was not taken${why ? ` (${why.toLowerCase()})` : ' as prescribed'}.`);
    }
    else if (c === 'FALL_REPORTED') out.push(`The caregiver reported a fall or near-fall.`);
    else if (c === 'MISSED_CHECKIN') out.push(`No check-in was recorded in the last day.`);
  }
  if (!out.length) return n.message;
  return out.slice(0, 3).join(' ');
}

/** Live warnings while the caregiver types vitals (C2). Mirrors the check-in service thresholds. */
export function vitalsWarning(v) {
  const n = (x) => (x === '' || x == null ? null : Number(x));
  const sys = n(v.systolic); const dia = n(v.diastolic); const spo2 = n(v.spo2); const t = n(v.temperatureC); const hr = n(v.heartRate);
  if ((sys && sys >= 180) || (dia && dia >= 120)) return { tone: 'critical', en: 'Blood pressure looks very high. Re-check after 5 minutes of rest.', fil: 'Napakataas ng presyon. Sukatin muli pagkatapos ng 5 minutong pahinga.' };
  if (spo2 && spo2 < 92) return { tone: 'critical', en: 'Oxygen is low. Re-check, and call the clinic if it stays below 92%.', fil: 'Mababa ang oxygen. Sukatin muli, at tumawag sa klinika kung mababa pa rin sa 92%.' };
  if (t && t >= 39) return { tone: 'critical', en: 'High fever. Give fluids and call the clinic.', fil: 'Mataas na lagnat. Painumin ng tubig at tumawag sa klinika.' };
  if (sys && sys < 90) return { tone: 'high', en: 'Blood pressure looks low. Let them sit or lie down and re-check.', fil: 'Mababa ang presyon. Paupuin o pahigain at sukatin muli.' };
  if ((hr && (hr > 120 || hr < 50))) return { tone: 'high', en: 'Heart rate is outside the safe range. Re-check after resting.', fil: 'Hindi normal ang tibok ng puso. Sukatin muli pagkatapos magpahinga.' };
  if ((sys && sys >= 140) || (dia && dia >= 90) || (t && t >= 37.8) || (spo2 && spo2 < 95)) return { tone: 'moderate', en: 'Some readings are higher than normal. The clinic will see them.', fil: 'May ilang sukat na mas mataas sa normal. Makikita ito ng klinika.' };
  return null;
}

export { manilaDay, hhmm };

/* ------------------------------ instant range checks (C2) ------------------------------ */
// Same limits as the check-in service (services/checkin-service/src/validation.js RANGES): values outside
// them are typos or impossible readings, so the caregiver sees the problem under the field right away.
const VITAL_LIMITS = {
  systolic: [50, 300, 'mmHg', 'Top number', 'Itaas na numero'],
  diastolic: [30, 200, 'mmHg', 'Bottom number', 'Ibabang numero'],
  heartRate: [20, 250, 'bpm', 'Heart rate', 'Tibok ng puso'],
  temperatureC: [30, 45, '°C', 'Body temperature', 'Temperatura'],
  spo2: [50, 100, '%', 'Oxygen', 'Oxygen'],
  bloodGlucose: [20, 800, 'mg/dL', 'Blood sugar', 'Blood sugar'],
};

/**
 * @param {{pair?: boolean}} [opts] pair: also require both blood-pressure numbers (checked when moving on,
 *        not while the caregiver is still typing the first one)
 * @returns {Record<string, {en:string, fil:string}>} one message per field that is wrong
 */
export function vitalErrors(v, { pair = false } = {}) {
  const errors = {};
  for (const [k, [min, max, unit]] of Object.entries(VITAL_LIMITS)) {
    const raw = v[k];
    if (raw === '' || raw == null) continue;
    const n = Number(raw);
    if (!Number.isFinite(n)) errors[k] = { en: 'Numbers only.', fil: 'Numero lang.' };
    else if (n < 0) errors[k] = { en: 'Cannot be negative.', fil: 'Hindi puwedeng negatibo.' };
    else if (n < min || n > max) errors[k] = { en: `Must be ${min}–${max} ${unit}. Check the reading again.`, fil: `Dapat ${min}–${max} ${unit}. Tingnan muli ang sukat.` };
  }
  const sys = v.systolic === '' ? null : Number(v.systolic);
  const dia = v.diastolic === '' ? null : Number(v.diastolic);
  if (!errors.systolic && !errors.diastolic) {
    if (pair && (sys == null) !== (dia == null)) {
      errors[sys == null ? 'systolic' : 'diastolic'] = { en: 'Enter both blood pressure numbers.', fil: 'Ilagay ang dalawang numero ng presyon.' };
    } else if (sys != null && dia >= sys) {
      errors.diastolic = { en: 'The bottom number must be lower than the top number.', fil: 'Dapat mas mababa ang ibabang numero.' };
    }
  }
  return errors;
}

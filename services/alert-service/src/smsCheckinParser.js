'use strict';

/**
 * SMS check-in fallback parser (Section 20, Risk 3 - caregivers without mobile internet).
 * Pure function, unit tested in test/smsCheckinParser.test.js.
 *
 * Caregivers text the TextBee gateway phone number, e.g.
 *   CHECKIN P-1001 BP 150/90 HR 80 T 36.8 O2 96 MED Y
 *   checkin bp 120/80 pulse 72 meds no note masakit ang ulo
 *   CHECKIN P-1002 FALL
 *
 * Keywords (any order, case-insensitive):
 *   BP <sys>/<dia>    HR|PULSE <n>    T|TEMP <c>    O2|SPO2 <n>    SUGAR|GLU <n>
 *   MED|MEDS Y|N      FALL            CONFUSED      NOTE <free text to end of message>
 * The patient id may be left out when the caregiver looks after exactly one patient.
 */
const HELP_TEXT = 'ElderCare check-in format: CHECKIN P-1001 BP 120/80 HR 72 T 36.8 O2 97 MED Y (optional: FALL, CONFUSED, NOTE text). Reply HELP for this message.';

const YES = ['Y', 'YES', 'OO', 'OK', 'TAKEN', '1'];
const NO = ['N', 'NO', 'HINDI', 'MISSED', 'SKIP', '0'];

function parseSmsCheckin(text, allowedPatients = []) {
  const raw = String(text || '').trim();
  if (!raw || /^(HELP|TULONG|\?)$/i.test(raw)) return { ok: false, help: true, errors: [] };

  let body = raw.replace(/^(CHECKIN|CHECK-IN|CHECK IN|CI)\b[:\s]*/i, '');
  let notes;
  const noteIdx = body.search(/\bNOTES?\b/i);
  if (noteIdx >= 0) {
    notes = body.slice(noteIdx).replace(/^NOTES?\b[:\s]*/i, '').trim() || undefined;
    body = body.slice(0, noteIdx);
  }

  const tokens = body.split(/[\s,;]+/).filter(Boolean);
  const vitals = {};
  const out = { medication: {}, errors: [] };
  let patientId;

  for (let i = 0; i < tokens.length; i += 1) {
    const t = tokens[i].toUpperCase();
    const next = tokens[i + 1];
    const num = (v) => (v !== undefined && /^\d+(\.\d+)?$/.test(v) ? Number(v) : NaN);

    if (/^P-[A-Z0-9_-]+$/i.test(tokens[i])) { patientId = tokens[i].toUpperCase(); continue; }
    switch (t) {
      case 'BP': {
        const m = /^(\d{2,3})\/(\d{2,3})$/.exec(next || '');
        if (m) { vitals.systolic = Number(m[1]); vitals.diastolic = Number(m[2]); i += 1; } else out.errors.push('BP must look like 120/80');
        break;
      }
      case 'HR': case 'PULSE': {
        const n = num(next); if (Number.isNaN(n)) out.errors.push('HR needs a number'); else { vitals.heartRate = n; i += 1; }
        break;
      }
      case 'T': case 'TEMP': {
        const n = num(next); if (Number.isNaN(n)) out.errors.push('TEMP needs a number'); else { vitals.temperatureC = n; i += 1; }
        break;
      }
      case 'O2': case 'SPO2': case 'SP02': {
        const n = num(next); if (Number.isNaN(n)) out.errors.push('O2 needs a number'); else { vitals.spo2 = n; i += 1; }
        break;
      }
      case 'SUGAR': case 'GLU': case 'GLUCOSE': {
        const n = num(next); if (Number.isNaN(n)) out.errors.push('SUGAR needs a number'); else { vitals.bloodGlucose = n; i += 1; }
        break;
      }
      case 'MED': case 'MEDS': {
        const v = String(next || '').toUpperCase();
        if (YES.includes(v)) { out.medication.taken = true; i += 1; } else if (NO.includes(v)) { out.medication.taken = false; i += 1; } else out.errors.push('MED must be Y or N');
        break;
      }
      case 'FALL': case 'NAHULOG': out.mobilityStatus = 'fall_reported'; break;
      case 'CONFUSED': out.mood = 'confused'; break;
      default: out.errors.push(`Unknown word "${tokens[i]}"`);
    }
  }

  if (!patientId) {
    if (allowedPatients.length === 1) [patientId] = allowedPatients;
    else out.errors.push(`Add the patient ID (${allowedPatients.join(' or ') || 'e.g. P-1001'})`);
  }

  if (out.errors.length) return { ok: false, help: false, errors: out.errors };

  const checkin = { patientId, vitals };
  if (out.medication.taken !== undefined) checkin.medication = out.medication;
  if (out.mobilityStatus) checkin.mobilityStatus = out.mobilityStatus;
  if (out.mood) checkin.mood = out.mood;
  if (notes) checkin.notes = notes.slice(0, 2000);
  return { ok: true, checkin };
}

module.exports = { parseSmsCheckin, HELP_TEXT };

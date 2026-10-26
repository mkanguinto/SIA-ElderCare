// Display helpers: times, vitals and human-readable labels.

export const ROLE_LABEL = {
  caregiver: 'Caregiver',
  family_member: 'Family member',
  clinic_staff: 'Clinic nurse',
  system_admin: 'Health center administrator',
};

export const STATUS_LABEL = {
  open: 'New',
  in_review: 'In review',
  scheduled: 'Visit scheduled',
  resolved: 'Resolved',
  dismissed: 'Dismissed',
};

export const REASON_LABEL = {
  health_anomaly: 'Health alert',
  missed_checkin: 'Missed check-in',
  environmental_risk: 'Weather risk',
  emr_enrichment: 'Clinic records',
  vitals_normal: 'Normal check-in',
};

export const VISIT_TYPE_LABEL = { home_visit: 'Home visit', clinic_visit: 'Clinic visit', teleconsult: 'Teleconsult' };
export const VISIT_STATUS_LABEL = { scheduled: 'Scheduled', completed: 'Completed', cancelled: 'Cancelled', no_show: 'No show' };
export const CATEGORY_LABEL = { urgent: 'Urgent', high: 'High', watch: 'Watch', routine: 'Routine' };

/** Today's date in Manila as YYYY-MM-DD (for date inputs). */
export function todayManila(offsetDays = 0) {
  const d = new Date(Date.now() + 8 * 3600000 + offsetDays * 86400000);
  return d.toISOString().slice(0, 10);
}

/** "Thu, Oct 15 at 9:30 AM" from a visit's local date + time. */
export function visitWhen(v) {
  if (!v) return '';
  const d = new Date(`${v.visitDate}T${v.visitTime}:00+08:00`);
  return d.toLocaleString('en-PH', { timeZone: 'Asia/Manila', weekday: 'short', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export const SEVERITY_LABEL = { none: 'Normal', low: 'Low', moderate: 'Moderate', high: 'High', critical: 'Critical' };

export const PRIORITY_LABEL = { P1: 'Urgent', P2: 'High', P3: 'Watch', P4: 'Routine' };

export const CONDITION_LABEL = {
  hypertension: 'Hypertension',
  cardiovascular: 'Heart disease',
  heart_disease: 'Heart disease',
  diabetes: 'Diabetes',
  copd: 'COPD',
  osteoarthritis: 'Osteoarthritis',
  kidney_disease: 'Kidney disease',
  stroke: 'Stroke history',
  dementia: 'Dementia',
};

export const conditionLabel = (c) => CONDITION_LABEL[c] || c.replace(/_/g, ' ');

const TZ = { timeZone: 'Asia/Manila' };

export function dateTime(ts) {
  if (!ts) return '';
  return new Date(ts).toLocaleString('en-PH', { ...TZ, month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

export function shortDate(ts) {
  return new Date(ts).toLocaleDateString('en-PH', { ...TZ, month: 'short', day: 'numeric' });
}

export function relTime(ts) {
  if (!ts) return 'never';
  const diff = (Date.now() - new Date(ts).getTime()) / 1000;
  if (diff < 45) return 'just now';
  if (diff < 3600) return `${Math.round(diff / 60)} min ago`;
  if (diff < 86400) {
    const h = Math.round(diff / 3600);
    return `${h} hour${h === 1 ? '' : 's'} ago`;
  }
  if (diff < 172800) return 'yesterday';
  return shortDate(ts);
}

export function age(birthDate) {
  if (!birthDate) return null;
  const b = new Date(birthDate);
  const n = new Date();
  let a = n.getFullYear() - b.getFullYear();
  if (n.getMonth() < b.getMonth() || (n.getMonth() === b.getMonth() && n.getDate() < b.getDate())) a -= 1;
  return a;
}

export const bp = (v) => (v && v.systolic ? `${v.systolic}/${v.diastolic}` : '–');

export const initials = (name = '') => name.replace(/,.*$/, '').split(/\s+/).filter(Boolean).slice(0, 2).map((w) => w[0].toUpperCase()).join('');

/** Which vital an anomaly code refers to, so the UI can flag the right reading. */
export function vitalOf(code = '') {
  if (code.startsWith('BP_')) return 'bp';
  if (code.startsWith('HR_')) return 'hr';
  if (code.startsWith('TEMP_')) return 'temp';
  if (code.startsWith('SPO2_')) return 'spo2';
  if (code.startsWith('GLUCOSE_')) return 'glucose';
  return null;
}

const FIELD_LABEL = {
  'vitals.systolic': 'Top blood pressure number',
  'vitals.diastolic': 'Bottom blood pressure number',
  'vitals.heartRate': 'Heart rate',
  'vitals.temperatureC': 'Temperature',
  'vitals.spo2': 'Oxygen (SpO₂)',
  'vitals.bloodGlucose': 'Blood sugar',
  'medication.missed': 'Missed medicines',
  recordedAt: 'Check-in time',
  notes: 'Notes',
};

/** Turns API validation messages into wording a caregiver understands. */
export function friendlyError(msg = '') {
  let out = msg;
  for (const [field, label] of Object.entries(FIELD_LABEL)) out = out.split(field).join(label);
  out = out
    .replace('Top blood pressure number and Bottom blood pressure number must be provided together', 'Enter both blood pressure numbers')
    .replace('Bottom blood pressure number must be lower than Top blood pressure number', 'The bottom blood pressure number must be lower than the top number')
    .replace('Provide at least one vital sign, medication status, mobility status or note', 'Enter at least one reading or a note');
  return out.charAt(0).toUpperCase() + out.slice(1);
}


// Care plan (Batch 4): caregiver duty categories and checklist states
export const DUTY_CATEGORY_LABEL = {
  personal_care: 'Personal care',
  physical_medical: 'Physical and medical care',
  meals_household: 'Meals and household',
  transportation: 'Transportation',
  emotional_social: 'Emotional and social support',
  home_safety: 'Home safety',
  communication: 'Communication',
  records: 'Records',
};
export const DUTY_STATUS_LABEL = { done: 'Done', skipped: 'Skipped', pending: 'To do', overdue: 'Overdue', missed: 'Missed' };
export const FREQUENCY_LABEL = { daily: 'Every day', weekly: 'Weekly', once: 'One time', as_needed: 'As needed' };
export const WEEKDAY_SHORT = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** "Every day at 08:00, 20:00" / "Mon, Thu" / "Due 2026-10-29" / "As needed" */
export function dutySchedule(t) {
  if (t.frequency === 'daily') return `Every day at ${t.times.join(', ')}`;
  if (t.frequency === 'weekly') return `${t.daysOfWeek.map((d) => WEEKDAY_SHORT[d]).join(', ')}${t.times.length ? ` at ${t.times.join(', ')}` : ''}`;
  if (t.frequency === 'once') return `Due ${t.dueDate}`;
  return 'As needed';
}

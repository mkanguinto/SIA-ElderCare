'use strict';

/**
 * Care-plan scheduling - pure functions (no I/O), unit tested in test/schedule.test.js.
 *
 * A task repeats by `frequency`:
 *   daily      every day at each of `times` ("08:00", "20:00")
 *   weekly     on `daysOfWeek` (0 = Sunday) at each of `times`, or once that day when no times are set
 *   once       on `dueDate`; if not done, it stays on today's list as overdue until it is
 *   as_needed  never scheduled; the caregiver logs it whenever it happens
 * Each occurrence is a "slot" identified by (task, date, slot) where slot is "HH:MM" or "any".
 */
const { CATEGORY_CODES } = require('./catalog');
const { source: planSource } = require('./planContent');

const FREQUENCIES = ['daily', 'weekly', 'once', 'as_needed'];
// Readings a measurement task asks for (the same vital signs as the check-in).
const MEASUREMENTS = ['bp', 'heart_rate', 'temperature', 'spo2', 'blood_glucose'];
const TIME_RE = /^([01]\d|2[0-3]):[0-5]\d$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const ANY = 'any';
// A timed slot becomes "overdue" this long after its time if nobody has ticked it.
const OVERDUE_AFTER_MIN = Number(process.env.CARE_OVERDUE_AFTER_MINUTES || 120);

const isDate = (v) => typeof v === 'string' && DATE_RE.test(v) && !Number.isNaN(Date.parse(`${v}T00:00:00Z`)) && new Date(`${v}T00:00:00Z`).toISOString().startsWith(v);

/**
 * Validates a task for POST (full) or PATCH (partial, merged over `existing`).
 * @returns {{errors:string[], value:object}} value uses the API's camelCase names
 */
function validateTask(body, { partial = false, existing = null } = {}) {
  const b = body && typeof body === 'object' && !Array.isArray(body) ? body : {};
  const errors = [];
  const allowed = ['category', 'title', 'instructions', 'frequency', 'times', 'daysOfWeek', 'dueDate', 'startDate', 'endDate', 'active',
    'kind', 'measurement', 'specialised', 'source'];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) errors.push(`unknown field(s): ${unknown.join(', ')}`);
  const has = (k) => b[k] !== undefined;
  const value = {};

  if (!partial || has('category')) {
    if (!CATEGORY_CODES.includes(b.category)) errors.push(`category must be one of: ${CATEGORY_CODES.join(', ')}`);
    else value.category = b.category;
  }
  if (!partial || has('title')) {
    const t = typeof b.title === 'string' ? b.title.trim() : '';
    if (t.length < 3 || t.length > 160) errors.push('title must be 3-160 characters');
    else value.title = t;
  }
  if (has('instructions')) {
    if (b.instructions !== null && (typeof b.instructions !== 'string' || b.instructions.length > 1000)) errors.push('instructions must be at most 1000 characters');
    else value.instructions = b.instructions ? b.instructions.trim() : null;
  }
  if (!partial || has('frequency')) {
    if (!FREQUENCIES.includes(b.frequency)) errors.push(`frequency must be one of: ${FREQUENCIES.join(', ')}`);
    else value.frequency = b.frequency;
  }
  if (has('times')) {
    if (!Array.isArray(b.times) || b.times.length > 8 || b.times.some((t) => !TIME_RE.test(t))) errors.push('times must be up to 8 times as HH:MM (24-hour)');
    else value.times = [...new Set(b.times)].sort();
  }
  if (has('daysOfWeek')) {
    if (!Array.isArray(b.daysOfWeek) || b.daysOfWeek.some((d) => !Number.isInteger(d) || d < 0 || d > 6)) errors.push('daysOfWeek must be numbers 0 (Sunday) to 6 (Saturday)');
    else value.daysOfWeek = [...new Set(b.daysOfWeek)].sort();
  }
  for (const k of ['dueDate', 'startDate', 'endDate']) {
    if (has(k)) {
      if (b[k] !== null && !isDate(b[k])) errors.push(`${k} must be YYYY-MM-DD`);
      else value[k] = b[k];
    }
  }
  if (has('active')) {
    if (typeof b.active !== 'boolean') errors.push('active must be true or false');
    else value.active = b.active;
  }
  if (has('kind')) {
    if (!['task', 'measurement'].includes(b.kind)) errors.push('kind must be task or measurement');
    else value.kind = b.kind;
  }
  if (has('measurement')) {
    if (b.measurement !== null && !MEASUREMENTS.includes(b.measurement)) errors.push(`measurement must be one of: ${MEASUREMENTS.join(', ')}`);
    else value.measurement = b.measurement;
  }
  if (has('specialised')) {
    if (typeof b.specialised !== 'boolean') errors.push('specialised must be true or false');
    else value.specialised = b.specialised;
  }
  if (has('source')) {
    if (b.source === null) value.source = null;
    else {
      const srcErrors = [];
      value.source = planSource(b.source, 'source', srcErrors);
      errors.push(...srcErrors.map((e) => e.replace(/^source\.source/, 'source')));
    }
  }

  // Cross-field rules on the merged result.
  const m = { times: [], daysOfWeek: [], dueDate: null, startDate: null, endDate: null, ...(existing || {}), ...value };
  if (!errors.length) {
    if (m.frequency === 'daily' && !m.times.length) errors.push('daily tasks need at least one time');
    if (m.frequency === 'weekly' && !m.daysOfWeek.length) errors.push('weekly tasks need daysOfWeek');
    if (m.frequency === 'once' && !m.dueDate) errors.push('one-time tasks need a dueDate');
    if (m.startDate && m.endDate && m.endDate < m.startDate) errors.push('endDate must be on or after startDate');
    if (m.kind === 'measurement' && !m.measurement) errors.push(`measurement tasks need measurement (${MEASUREMENTS.join(', ')})`);
    if (m.kind !== 'measurement' && m.measurement) errors.push('measurement is only for measurement tasks');
    // Specialised care (e.g. a therapeutic diet, wound care) needs a clinical source, not only the nurse's assessment.
    if (m.specialised && !(m.source && m.source.type && m.source.type !== 'nurse_assessment')) errors.push('specialised tasks need a clinical source (source.type other than nurse_assessment)');
  }
  if (partial && !errors.length && !Object.keys(value).length) errors.push('nothing to update');
  return { errors, value };
}

/** Local calendar date and minutes-since-midnight at `now` for a UTC offset such as "+08:00". */
function localNow(offset = '+08:00', now = new Date()) {
  const m = /^([+-])(\d{2}):(\d{2})$/.exec(offset) || ['', '+', '08', '00'];
  const shift = (m[1] === '-' ? -1 : 1) * (Number(m[2]) * 60 + Number(m[3]));
  const local = new Date(now.getTime() + shift * 60000);
  return { date: local.toISOString().slice(0, 10), minutes: local.getUTCHours() * 60 + local.getUTCMinutes() };
}

const dayOfWeek = (date) => new Date(`${date}T00:00:00Z`).getUTCDay();
const toMinutes = (hhmm) => Number(hhmm.slice(0, 2)) * 60 + Number(hhmm.slice(3, 5));

function addDays(date, n) {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

/** Is the task in effect on this date (active, inside its start/end dates)? */
function inEffect(task, date) {
  if (!task.active) return false;
  if (task.startDate && date < task.startDate) return false;
  if (task.endDate && date > task.endDate) return false;
  return true;
}

/** Scheduled slots of one recurring task on one date ("once" handled by buildChecklist). */
function slotsOn(task, date) {
  if (!inEffect(task, date)) return [];
  if (task.frequency === 'daily') return task.times;
  if (task.frequency === 'weekly') return task.daysOfWeek.includes(dayOfWeek(date)) ? (task.times.length ? task.times : [ANY]) : [];
  return [];
}

/**
 * The checklist for one date.
 * @param {object[]} tasks         active and inactive tasks of the plan (camelCase DTOs)
 * @param {object[]} completions   rows for this date: {taskId, slot, status, completedBy, completedAt, note}
 * @param {string} date            YYYY-MM-DD
 * @param {{date:string, minutes:number}} now  localNow()
 * @param {Set<string>} onceDone   ids of one-time tasks already done on any date
 */
function buildChecklist(tasks, completions, date, now, onceDone = new Set()) {
  const done = new Map(completions.map((c) => [`${c.taskId}|${c.slot}`, c]));
  const items = [];
  const push = (task, slot, extra = {}) => {
    const c = done.get(`${task.id}|${slot}`);
    let status = c ? c.status : 'pending';
    if (!c) {
      if (date < now.date) status = 'missed';
      else if (date === now.date && slot !== ANY && now.minutes > toMinutes(slot) + OVERDUE_AFTER_MIN) status = 'overdue';
    }
    items.push({
      taskId: task.id, category: task.category, title: task.title, instructions: task.instructions || null,
      frequency: task.frequency, slot, status, completion: c || null, ...extra,
    });
  };

  for (const task of tasks) {
    if (task.frequency === 'once') {
      if (!task.active) continue;
      if (task.dueDate === date) push(task, ANY, { dueDate: task.dueDate });
      // Not done by its due date: carry it to today's list as overdue until someone does it.
      else if (date === now.date && task.dueDate < date && !onceDone.has(task.id)) push(task, ANY, { dueDate: task.dueDate, carriedOver: true });
    } else {
      for (const slot of slotsOn(task, date)) push(task, slot);
    }
  }
  items.sort((a, b) => (a.slot === b.slot ? a.title.localeCompare(b.title) : a.slot === ANY ? 1 : b.slot === ANY ? -1 : a.slot.localeCompare(b.slot)));

  const asNeeded = tasks.filter((t) => t.frequency === 'as_needed' && inEffect(t, date)).map((t) => ({
    taskId: t.id, category: t.category, title: t.title, instructions: t.instructions || null,
    loggedToday: completions.filter((c) => c.taskId === t.id).length,
  }));
  const count = (s) => items.filter((i) => i.status === s).length;
  return {
    date,
    // Nothing is assumed: a slot without a report stays pending, overdue or missed (no report), never done.
    summary: { total: items.length, done: count('done'), notDone: count('not_done'), notApplicable: count('not_applicable'), skipped: count('skipped'),
      pending: count('pending'), overdue: count('overdue'), missed: count('missed') },
    items,
    asNeeded,
  };
}

/**
 * Adherence per category over [from, to] for recurring tasks (daily / weekly / once).
 * done / scheduled, where not done, skipped and missed count as not done and not applicable is left out.
 */
function adherence(tasks, completions, from, to) {
  const doneKeys = new Set(completions.filter((c) => c.status === 'done').map((c) => `${c.taskId}|${c.date}|${c.slot}`));
  // A slot the caregiver marked "not applicable" (e.g. the elder was in hospital) is not counted either way.
  const naKeys = new Set(completions.filter((c) => c.status === 'not_applicable').map((c) => `${c.taskId}|${c.date}|${c.slot}`));
  const per = {};
  const bump = (cat, isDone) => {
    per[cat] = per[cat] || { scheduled: 0, done: 0 };
    per[cat].scheduled += 1;
    if (isDone) per[cat].done += 1;
  };
  for (let d = from; d <= to; d = addDays(d, 1)) {
    for (const t of tasks) {
      if (t.frequency === 'once') {
        if (t.active && t.dueDate === d) bump(t.category, completions.some((c) => c.taskId === t.id && c.status === 'done'));
        continue;
      }
      for (const slot of slotsOn(t, d)) if (!naKeys.has(`${t.id}|${d}|${slot}`)) bump(t.category, doneKeys.has(`${t.id}|${d}|${slot}`));
    }
  }
  const categories = Object.entries(per).map(([category, v]) => ({ category, ...v, rate: v.scheduled ? Math.round((v.done / v.scheduled) * 100) : null }));
  const scheduled = categories.reduce((n, c) => n + c.scheduled, 0);
  const doneTotal = categories.reduce((n, c) => n + c.done, 0);
  return { from, to, scheduled, done: doneTotal, rate: scheduled ? Math.round((doneTotal / scheduled) * 100) : null, categories };
}

module.exports = {
  FREQUENCIES, MEASUREMENTS, ANY, TIME_RE, isDate, validateTask, localNow, addDays, slotsOn, buildChecklist, adherence,
};

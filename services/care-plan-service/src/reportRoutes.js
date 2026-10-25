'use strict';

/**
 * Caregiver medicine reports and nurse review of caregiver reports (v3).
 *
 *   POST /api/patients/:id/medication-reports            caregiver (own elder)  Taken / Not taken / Unknown for a dose
 *   GET  /api/patients/:id/medication-reports?from=&to=   caregiver/family (own), clinic
 *   GET  /api/patients/:id/care-reports?view=attention|all&from=&to=   clinic   task + medicine reports for review
 *   GET  /api/care-reports/attention                      clinic   unreviewed reports that need a look, all elders
 *   POST /api/care-reports/:type/:id/review               care-team nurse  {note}  records the review (once)
 *
 * A medicine report is what the caregiver said, not proof that the dose was given. A dose with no report stays
 * "not reported"; nothing is assumed taken. Reviewing a report records that a nurse looked at it and what they
 * did; it does not resolve a concern, which is closed separately (clinic service).
 */
const express = require('express');
const { pool, withTransaction } = require('./db');
const logger = require('./lib/logger');
const schedule = require('./schedule');
const { medicationsOf } = require('./peers');

const router = express.Router();
const TZ = () => process.env.CARE_TZ_OFFSET || process.env.VISIT_TZ_OFFSET || '+08:00';
const LATE_LOG_DAYS = () => Number(process.env.CARE_LATE_LOG_DAYS || 7);
const PATIENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PRN = 'prn';
const MED_STATUS = ['taken', 'not_taken', 'unknown'];
const isIso = (v) => typeof v === 'string' && !Number.isNaN(Date.parse(v)) && /\d{4}-\d{2}-\d{2}T/.test(v);

const forbid = (res, message) => res.status(403).json({ error: 'forbidden', message });
const canSee = (req, patientId) => req.user && (req.user.role === 'clinic_staff'
  || (['caregiver', 'family_member'].includes(req.user.role) && req.user.patients.includes(patientId)));

/** Is this prescription record the one to give on this date? */
function medicationOn(m, date) {
  const start = m.startDate || '0000-01-01';
  if (date < start) return false;
  if (m.endDate && date > m.endDate) return false;
  if (!m.active) {
    const stopped = m.stoppedAt ? String(m.stoppedAt).slice(0, 10) : m.updatedAt ? String(m.updatedAt).slice(0, 10) : null;
    if (!stopped || date >= stopped) return false;
  }
  return true;
}

/** What the caregiver is shown of a prescription (and what is kept with a report). */
function medView(m) {
  return JSON.parse(JSON.stringify({
    id: m.id, name: m.name, strength: m.strength || null, dose: m.dose || null, dosage: m.dosage, route: m.route || null,
    frequency: m.frequency, times: m.times || [], foodInstructions: m.foodInstructions || null, instructions: m.instructions || null,
    // Only instructions that came from a verified clinical source are shown for a missed or refused dose.
    missedDoseInstructions: m.missedDoseInstructions && m.verification ? m.missedDoseInstructions : null,
    startDate: m.startDate || null, endDate: m.endDate || null, verified: Boolean(m.verification), sourceRecorded: Boolean(m.source),
    supersedesId: m.supersedesId || null,
  }));
}

function toReportDto(r) {
  return {
    id: r.id, patientId: r.patient_id, medicationId: r.medication_id, medication: r.medication, date: r.scheduled_for, slot: r.slot,
    status: r.status, actualTime: r.actual_time, reason: r.reason, reportedBy: r.reported_by, reportedAt: r.reported_at,
    recordedAt: r.client_recorded_at, seenPlanVersion: r.seen_plan_version, versionMismatch: r.version_mismatch, recordMismatch: r.record_mismatch,
    review: r.reviewed_at ? { by: r.reviewed_by, byName: r.reviewed_by_name, at: r.reviewed_at, note: r.review_note } : null,
  };
}

/**
 * Medicine doses for the checklist of one date: one row per scheduled time of each prescription in effect, plus
 * the as-needed / unscheduled ones. A dose nobody reported is "not_reported" (never assumed taken).
 * @returns {Promise<{doses:object[], asNeeded:object[], error?:string}>}
 */
async function medicationChecklist(req, patientId, date) {
  let meds;
  try { meds = await medicationsOf(req, patientId); } catch (err) {
    return { doses: [], asNeeded: [], error: err.message };
  }
  const { rows } = await pool.query('SELECT * FROM medication_reports WHERE patient_id = $1 AND scheduled_for = $2 ORDER BY reported_at', [patientId, date]);
  const reports = rows.map(toReportDto);
  const doses = [];
  const asNeeded = [];
  for (const m of meds.filter((x) => medicationOn(x, date))) {
    const view = medView(m);
    if (!(m.times || []).length) {
      asNeeded.push({ medication: view, reports: reports.filter((r) => r.medicationId === m.id && r.slot === PRN) });
      continue;
    }
    for (const t of m.times) {
      let report = reports.find((r) => r.medicationId === m.id && r.slot === t) || null;
      // Revised during the day: a dose already reported under the replaced prescription stays reported, so the
      // caregiver is not asked (and does not give) the same dose again.
      if (!report && m.supersedesId) {
        const earlier = reports.find((r) => r.medicationId === m.supersedesId && r.slot === t);
        if (earlier) report = { ...earlier, reportedForPrevious: true };
      }
      doses.push({ medication: view, slot: t, status: report ? report.status : 'not_reported', report });
    }
  }
  doses.sort((a, b) => a.slot.localeCompare(b.slot) || a.medication.name.localeCompare(b.medication.name));
  const count = (s) => doses.filter((d) => d.status === s).length;
  return { doses, asNeeded, summary: { total: doses.length, taken: count('taken'), notTaken: count('not_taken'), unknown: count('unknown'), notReported: count('not_reported') } };
}

/** The plan version in effect on a date (for the version-difference flag). */
async function versionOn(patientId, date) {
  const { rows: [v] } = await pool.query(
    `SELECT v.id, v.version FROM care_plan_versions v
      WHERE v.patient_id = $1 AND v.status IN ('active', 'superseded') AND (v.effective_date IS NULL OR v.effective_date <= $2)
        AND (v.superseded_by IS NULL OR (SELECT n.effective_date FROM care_plan_versions n WHERE n.id = v.superseded_by) > $2)
      ORDER BY v.version DESC LIMIT 1`, [patientId, date],
  );
  return v || null;
}

/** Validates the time fields every caregiver report shares. */
function reportTiming(b, now, errors) {
  const date = b.date || now.date;
  if (!schedule.isDate(date)) errors.push('date must be YYYY-MM-DD');
  else if (date > now.date) errors.push('date cannot be in the future');
  else if (date < schedule.addDays(now.date, -LATE_LOG_DAYS())) errors.push(`reports can be made up to ${LATE_LOG_DAYS()} days late`);
  let recordedAt = null;
  if (b.recordedAt !== undefined && b.recordedAt !== null) {
    if (!isIso(b.recordedAt)) errors.push('recordedAt must be an ISO-8601 time (when the caregiver recorded it on the phone)');
    else if (Date.parse(b.recordedAt) > Date.now() + 5 * 60000) errors.push('recordedAt cannot be in the future');
    else recordedAt = b.recordedAt;
  }
  let seen = null;
  if (b.planVersion !== undefined && b.planVersion !== null) {
    if (!Number.isInteger(b.planVersion) || b.planVersion < 1) errors.push('planVersion must be the plan version number shown to the caregiver');
    else seen = b.planVersion;
  }
  return { date, recordedAt, seen };
}

/* ------------------------------- medicine reports ------------------------------- */
router.post('/api/patients/:id/medication-reports', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!PATIENT_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    if (!req.user || req.user.role !== 'caregiver') return forbid(res, "Only the elder's caregiver reports medicine doses");
    if (!req.user.patients.includes(patientId)) return forbid(res, 'You are not assigned to this patient');
    const b = req.body || {};
    const errors = [];
    const now = schedule.localNow(TZ());
    const { date, recordedAt, seen } = reportTiming(b, now, errors);
    if (!Number.isInteger(b.medicationId)) errors.push('medicationId is required');
    if (!MED_STATUS.includes(b.status)) errors.push(`status must be one of: ${MED_STATUS.join(', ')}`);
    if (b.reason !== undefined && b.reason !== null && (typeof b.reason !== 'string' || b.reason.length > 300)) errors.push('reason must be at most 300 characters');
    let actualTime = null;
    if (b.actualTime !== undefined && b.actualTime !== null) {
      if (b.status !== 'taken') errors.push('actualTime is only for a dose reported as taken');
      else if (!isIso(b.actualTime)) errors.push('actualTime must be an ISO-8601 time');
      else if (Date.parse(b.actualTime) > Date.now() + 5 * 60000) errors.push('actualTime cannot be in the future');
      else actualTime = b.actualTime;
    }
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    const meds = await medicationsOf(req, patientId);
    const m = meds.find((x) => x.id === b.medicationId);
    if (!m) return res.status(404).json({ error: 'not_found', message: 'This medicine is not in the elder\'s prescription records' });
    const scheduled = m.times || [];
    const slot = scheduled.length ? b.slot : PRN;
    if (scheduled.length && !scheduled.includes(slot)) {
      return res.status(422).json({ error: 'validation_failed', details: [`slot must be one of the prescribed times: ${scheduled.join(', ')}`] });
    }
    // Recorded offline against a prescription that has since changed or ended: kept as reported, flagged.
    const recordMismatch = !medicationOn(m, date);
    const version = await versionOn(patientId, date);
    const versionMismatch = Boolean(seen && version && seen !== version.version);
    const params = [patientId, m.id, JSON.stringify(medView(m)), date, slot, b.status, actualTime, b.reason ? b.reason.trim() : null, req.user.id,
      recordedAt, version ? version.id : null, seen, versionMismatch, recordMismatch];

    const row = await withTransaction(async (c) => {
      if (slot !== PRN) {
        const { rows: [prev] } = await c.query('SELECT * FROM medication_reports WHERE medication_id = $1 AND scheduled_for = $2 AND slot = $3 FOR UPDATE', [m.id, date, slot]);
        if (prev) {
          // A correction keeps what was reported before.
          await c.query('INSERT INTO report_revisions (report_type, report_id, previous, changed_by) VALUES ($1,$2,$3,$4)', ['medication', prev.id, JSON.stringify(toReportDto(prev)), req.user.id]);
          const { rows: [r] } = await c.query(
            `UPDATE medication_reports SET medication = $3, status = $4, actual_time = $5, reason = $6, reported_by = $7, reported_at = now(), client_recorded_at = $8,
                    plan_version_id = $9, seen_plan_version = $10, version_mismatch = $11, record_mismatch = $12,
                    reviewed_by = NULL, reviewed_by_name = NULL, reviewed_at = NULL, review_note = NULL
              WHERE id = $1 AND patient_id = $2 RETURNING *, FALSE AS inserted`,
            [prev.id, patientId, params[2], params[5], params[6], params[7], params[8], params[9], params[10], params[11], params[12], params[13]],
          );
          return r;
        }
      }
      const { rows: [r] } = await c.query(
        `INSERT INTO medication_reports (patient_id, medication_id, medication, scheduled_for, slot, status, actual_time, reason, reported_by,
                                         client_recorded_at, plan_version_id, seen_plan_version, version_mismatch, record_mismatch)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *, TRUE AS inserted`, params,
      );
      return r;
    });
    logger.info('medication reported', { patientId, medicationId: m.id, date, slot, status: row.status, by: req.user.id, versionMismatch, recordMismatch });
    return res.status(row.inserted ? 201 : 200).json(toReportDto(row));
  } catch (err) {
    if (err.status === 503) return res.status(503).json({ error: 'dependency_unavailable', message: err.message });
    return next(err);
  }
});

router.get('/api/patients/:id/medication-reports', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!PATIENT_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    if (!canSee(req, patientId)) return forbid(res, 'You are not assigned to this patient');
    const now = schedule.localNow(TZ());
    const to = req.query.to || now.date;
    const from = req.query.from || schedule.addDays(to, -6);
    if (!schedule.isDate(from) || !schedule.isDate(to) || from > to || schedule.addDays(from, 31) <= to) {
      return res.status(422).json({ error: 'validation_failed', details: ['from and to must be YYYY-MM-DD, at most 31 days apart'] });
    }
    const { rows } = await pool.query('SELECT * FROM medication_reports WHERE patient_id = $1 AND scheduled_for BETWEEN $2 AND $3 ORDER BY scheduled_for DESC, slot', [patientId, from, to]);
    return res.json({ patientId, from, to, reports: rows.map(toReportDto) });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------- nurse review ------------------------------- */
// What makes a report need a nurse's look. Missing data is never treated as normal.
const TASK_ATTENTION = `(c.status IN ('not_done', 'skipped', 'not_applicable') OR c.measurement_status IN ('not_measured', 'no_device')
                         OR c.version_mismatch OR (c.note IS NOT NULL AND c.note <> ''))`;
const MED_ATTENTION = `(m.status IN ('not_taken', 'unknown') OR m.version_mismatch OR m.record_mismatch OR (m.reason IS NOT NULL AND m.reason <> ''))`;

function flagsOf(r) {
  const f = [];
  if (r.version_mismatch) f.push('plan_version_differs');
  if (r.record_mismatch) f.push('prescription_changed');
  if (['not_done', 'skipped'].includes(r.status)) f.push('not_done');
  if (r.status === 'not_applicable') f.push('not_applicable');
  if (r.status === 'not_taken') f.push('not_taken');
  if (r.status === 'unknown') f.push('unknown');
  if (['not_measured', 'no_device'].includes(r.measurement_status)) f.push(r.measurement_status);
  if (r.note || r.reason) f.push('comment');
  return f;
}

function taskItem(r) {
  return {
    type: 'task', id: r.id, patientId: r.patient_id, date: r.scheduled_for, slot: r.slot, title: r.title, category: r.category, kind: r.kind,
    status: r.status, note: r.note, reading: r.reading, measurementStatus: r.measurement_status, checkinId: r.checkin_id,
    seenPlanVersion: r.seen_plan_version, planVersion: r.v_version || null, flags: flagsOf(r),
    reportedBy: r.completed_by, reportedAt: r.completed_at, recordedAt: r.client_recorded_at,
    review: r.reviewed_at ? { by: r.reviewed_by, byName: r.reviewed_by_name, at: r.reviewed_at, note: r.review_note } : null,
  };
}
function medItem(r) {
  return { ...toReportDto(r), type: 'medication', title: `${r.medication.name}${r.medication.strength ? ` ${r.medication.strength}` : r.medication.dosage ? ` ${r.medication.dosage}` : ''}`, flags: flagsOf(r) };
}

async function careReports({ patientId = null, attention = true, from = null, to = null, limit = 200 }) {
  const tw = [attention ? TASK_ATTENTION : 'TRUE', attention ? 'c.reviewed_at IS NULL' : 'TRUE'];
  const mw = [attention ? MED_ATTENTION : 'TRUE', attention ? 'm.reviewed_at IS NULL' : 'TRUE'];
  const p = [];
  if (patientId) { p.push(patientId); tw.push(`c.patient_id = $${p.length}`); mw.push(`m.patient_id = $${p.length}`); }
  if (from) { p.push(from); tw.push(`c.scheduled_for >= $${p.length}`); mw.push(`m.scheduled_for >= $${p.length}`); }
  if (to) { p.push(to); tw.push(`c.scheduled_for <= $${p.length}`); mw.push(`m.scheduled_for <= $${p.length}`); }
  p.push(limit);
  const [{ rows: tasks }, { rows: meds }] = await Promise.all([
    pool.query(`SELECT c.*, t.title, t.category, t.kind, v.version AS v_version FROM task_completions c JOIN care_tasks t ON t.id = c.task_id
                 LEFT JOIN care_plan_versions v ON v.id = t.plan_version_id
                WHERE ${tw.join(' AND ')} ORDER BY c.completed_at DESC LIMIT $${p.length}`, p),
    pool.query(`SELECT m.* FROM medication_reports m WHERE ${mw.join(' AND ')} ORDER BY m.reported_at DESC LIMIT $${p.length}`, p),
  ]);
  return [...tasks.map(taskItem), ...meds.map(medItem)].sort((a, b) => String(b.reportedAt).localeCompare(String(a.reportedAt)));
}

router.get('/api/patients/:id/care-reports', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'clinic_staff') return forbid(res, 'Only nurses review caregiver reports');
    if (!PATIENT_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const attention = req.query.view !== 'all';
    for (const k of ['from', 'to']) if (req.query[k] && !schedule.isDate(req.query[k])) return res.status(422).json({ error: 'validation_failed', details: [`${k} must be YYYY-MM-DD`] });
    const items = await careReports({ patientId: req.params.id, attention, from: req.query.from || null, to: req.query.to || null });
    return res.json({ patientId: req.params.id, view: attention ? 'attention' : 'all', items });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/care-reports/attention', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'clinic_staff') return forbid(res, 'Only nurses review caregiver reports');
    const items = await careReports({ attention: true, limit: 100 });
    const byPatient = {};
    for (const i of items) byPatient[i.patientId] = (byPatient[i.patientId] || 0) + 1;
    return res.json({ total: items.length, byPatient, items: items.slice(0, 50) });
  } catch (err) {
    return next(err);
  }
});

router.post('/api/care-reports/:type/:id/review', async (req, res, next) => {
  try {
    const { type, id } = req.params;
    if (!['task', 'medication'].includes(type) || !UUID_RE.test(id)) return res.status(404).json({ error: 'not_found' });
    const note = typeof (req.body || {}).note === 'string' ? req.body.note.trim() : '';
    if (note.length < 3 || note.length > 500) return res.status(422).json({ error: 'validation_failed', details: ['note is required: what you assessed and what you did (3-500 characters)'] });
    const table = type === 'task' ? 'task_completions' : 'medication_reports';
    const { rows: [r0] } = await pool.query(`SELECT patient_id, reviewed_at FROM ${table} WHERE id = $1`, [id]);
    if (!r0) return res.status(404).json({ error: 'not_found', message: 'Report not found' });
    const { authoriseNurse } = require('./planRoutes');
    await authoriseNurse(req, r0.patient_id);
    const { rows: [r] } = await pool.query(
      `UPDATE ${table} SET reviewed_by = $2, reviewed_by_name = $3, reviewed_at = now(), review_note = $4 WHERE id = $1 AND reviewed_at IS NULL RETURNING *`,
      [id, req.user.id, req.user.name || null, note],
    );
    if (!r) return res.status(409).json({ error: 'already_reviewed', message: 'This report was already reviewed' });
    logger.info('care report reviewed', { type, id, patientId: r.patient_id, by: req.user.id });
    return res.json({ type, id, patientId: r.patient_id, review: { by: r.reviewed_by, byName: r.reviewed_by_name, at: r.reviewed_at, note: r.review_note } });
  } catch (err) {
    if (err.body) return res.status(err.status).json(err.body);
    if (err.status === 503) return res.status(503).json({ error: 'dependency_unavailable', message: err.message });
    return next(err);
  }
});

module.exports = { router, medicationChecklist, versionOn, reportTiming, medicationOn, medView, flagsOf };

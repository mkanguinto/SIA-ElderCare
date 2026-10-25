'use strict';

/**
 * Care Plan Service API (v2 Batch 4). RBAC is enforced at the gateway and re-checked here.
 *
 *   GET    /api/care/categories                          any signed-in user   duty categories + suggested tasks
 *   GET    /api/patients/:id/care-plan                   caregiver (own), clinic: active plan (+ draft for nurses);
 *                                                        family (own): a summary of the active plan
 *   PUT    /api/patients/:id/care-plan                   care-team nurse      goals + notes of the draft
 *   POST   /api/patients/:id/care-plan/tasks             care-team nurse      add a task to the draft
 *   PATCH  /api/care/tasks/:taskId                       care-team nurse      change a draft task
 *   DELETE /api/care/tasks/:taskId                       care-team nurse      retire a draft task (kept for history)
 *   GET    /api/patients/:id/care-plan/checklist?date=   caregiver/family (own), clinic: tasks + medicine doses
 *   POST   /api/care/tasks/:taskId/completions           caregiver (own patient)  done / not done / not applicable / reading
 *   GET    /api/patients/:id/care-plan/history?from=&to=&page=&pageSize=   adherence + completions
 *
 * Plan versions (drafts, verification, activation) are in planRoutes.js; medicine reports and nurse review in
 * reportRoutes.js. An active plan never changes in place: every change goes through a draft.
 */
const express = require('express');
const { pool, withTransaction } = require('./db');
const logger = require('./lib/logger');
const { requireInternalToken } = require('./lib/internalAuth');
const { parsePagination, pageInfo } = require('./lib/pagination');
const { CATEGORIES } = require('./catalog');
const schedule = require('./schedule');
const planContent = require('./planContent');
const { router: planRouter, toVersionDto, draftFor, event, handle, fail } = require('./planRoutes');
const reports = require('./reportRoutes');

const router = express.Router();
router.use(requireInternalToken);
router.use(planRouter);
router.use(reports.router);

const TZ = () => process.env.CARE_TZ_OFFSET || process.env.VISIT_TZ_OFFSET || '+08:00';
const PATIENT_SCOPED = ['caregiver', 'family_member'];
// Admins manage accounts and access; care plans are clinical and stay with the care team (the gateway agrees).
const READERS = ['caregiver', 'family_member', 'clinic_staff'];
const PATIENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// How far back a caregiver may tick off a forgotten task, and how far the checklist can look around.
const LATE_LOG_DAYS = Number(process.env.CARE_LATE_LOG_DAYS || 7);

function forbid(res, message = 'Your role cannot perform this action') {
  return res.status(403).json({ error: 'forbidden', message });
}
const hasRole = (req, roles) => req.user && roles.includes(req.user.role);
const canSeePatient = (req, patientId) => hasRole(req, READERS) && (!PATIENT_SCOPED.includes(req.user.role) || req.user.patients.includes(patientId));

function toTaskDto(r) {
  return {
    id: r.id, patientId: r.patient_id, category: r.category, title: r.title, instructions: r.instructions,
    frequency: r.frequency, times: r.times, daysOfWeek: r.days_of_week.map(Number),
    dueDate: r.due_date, startDate: r.start_date, endDate: r.end_date, active: r.active,
    kind: r.kind || 'task', measurement: r.measurement || null, specialised: Boolean(r.specialised), source: r.source || null,
    planVersionId: r.plan_version_id || null, planVersion: r.v_version || null, copiedFrom: r.copied_from || null,
    createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
  };
}

/**
 * A task of a plan version applies from the version's effective date until the day before the version that
 * superseded it took effect. The stored task is not changed; the window comes from the versions.
 */
function withVersionWindow(dto, r) {
  if (!r.plan_version_id) return dto;
  let { startDate, endDate } = dto;
  if (r.v_from && (!startDate || startDate < r.v_from)) startDate = r.v_from;
  if (r.v_next_from) {
    const last = schedule.addDays(r.v_next_from, -1);
    if (!endDate || endDate > last) endDate = last;
  }
  return { ...dto, startDate, endDate };
}
function toCompletionDto(r) {
  return {
    id: r.id, taskId: r.task_id, date: r.scheduled_for, slot: r.slot, status: r.status, note: r.note,
    completedBy: r.completed_by, completedAt: r.completed_at, ...(r.title ? { title: r.title, category: r.category } : {}),
    reading: r.reading || null, measurementStatus: r.measurement_status || null, checkinId: r.checkin_id || null,
    planVersionId: r.plan_version_id || null, seenPlanVersion: r.seen_plan_version ?? null, versionMismatch: Boolean(r.version_mismatch),
    recordedAt: r.client_recorded_at || null,
    review: r.reviewed_at ? { by: r.reviewed_by, byName: r.reviewed_by_name, at: r.reviewed_at, note: r.review_note } : null,
  };
}

/** Tasks of the active and superseded versions (with their date windows) and any task from before versions. */
async function loadTasks(patientId, { includeInactive = true } = {}) {
  const { rows } = await pool.query(
    `SELECT t.*, v.version AS v_version, v.status AS v_status, v.effective_date AS v_from, nv.effective_date AS v_next_from
       FROM care_tasks t
       LEFT JOIN care_plan_versions v ON v.id = t.plan_version_id
       LEFT JOIN care_plan_versions nv ON nv.id = v.superseded_by
      WHERE t.patient_id = $1 AND (t.plan_version_id IS NULL OR v.status IN ('active', 'superseded')) ${includeInactive ? '' : 'AND t.active'}
      ORDER BY t.category, t.title`, [patientId],
  );
  return rows.map((r) => withVersionWindow(toTaskDto(r), r));
}

async function activeVersion(patientId) {
  const { rows: [v] } = await pool.query("SELECT * FROM care_plan_versions WHERE patient_id = $1 AND status = 'active'", [patientId]);
  return v || null;
}

/* ------------------------------- catalogue ------------------------------- */
router.get('/api/care/categories', (req, res) => {
  if (!hasRole(req, READERS)) return forbid(res);
  return res.json({ categories: CATEGORIES });
});

/* ------------------------------- plan + tasks ------------------------------- */
router.get('/api/patients/:id/care-plan', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!PATIENT_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    if (!canSeePatient(req, patientId)) return forbid(res, 'You are not assigned to this patient');
    const [{ rows: [legacyPlan] }, active, tasks] = await Promise.all([
      pool.query('SELECT * FROM care_plans WHERE patient_id = $1', [patientId]),
      activeVersion(patientId),
      loadTasks(patientId, { includeInactive: req.query.includeInactive === 'true' }),
    ]);
    const today = schedule.localNow(TZ()).date;
    // The tasks in effect today: those of the active version (and any from before versions).
    const current = tasks.filter((t) => !t.planVersionId || (active && t.planVersionId === active.id));
    const activeDto = toVersionDto(active);
    if (req.user.role === 'family_member') {
      return res.json({
        patientId,
        summary: planContent.familySummary(activeDto),
        tasks: current.filter((t) => t.active).map((t) => ({ id: t.id, category: t.category, title: t.title, frequency: t.frequency, times: t.times, kind: t.kind })),
      });
    }
    const byCategory = CATEGORIES.map((c) => ({ category: c.code, name: c.name, tasks: current.filter((t) => t.category === c.code && t.active).length }));
    let draft = null;
    if (req.user.role === 'clinic_staff') {
      const { rows: [d] } = await pool.query("SELECT * FROM care_plan_versions WHERE patient_id = $1 AND status = 'draft'", [patientId]);
      draft = toVersionDto(d);
    }
    return res.json({
      patientId,
      plan: legacyPlan || active ? {
        goals: activeDto ? activeDto.content.goals || null : legacyPlan.goals, notes: activeDto ? activeDto.content.notes || null : legacyPlan.notes,
        createdBy: legacyPlan ? legacyPlan.created_by : null, createdAt: legacyPlan ? legacyPlan.created_at : null,
        updatedBy: activeDto ? activeDto.activatedBy : legacyPlan.updated_by, updatedAt: activeDto ? activeDto.activatedAt : legacyPlan.updated_at,
      } : null,
      active: activeDto ? { ...activeDto, reviewDue: Boolean(activeDto.reviewDate && activeDto.reviewDate <= today), needsApproval: planContent.approvalItems(activeDto.content) } : null,
      draft: draft ? { id: draft.id, version: draft.version, updatedAt: draft.updatedAt, updatedBy: draft.updatedBy, verified: Boolean(draft.verification) } : null,
      byCategory,
      tasks: current,
    });
  } catch (err) {
    return next(err);
  }
});

// Goals and notes are part of the plan content: they change in the draft, never in the active version.
router.put('/api/patients/:id/care-plan', handle(async (req, res) => {
  if (!hasRole(req, ['clinic_staff'])) return forbid(res);
  const patientId = req.params.id;
  if (!PATIENT_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
  const b = req.body || {};
  const errors = [];
  for (const k of ['goals', 'notes']) {
    if (b[k] !== undefined && b[k] !== null && (typeof b[k] !== 'string' || b[k].length > 2000)) errors.push(`${k} must be at most 2000 characters`);
  }
  if (b.goals === undefined && b.notes === undefined) errors.push('goals or notes is required');
  if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
  const { draft } = await draftFor(req, patientId);
  const content = { ...(draft.content || {}) };
  for (const k of ['goals', 'notes']) if (b[k] !== undefined) content[k] = b[k] ? b[k].trim() : null;
  const row = await withTransaction(async (client) => {
    const { rows: [r] } = await client.query("UPDATE care_plan_versions SET content = $2, updated_by = $3, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *",
      [draft.id, JSON.stringify(content), req.user.id]);
    if (!r) throw fail(409, 'not_draft', 'This draft was activated or discarded meanwhile');
    await event(client, req, patientId, r.id, 'draft_updated', { fields: Object.keys(b) });
    return r;
  });
  return res.json({ patientId, draft: { id: row.id, version: row.version }, plan: { goals: row.content.goals || null, notes: row.content.notes || null, updatedBy: row.updated_by, updatedAt: row.updated_at } });
}));

router.post('/api/patients/:id/care-plan/tasks', handle(async (req, res) => {
  if (!hasRole(req, ['clinic_staff'])) return forbid(res, 'Only nurses can change a care plan');
  const patientId = req.params.id;
  if (!PATIENT_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
  const { errors, value: v } = schedule.validateTask(req.body);
  if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
  // A new task goes into the draft; it reaches the caregiver when the draft is activated.
  const { draft } = await draftFor(req, patientId);
  const row = await withTransaction(async (c) => {
    const { rows: [t] } = await c.query(
      `INSERT INTO care_tasks (patient_id, category, title, instructions, frequency, times, days_of_week, due_date, start_date, end_date, active,
                               kind, measurement, specialised, source, plan_version_id, created_by, updated_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11, TRUE),coalesce($12,'task'),$13,coalesce($14, FALSE),$15,$16,$17,$17) RETURNING *`,
      [patientId, v.category, v.title, v.instructions ?? null, v.frequency, v.times || [], v.daysOfWeek || [], v.dueDate ?? null,
        v.startDate ?? null, v.endDate ?? null, v.active ?? null, v.kind ?? null, v.measurement ?? null, v.specialised ?? null,
        v.source ? JSON.stringify(v.source) : null, draft.id, req.user.id],
    );
    await event(c, req, patientId, draft.id, 'task_added', { taskId: t.id, title: t.title, category: t.category });
    return t;
  });
  logger.info('care task added', { patientId, taskId: row.id, category: row.category, draft: draft.version, by: req.user.id });
  return res.status(201).location(`/api/care/tasks/${row.id}`).json({ ...toTaskDto(row), planVersion: draft.version, draft: true });
}));

/** The task and its version; only a draft's tasks can change. */
async function draftTask(req, taskId) {
  if (!UUID_RE.test(taskId)) throw fail(404, 'not_found', 'Task not found');
  const { rows: [t] } = await pool.query(
    'SELECT t.*, v.status AS v_status, v.version AS v_version FROM care_tasks t LEFT JOIN care_plan_versions v ON v.id = t.plan_version_id WHERE t.id = $1', [taskId],
  );
  if (!t) throw fail(404, 'not_found', 'Task not found');
  if (t.v_status !== 'draft') {
    throw fail(409, 'not_draft', `This task is part of ${t.v_version ? `version ${t.v_version} (${t.v_status})` : 'the plan in use'}. Start a draft of the plan and change the task there.`);
  }
  await draftFor(req, t.patient_id); // care-team check
  return t;
}

router.patch('/api/care/tasks/:taskId', handle(async (req, res) => {
  if (!hasRole(req, ['clinic_staff'])) return forbid(res, 'Only nurses can change a care plan');
  const existing = await draftTask(req, req.params.taskId);
  const { errors, value } = schedule.validateTask(req.body, { partial: true, existing: toTaskDto(existing) });
  if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
  const column = { category: 'category', title: 'title', instructions: 'instructions', frequency: 'frequency', times: 'times', daysOfWeek: 'days_of_week', dueDate: 'due_date',
    startDate: 'start_date', endDate: 'end_date', active: 'active', kind: 'kind', measurement: 'measurement', specialised: 'specialised', source: 'source' };
  const keys = Object.keys(value);
  const row = await withTransaction(async (c) => {
    const { rows: [r] } = await c.query(
      `UPDATE care_tasks SET ${keys.map((k, i) => `${column[k]} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [existing.id, ...keys.map((k) => (k === 'source' && value[k] ? JSON.stringify(value[k]) : value[k])), req.user.id],
    );
    await event(c, req, existing.patient_id, existing.plan_version_id, 'task_changed', { taskId: existing.id, title: r.title, fields: keys });
    return r;
  });
  return res.json(toTaskDto(row));
}));

router.delete('/api/care/tasks/:taskId', handle(async (req, res) => {
  if (!hasRole(req, ['clinic_staff'])) return forbid(res, 'Only nurses can change a care plan');
  const existing = await draftTask(req, req.params.taskId);
  // Retire instead of delete: the task stays in the draft's history.
  await withTransaction(async (c) => {
    await c.query('UPDATE care_tasks SET active = FALSE, updated_by = $2, updated_at = now() WHERE id = $1', [existing.id, req.user.id]);
    await event(c, req, existing.patient_id, existing.plan_version_id, 'task_removed', { taskId: existing.id, title: existing.title });
  });
  return res.status(204).end();
}));

/* ------------------------------- daily checklist ------------------------------- */
router.get('/api/patients/:id/care-plan/checklist', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!PATIENT_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    if (!canSeePatient(req, patientId)) return forbid(res, 'You are not assigned to this patient');
    const now = schedule.localNow(TZ());
    const date = req.query.date || now.date;
    if (!schedule.isDate(date)) return res.status(422).json({ error: 'validation_failed', details: ['date must be YYYY-MM-DD'] });
    if (date < schedule.addDays(now.date, -31) || date > schedule.addDays(now.date, 14)) {
      return res.status(422).json({ error: 'validation_failed', details: ['date must be within the last 31 days or the next 14 days'] });
    }
    const [tasks, { rows: comps }, { rows: onceRows }, version, medicines] = await Promise.all([
      loadTasks(patientId),
      pool.query('SELECT * FROM task_completions WHERE patient_id = $1 AND scheduled_for = $2', [patientId, date]),
      pool.query(
        `SELECT DISTINCT c.task_id FROM task_completions c JOIN care_tasks t ON t.id = c.task_id
          WHERE c.patient_id = $1 AND t.frequency = 'once' AND c.status = 'done'`, [patientId],
      ),
      reports.versionOn(patientId, date),
      reports.medicationChecklist(req, patientId, date),
    ]);
    // On the day a new version starts, a slot already reported under the version it replaced keeps that report.
    const completions = comps.map(toCompletionDto);
    const reported = new Set(completions.map((c) => `${c.taskId}|${c.slot}`));
    for (const t of tasks) {
      if (!t.copiedFrom) continue;
      for (const c of completions.filter((x) => x.taskId === t.copiedFrom)) {
        if (!reported.has(`${t.id}|${c.slot}`)) completions.push({ ...c, taskId: t.id, reportedUnderVersion: true });
      }
    }
    const checklist = schedule.buildChecklist(tasks, completions, date, now, new Set(onceRows.map((r) => r.task_id)));
    const byId = new Map(tasks.map((t) => [t.id, t]));
    for (const item of checklist.items) {
      const t = byId.get(item.taskId);
      Object.assign(item, { kind: t.kind, measurement: t.measurement, specialised: t.specialised, planVersion: t.planVersion });
    }
    const isFamily = req.user.role === 'family_member';
    return res.json({
      patientId, timezone: TZ(), today: now.date,
      planVersion: version ? { id: version.id, version: version.version } : null,
      ...checklist,
      medicines: isFamily
        ? { summary: medicines.summary || null, error: medicines.error || null }
        : medicines,
    });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------- caregiver task reports ------------------------------- */
const TASK_STATUS = ['done', 'not_done', 'not_applicable', 'skipped'];
const MEASURE_STATUS = ['recorded', 'not_measured', 'no_device'];
// Input sanity limits for a typed reading (typing errors), not clinical thresholds: those stay with the check-in rules.
const READING_FIELDS = {
  bp: { systolic: [40, 300], diastolic: [20, 200] }, heart_rate: { value: [20, 250] }, temperature: { value: [30, 45] },
  spo2: { value: [50, 100] }, blood_glucose: { value: [10, 900] },
};

function validReading(measurement, reading, errors) {
  const spec = READING_FIELDS[measurement];
  if (!reading || typeof reading !== 'object' || Array.isArray(reading)) { errors.push('reading is required when the measurement was recorded'); return null; }
  const out = {};
  for (const [k, [lo, hi]] of Object.entries(spec)) {
    const v = reading[k];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < lo || v > hi) errors.push(`reading.${k} must be a number from ${lo} to ${hi}`);
    else out[k] = v;
  }
  if (measurement === 'bp' && out.systolic && out.diastolic && out.diastolic >= out.systolic) errors.push('reading.diastolic must be lower than reading.systolic');
  return out;
}

router.post('/api/care/tasks/:taskId/completions', async (req, res, next) => {
  try {
    if (!hasRole(req, ['caregiver'])) return forbid(res, 'Only the assigned caregiver can report care tasks');
    if (!UUID_RE.test(req.params.taskId)) return res.status(404).json({ error: 'not_found', message: 'Task not found' });
    const { rows: [row] } = await pool.query(
      `SELECT t.*, v.version AS v_version, v.status AS v_status, v.effective_date AS v_from, nv.effective_date AS v_next_from
         FROM care_tasks t LEFT JOIN care_plan_versions v ON v.id = t.plan_version_id LEFT JOIN care_plan_versions nv ON nv.id = v.superseded_by
        WHERE t.id = $1`, [req.params.taskId],
    );
    if (!row) return res.status(404).json({ error: 'not_found', message: 'Task not found' });
    if (!req.user.patients.includes(row.patient_id)) return forbid(res, 'You are not assigned to this patient');
    if (['draft', 'discarded'].includes(row.v_status)) return res.status(409).json({ error: 'conflict', message: 'This task is not part of a plan in use' });
    const task = withVersionWindow(toTaskDto(row), row);

    const b = req.body || {};
    const now = schedule.localNow(TZ());
    const errors = [];
    const { date, recordedAt, seen } = reports.reportTiming(b, now, errors);
    const note = b.note !== undefined && b.note !== null ? b.note : b.reason;
    if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) errors.push('note must be at most 500 characters');
    let status = b.status || 'done';
    let measurementStatus = null;
    let reading = null;
    if (task.kind === 'measurement') {
      if (!MEASURE_STATUS.includes(b.measurementStatus)) errors.push(`measurementStatus must be one of: ${MEASURE_STATUS.join(', ')}`);
      else {
        measurementStatus = b.measurementStatus;
        if (measurementStatus === 'recorded') { reading = validReading(task.measurement, b.reading, errors); status = 'done'; } else { status = 'not_done'; }
        if (measurementStatus !== 'recorded' && b.reading !== undefined && b.reading !== null) errors.push('a reading is only given when the measurement was recorded');
      }
    } else {
      if (!TASK_STATUS.includes(status)) errors.push(`status must be one of: ${TASK_STATUS.join(', ')}`);
      if (b.reading !== undefined || b.measurementStatus !== undefined) errors.push('reading and measurementStatus are only for measurement tasks');
    }
    if (status === 'skipped' && !(typeof note === 'string' && note.trim().length >= 3)) errors.push('say why the task was skipped (note, at least 3 characters)');
    let checkinId = null;
    if (b.checkinId !== undefined && b.checkinId !== null) {
      if (!UUID_RE.test(b.checkinId) || measurementStatus !== 'recorded') errors.push('checkinId is only for a recorded measurement (the check-in that carries the reading)');
      else checkinId = b.checkinId;
    }

    let slot;
    let versionMismatch = Boolean(seen && row.v_version && seen !== row.v_version);
    if (!errors.length) {
      if (task.frequency === 'as_needed') slot = 'log';
      else if (task.frequency === 'once') slot = schedule.ANY;
      else {
        // Slots the task had on that date, ignoring its version window: a report made offline against a version
        // that has since been replaced is kept as reported and flagged for the nurse.
        const unbounded = { ...toTaskDto(row), active: true };
        const inWindow = schedule.slotsOn(task, date);
        const slots = inWindow.length ? inWindow : schedule.slotsOn(unbounded, date);
        slot = b.slot || (slots.length === 1 ? slots[0] : undefined);
        if (!slots.length) errors.push(`this task is not scheduled on ${date}`);
        else if (!slot) errors.push(`slot is required: one of ${slots.join(', ')}`);
        else if (!slots.includes(slot)) errors.push(`slot must be one of: ${slots.join(', ')}`);
        if (!inWindow.length && slots.length) versionMismatch = true;
      }
      if (!task.active && !versionMismatch) errors.push('this task was removed from the care plan');
    }
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    const values = [task.id, task.patientId, date, slot, status, note ? note.trim() : null, req.user.id,
      reading ? JSON.stringify(reading) : null, measurementStatus, checkinId, row.plan_version_id, seen, versionMismatch, recordedAt];
    const c = await withTransaction(async (client) => {
      if (slot !== 'log') {
        const { rows: [prev] } = await client.query('SELECT * FROM task_completions WHERE task_id = $1 AND scheduled_for = $2 AND slot = $3 FOR UPDATE', [task.id, date, slot]);
        if (prev) {
          // A correction keeps what the caregiver first reported.
          await client.query('INSERT INTO report_revisions (report_type, report_id, previous, changed_by) VALUES ($1,$2,$3,$4)', ['task', prev.id, JSON.stringify(toCompletionDto(prev)), req.user.id]);
          const { rows: [r] } = await client.query(
            `UPDATE task_completions SET status = $5, note = $6, completed_by = $7, completed_at = now(), reading = $8, measurement_status = $9, checkin_id = $10,
                    plan_version_id = $11, seen_plan_version = $12, version_mismatch = $13, client_recorded_at = $14,
                    reviewed_by = NULL, reviewed_by_name = NULL, reviewed_at = NULL, review_note = NULL
              WHERE task_id = $1 AND patient_id = $2 AND scheduled_for = $3 AND slot = $4 RETURNING *, FALSE AS inserted`, values,
          );
          return r;
        }
      }
      const { rows: [r] } = await client.query(
        `INSERT INTO task_completions (task_id, patient_id, scheduled_for, slot, status, note, completed_by, reading, measurement_status, checkin_id,
                                       plan_version_id, seen_plan_version, version_mismatch, client_recorded_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14) RETURNING *, TRUE AS inserted`, values,
      );
      return r;
    });
    logger.info('care task reported', { taskId: task.id, patientId: task.patientId, date, slot, status: c.status, by: req.user.id, versionMismatch });
    return res.status(c.inserted ? 201 : 200).json(toCompletionDto(c));
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------- history + adherence ------------------------------- */
router.get('/api/patients/:id/care-plan/history', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!PATIENT_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    if (!canSeePatient(req, patientId)) return forbid(res, 'You are not assigned to this patient');
    const pg = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    const now = schedule.localNow(TZ());
    const to = req.query.to || now.date;
    const from = req.query.from || schedule.addDays(to, -6);
    const errors = [...pg.errors];
    if (!schedule.isDate(from) || !schedule.isDate(to)) errors.push('from and to must be YYYY-MM-DD');
    else if (from > to) errors.push('from must be on or before to');
    else if (schedule.addDays(from, 31) <= to) errors.push('the range can be at most 31 days');
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    // Adherence only counts days that have already happened.
    const until = to > now.date ? now.date : to;
    const [tasks, { rows: all }, { rows: page }, { rows: [{ total }] }] = await Promise.all([
      loadTasks(patientId),
      pool.query('SELECT task_id, scheduled_for, slot, status FROM task_completions WHERE patient_id = $1 AND scheduled_for BETWEEN $2 AND $3', [patientId, from, until]),
      pool.query(
        `SELECT c.*, t.title, t.category FROM task_completions c JOIN care_tasks t ON t.id = c.task_id
          WHERE c.patient_id = $1 AND c.scheduled_for BETWEEN $2 AND $3
          ORDER BY c.scheduled_for DESC, c.completed_at DESC, c.id LIMIT $4 OFFSET $5`,
        [patientId, from, to, pg.pageSize, pg.offset],
      ),
      pool.query('SELECT count(*)::int AS total FROM task_completions WHERE patient_id = $1 AND scheduled_for BETWEEN $2 AND $3', [patientId, from, to]),
    ]);
    // Count a task only from the day it was added.
    const effective = tasks.map((t) => ({ ...t, startDate: t.startDate || new Date(t.createdAt).toISOString().slice(0, 10) }));
    const summary = from <= until
      ? schedule.adherence(effective, all.map((r) => ({ taskId: r.task_id, date: r.scheduled_for, slot: r.slot, status: r.status })), from, until)
      : { from, to: until, scheduled: 0, done: 0, rate: null, categories: [] };
    return res.json({ patientId, adherence: summary, completions: page.map(toCompletionDto), pagination: pageInfo(pg, total) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

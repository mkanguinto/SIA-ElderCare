'use strict';

/**
 * Care Plan Service API (v2 Batch 4). RBAC is enforced at the gateway and re-checked here.
 *
 *   GET    /api/care/categories                          any signed-in user   duty categories + suggested tasks
 *   GET    /api/patients/:id/care-plan                   caregiver/family (own), clinic, admin
 *   PUT    /api/patients/:id/care-plan                   clinic               goals + notes
 *   POST   /api/patients/:id/care-plan/tasks             clinic               add a duty
 *   PATCH  /api/care/tasks/:taskId                       clinic               change a duty
 *   DELETE /api/care/tasks/:taskId                       clinic               retire a duty (kept for history)
 *   GET    /api/patients/:id/care-plan/checklist?date=   caregiver/family (own), clinic, admin
 *   POST   /api/care/tasks/:taskId/completions           caregiver (own patient)  tick off / skip / log
 *   GET    /api/patients/:id/care-plan/history?from=&to=&page=&pageSize=   adherence + completions
 */
const express = require('express');
const { pool, withTransaction } = require('./db');
const logger = require('./lib/logger');
const { requireInternalToken } = require('./lib/internalAuth');
const { parsePagination, pageInfo } = require('./lib/pagination');
const { CATEGORIES } = require('./catalog');
const schedule = require('./schedule');

const router = express.Router();
router.use(requireInternalToken);

const TZ = () => process.env.CARE_TZ_OFFSET || process.env.VISIT_TZ_OFFSET || '+08:00';
const PATIENT_SCOPED = ['caregiver', 'family_member'];
const READERS = ['caregiver', 'family_member', 'clinic_staff', 'system_admin'];
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
    createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
  };
}
function toCompletionDto(r) {
  return {
    id: r.id, taskId: r.task_id, date: r.scheduled_for, slot: r.slot, status: r.status, note: r.note,
    completedBy: r.completed_by, completedAt: r.completed_at, ...(r.title ? { title: r.title, category: r.category } : {}),
  };
}

async function loadTasks(patientId, { includeInactive = true } = {}) {
  const { rows } = await pool.query(
    `SELECT * FROM care_tasks WHERE patient_id = $1 ${includeInactive ? '' : 'AND active'} ORDER BY category, title`, [patientId],
  );
  return rows.map(toTaskDto);
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
    const [{ rows: [plan] }, tasks] = await Promise.all([
      pool.query('SELECT * FROM care_plans WHERE patient_id = $1', [patientId]),
      loadTasks(patientId, { includeInactive: req.query.includeInactive === 'true' }),
    ]);
    const byCategory = CATEGORIES.map((c) => ({ category: c.code, name: c.name, tasks: tasks.filter((t) => t.category === c.code && t.active).length }));
    return res.json({
      patientId,
      plan: plan ? { goals: plan.goals, notes: plan.notes, createdBy: plan.created_by, createdAt: plan.created_at, updatedBy: plan.updated_by, updatedAt: plan.updated_at } : null,
      byCategory,
      tasks,
    });
  } catch (err) {
    return next(err);
  }
});

router.put('/api/patients/:id/care-plan', async (req, res, next) => {
  try {
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
    const { rows: [plan] } = await pool.query(
      `INSERT INTO care_plans (patient_id, goals, notes, created_by, updated_by) VALUES ($1, $2, $3, $4, $4)
       ON CONFLICT (patient_id) DO UPDATE SET goals = coalesce($2, care_plans.goals), notes = coalesce($3, care_plans.notes),
              updated_by = $4, updated_at = now()
       RETURNING *`,
      [patientId, b.goals ?? null, b.notes ?? null, req.user.id],
    );
    return res.json({ patientId, plan: { goals: plan.goals, notes: plan.notes, updatedBy: plan.updated_by, updatedAt: plan.updated_at } });
  } catch (err) {
    return next(err);
  }
});

router.post('/api/patients/:id/care-plan/tasks', async (req, res, next) => {
  try {
    if (!hasRole(req, ['clinic_staff'])) return forbid(res, 'Only clinic staff can change a care plan');
    const patientId = req.params.id;
    if (!PATIENT_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    const { errors, value: v } = schedule.validateTask(req.body);
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
    const row = await withTransaction(async (c) => {
      // The first task creates the plan.
      await c.query('INSERT INTO care_plans (patient_id, created_by, updated_by) VALUES ($1, $2, $2) ON CONFLICT (patient_id) DO NOTHING', [patientId, req.user.id]);
      const { rows: [t] } = await c.query(
        `INSERT INTO care_tasks (patient_id, category, title, instructions, frequency, times, days_of_week, due_date, start_date, end_date, active, created_by, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,coalesce($11, TRUE),$12,$12) RETURNING *`,
        [patientId, v.category, v.title, v.instructions ?? null, v.frequency, v.times || [], v.daysOfWeek || [], v.dueDate ?? null,
          v.startDate ?? null, v.endDate ?? null, v.active ?? null, req.user.id],
      );
      return t;
    });
    logger.info('care task added', { patientId, taskId: row.id, category: row.category, by: req.user.id });
    return res.status(201).location(`/api/care/tasks/${row.id}`).json(toTaskDto(row));
  } catch (err) {
    return next(err);
  }
});

router.patch('/api/care/tasks/:taskId', async (req, res, next) => {
  try {
    if (!hasRole(req, ['clinic_staff'])) return forbid(res, 'Only clinic staff can change a care plan');
    if (!UUID_RE.test(req.params.taskId)) return res.status(404).json({ error: 'not_found', message: 'Task not found' });
    const { rows: [existing] } = await pool.query('SELECT * FROM care_tasks WHERE id = $1', [req.params.taskId]);
    if (!existing) return res.status(404).json({ error: 'not_found', message: 'Task not found' });
    const { errors, value } = schedule.validateTask(req.body, { partial: true, existing: toTaskDto(existing) });
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
    const column = { category: 'category', title: 'title', instructions: 'instructions', frequency: 'frequency', times: 'times', daysOfWeek: 'days_of_week', dueDate: 'due_date', startDate: 'start_date', endDate: 'end_date', active: 'active' };
    const keys = Object.keys(value);
    const { rows: [row] } = await pool.query(
      `UPDATE care_tasks SET ${keys.map((k, i) => `${column[k]} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now()
        WHERE id = $1 RETURNING *`,
      [existing.id, ...keys.map((k) => value[k]), req.user.id],
    );
    return res.json(toTaskDto(row));
  } catch (err) {
    return next(err);
  }
});

router.delete('/api/care/tasks/:taskId', async (req, res, next) => {
  try {
    if (!hasRole(req, ['clinic_staff'])) return forbid(res, 'Only clinic staff can change a care plan');
    if (!UUID_RE.test(req.params.taskId)) return res.status(404).json({ error: 'not_found', message: 'Task not found' });
    // Retire instead of delete: completions reference the task and adherence history must stay readable.
    const { rowCount } = await pool.query('UPDATE care_tasks SET active = FALSE, updated_by = $2, updated_at = now() WHERE id = $1', [req.params.taskId, req.user.id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found', message: 'Task not found' });
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

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
    const [tasks, { rows: comps }, { rows: onceRows }] = await Promise.all([
      loadTasks(patientId),
      pool.query('SELECT * FROM task_completions WHERE patient_id = $1 AND scheduled_for = $2', [patientId, date]),
      pool.query(
        `SELECT DISTINCT c.task_id FROM task_completions c JOIN care_tasks t ON t.id = c.task_id
          WHERE c.patient_id = $1 AND t.frequency = 'once' AND c.status = 'done'`, [patientId],
      ),
    ]);
    const checklist = schedule.buildChecklist(tasks, comps.map(toCompletionDto), date, now, new Set(onceRows.map((r) => r.task_id)));
    return res.json({ patientId, timezone: TZ(), today: now.date, ...checklist });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------- tick off a duty ------------------------------- */
router.post('/api/care/tasks/:taskId/completions', async (req, res, next) => {
  try {
    if (!hasRole(req, ['caregiver'])) return forbid(res, 'Only the assigned caregiver can tick off care tasks');
    if (!UUID_RE.test(req.params.taskId)) return res.status(404).json({ error: 'not_found', message: 'Task not found' });
    const { rows: [row] } = await pool.query('SELECT * FROM care_tasks WHERE id = $1', [req.params.taskId]);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'Task not found' });
    if (!req.user.patients.includes(row.patient_id)) return forbid(res, 'You are not assigned to this patient');
    const task = toTaskDto(row);
    if (!task.active) return res.status(409).json({ error: 'conflict', message: 'This task was removed from the care plan' });

    const b = req.body || {};
    const now = schedule.localNow(TZ());
    const date = b.date || now.date;
    const errors = [];
    if (!schedule.isDate(date)) errors.push('date must be YYYY-MM-DD');
    else if (date > now.date) errors.push('date cannot be in the future');
    else if (date < schedule.addDays(now.date, -LATE_LOG_DAYS)) errors.push(`tasks can be ticked off up to ${LATE_LOG_DAYS} days late`);
    if (!['done', 'skipped'].includes(b.status || 'done')) errors.push('status must be done or skipped');
    if (b.note !== undefined && b.note !== null && (typeof b.note !== 'string' || b.note.length > 500)) errors.push('note must be at most 500 characters');
    if ((b.status === 'skipped') && !(typeof b.note === 'string' && b.note.trim().length >= 3)) errors.push('say why the task was skipped (note, at least 3 characters)');

    let slot;
    if (!errors.length) {
      if (task.frequency === 'as_needed') slot = 'log';
      else if (task.frequency === 'once') slot = schedule.ANY;
      else {
        const slots = schedule.slotsOn(task, date);
        slot = b.slot || (slots.length === 1 ? slots[0] : undefined);
        if (!slots.length) errors.push(`this task is not scheduled on ${date}`);
        else if (!slot) errors.push(`slot is required: one of ${slots.join(', ')}`);
        else if (!slots.includes(slot)) errors.push(`slot must be one of: ${slots.join(', ')}`);
      }
    }
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    const params = [task.id, task.patientId, date, slot, b.status || 'done', b.note ? b.note.trim() : null, req.user.id];
    const { rows: [c] } = slot === 'log'
      ? await pool.query(
        `INSERT INTO task_completions (task_id, patient_id, scheduled_for, slot, status, note, completed_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         RETURNING *, TRUE AS inserted`, params,
      )
      // Ticking the same slot again corrects it (e.g. skipped -> done) instead of duplicating it.
      : await pool.query(
        `INSERT INTO task_completions (task_id, patient_id, scheduled_for, slot, status, note, completed_by) VALUES ($1,$2,$3,$4,$5,$6,$7)
         ON CONFLICT (task_id, scheduled_for, slot) WHERE slot <> 'log'
         DO UPDATE SET status = EXCLUDED.status, note = EXCLUDED.note, completed_by = EXCLUDED.completed_by, completed_at = now()
         RETURNING *, (xmax = 0) AS inserted`, params,
      );
    logger.info('care task completed', { taskId: task.id, patientId: task.patientId, date, slot, status: c.status, by: req.user.id });
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

'use strict';

/**
 * Check-in monitoring status (Received -> Awaiting review -> Reviewed -> Action recorded).
 *
 *   GET  /api/checkins/review-queue?view=pending|current|historical|archived&status=&page=&pageSize=   clinic staff, admin
 *   POST /api/checkins/archive-demo              clinic staff (demo / test records only)
 *   GET  /api/checkins/:id                       caregiver / family (own patients), clinic staff, admin
 *   POST /api/checkins/:id/review   {note?}      clinic staff
 *   POST /api/checkins/:id/action   {action, note?}   clinic staff
 *
 * Every change is written to checkin_status_log with who and when.
 */
const express = require('express');
const { pool, withTransaction } = require('./db');
const logger = require('./lib/logger');
const { parsePagination, pageInfo } = require('./lib/pagination');
const { ORDER, plan, validateNote } = require('./reviewStatus');

const router = express.Router();
const CLINIC = ['clinic_staff', 'system_admin'];
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toLogDto(r) {
  return { status: r.status, changedBy: r.changed_by, changedByName: r.changed_by_name, note: r.note, changedAt: r.changed_at };
}

// Pending check-ins are split by age only for display: nothing is marked reviewed because it is old.
//   current     pending, recorded in the last HISTORICAL_AFTER_HOURS (default 48), most serious first
//   historical  pending and older: the backlog a nurse still has to review, oldest first
//   archived    demo / test records archived separately (not reviewed, not in the other lists)
//   pending     current + historical (default)
const HISTORICAL_AFTER_HOURS = Number(process.env.HISTORICAL_AFTER_HOURS || 48);
const VIEW_WHERE = {
  pending: 'c.archived_at IS NULL',
  current: `c.archived_at IS NULL AND c.recorded_at >= now() - make_interval(hours => ${HISTORICAL_AFTER_HOURS})`,
  historical: `c.archived_at IS NULL AND c.recorded_at < now() - make_interval(hours => ${HISTORICAL_AFTER_HOURS})`,
  archived: 'c.archived_at IS NOT NULL',
};
const VIEW_ORDER = {
  pending: "CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, c.recorded_at",
  current: "CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, c.recorded_at",
  historical: 'c.recorded_at',
  archived: 'c.archived_at DESC, c.recorded_at DESC',
};

router.get('/api/checkins/review-queue', async (req, res, next) => {
  try {
    if (!req.user || !CLINIC.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    const statuses = String(req.query.status || 'received,awaiting_review').split(',').filter((s) => ORDER.includes(s));
    const view = String(req.query.view || 'pending');
    const errors = [];
    if (!statuses.length) errors.push(`status must be any of: ${ORDER.join(', ')}`);
    if (!VIEW_WHERE[view]) errors.push(`view must be one of: ${Object.keys(VIEW_WHERE).join(', ')}`);
    const pg = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    errors.push(...pg.errors);
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
    const patientId = req.query.patientId ? String(req.query.patientId) : null;
    const filter = `c.status::text = ANY($1) ${patientId ? 'AND c.patient_id = $2' : ''}`;
    const fParams = [statuses, ...(patientId ? [patientId] : [])];
    const n = fParams.length;
    const [{ rows }, { rows: [counts] }] = await Promise.all([
      pool.query(
        `SELECT c.*, p.full_name AS patient_name FROM checkins c JOIN patients p ON p.id = c.patient_id
          WHERE ${filter} AND ${VIEW_WHERE[view]} ORDER BY ${VIEW_ORDER[view]} LIMIT $${n + 1} OFFSET $${n + 2}`,
        [...fParams, pg.pageSize, pg.offset],
      ),
      pool.query(
        `SELECT count(*) FILTER (WHERE ${VIEW_WHERE.current})::int AS current,
                count(*) FILTER (WHERE ${VIEW_WHERE.historical})::int AS historical,
                count(*) FILTER (WHERE ${VIEW_WHERE.archived})::int AS archived
           FROM checkins c WHERE ${filter}`, fParams,
      ),
    ]);
    const total = view === 'pending' ? counts.current + counts.historical : counts[view];
    // eslint-disable-next-line global-require
    const { toCheckinDto } = require('./routes');
    return res.json({
      view, historicalAfterHours: HISTORICAL_AFTER_HOURS, counts,
      checkins: rows.map((r) => ({ ...toCheckinDto(r), patientName: r.patient_name })), pagination: pageInfo(pg, total),
    });
  } catch (err) {
    return next(err);
  }
});

/** Archives pending demo / test check-ins (never real ones). They keep their status and move to the archived list. */
router.post('/api/checkins/archive-demo', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'clinic_staff') return res.status(403).json({ error: 'forbidden', message: 'Only clinic staff can archive demo records' });
    const { rows } = await pool.query(
      `UPDATE checkins SET archived_at = now(), archived_by = $1, archive_reason = 'Demo record archived by clinic staff'
        WHERE data_origin = 'demo' AND archived_at IS NULL AND status IN ('received', 'awaiting_review') RETURNING id`, [req.user.id],
    );
    logger.info('demo check-ins archived', { count: rows.length, by: req.user.id });
    return res.json({ archived: rows.length });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/checkins/:id', async (req, res, next) => {
  try {
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const { rows: [row] } = await pool.query('SELECT * FROM checkins WHERE id = $1', [req.params.id]);
    if (!row) return res.status(404).json({ error: 'not_found', message: 'Check-in not found' });
    const scoped = ['caregiver', 'family_member'].includes(req.user && req.user.role);
    if (!req.user || (scoped && !req.user.patients.includes(row.patient_id))) return res.status(403).json({ error: 'forbidden' });
    const { rows: log } = await pool.query('SELECT * FROM checkin_status_log WHERE checkin_id = $1 ORDER BY changed_at, id', [row.id]);
    // eslint-disable-next-line global-require
    const { toCheckinDto } = require('./routes');
    return res.json({ checkin: toCheckinDto(row), statusLog: log.map(toLogDto) });
  } catch (err) {
    return next(err);
  }
});

async function advance(req, res, next, op) {
  try {
    if (!req.user || req.user.role !== 'clinic_staff') return res.status(403).json({ error: 'forbidden', message: 'Only clinic staff can review check-ins' });
    if (!UUID.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const body = req.body || {};
    const errors = [];
    const noteErr = validateNote(body.note);
    if (noteErr) errors.push(`note ${noteErr}`);
    if (op === 'action') {
      const actErr = validateNote(body.action, { required: true });
      if (actErr) errors.push(`action ${actErr}`);
    }
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    const result = await withTransaction(async (client) => {
      const { rows: [row] } = await client.query('SELECT * FROM checkins WHERE id = $1 FOR UPDATE', [req.params.id]);
      if (!row) return { status: 404, body: { error: 'not_found', message: 'Check-in not found' } };
      if (row.archived_at) return { status: 409, body: { error: 'archived', message: 'This is an archived demo record' } };
      const p = plan(row.status, op);
      if (!p.ok) return { status: 409, body: { error: 'invalid_transition', message: p.error } };
      const by = req.user.id;
      const byName = req.user.name || null;
      const note = body.note ? body.note.trim() : null;
      for (const step of p.steps) {
        await client.query('INSERT INTO checkin_status_log (checkin_id, status, changed_by, changed_by_name, note) VALUES ($1,$2,$3,$4,$5)',
          [row.id, step, by, byName, step === 'action_recorded' ? body.action.trim() : note]);
      }
      const { rows: [updated] } = await client.query(
        op === 'review'
          ? `UPDATE checkins SET status = 'reviewed', reviewed_by_nurse = $2, reviewed_by_name = $3, reviewed_at = now(), review_note = $4
              WHERE id = $1 RETURNING *`
          : `UPDATE checkins SET status = 'action_recorded',
                    reviewed_by_nurse = coalesce(reviewed_by_nurse, $2), reviewed_by_name = coalesce(reviewed_by_name, $3),
                    reviewed_at = coalesce(reviewed_at, now()), review_note = coalesce(review_note, $4),
                    action_taken = $5, action_by = $2, action_by_name = $3, action_at = now()
              WHERE id = $1 RETURNING *`,
        op === 'review' ? [row.id, by, byName, note] : [row.id, by, byName, note, body.action.trim()],
      );
      const { rows: log } = await client.query('SELECT * FROM checkin_status_log WHERE checkin_id = $1 ORDER BY changed_at, id', [row.id]);
      return { status: 200, body: { updated, log } };
    });
    if (result.status !== 200) return res.status(result.status).json(result.body);
    logger.info(`checkin ${op === 'review' ? 'reviewed' : 'action recorded'}`, { checkinId: req.params.id, by: req.user.id });
    // eslint-disable-next-line global-require
    const { toCheckinDto } = require('./routes');
    return res.json({ checkin: toCheckinDto(result.body.updated), statusLog: result.body.log.map(toLogDto) });
  } catch (err) {
    return next(err);
  }
}

router.post('/api/checkins/:id/review', (req, res, next) => advance(req, res, next, 'review'));
router.post('/api/checkins/:id/action', (req, res, next) => advance(req, res, next, 'action'));

module.exports = router;

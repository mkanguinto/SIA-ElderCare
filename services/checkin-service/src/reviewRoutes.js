'use strict';

/**
 * Check-in monitoring status (Received -> Awaiting review -> Reviewed -> Action recorded).
 *
 *   GET  /api/checkins/review-queue?status=awaiting_review&page=&pageSize=   clinic staff, admin
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

router.get('/api/checkins/review-queue', async (req, res, next) => {
  try {
    if (!req.user || !CLINIC.includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    const statuses = String(req.query.status || 'received,awaiting_review').split(',').filter((s) => ORDER.includes(s));
    if (!statuses.length) return res.status(422).json({ error: 'validation_failed', details: [`status must be any of: ${ORDER.join(', ')}`] });
    const pg = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    if (pg.errors.length) return res.status(422).json({ error: 'validation_failed', details: pg.errors });
    const patientFilter = req.query.patientId ? 'AND c.patient_id = $4' : '';
    const params = [statuses, pg.pageSize, pg.offset, ...(req.query.patientId ? [String(req.query.patientId)] : [])];
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `SELECT c.*, p.full_name AS patient_name FROM checkins c JOIN patients p ON p.id = c.patient_id
          WHERE c.status::text = ANY($1) ${patientFilter}
          ORDER BY CASE c.severity WHEN 'critical' THEN 0 WHEN 'high' THEN 1 WHEN 'moderate' THEN 2 ELSE 3 END, c.recorded_at
          LIMIT $2 OFFSET $3`, params,
      ),
      pool.query(`SELECT count(*)::int AS total FROM checkins c WHERE c.status::text = ANY($1) ${req.query.patientId ? 'AND c.patient_id = $2' : ''}`,
        [statuses, ...(req.query.patientId ? [String(req.query.patientId)] : [])]),
    ]);
    // eslint-disable-next-line global-require
    const { toCheckinDto } = require('./routes');
    return res.json({ checkins: rows.map((r) => ({ ...toCheckinDto(r), patientName: r.patient_name })), pagination: pageInfo(pg, total) });
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

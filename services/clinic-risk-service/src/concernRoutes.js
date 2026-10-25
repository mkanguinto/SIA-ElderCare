'use strict';

/**
 * Concerns about an elder (caregiver "Report a concern", or a nurse) and how a nurse resolves them.
 *
 *   POST /api/patients/:id/concerns                 caregiver (own elder), nurse    {category, description, related?}
 *   GET  /api/patients/:id/concerns                 caregiver (own elder: status of what they reported), nurse (all)
 *   GET  /api/clinic/concerns?status=open|all       nurse    concerns across elders
 *   POST /api/clinic/concerns/:id/acknowledge       care-team nurse  {note?}
 *   POST /api/clinic/concerns/:id/note              care-team nurse  {note}   progress or action, concern stays open
 *   POST /api/clinic/concerns/:id/resolve           care-team nurse  {assessment, actionTaken}
 *
 * Separate from task completion (care-plan service) and check-in review (check-in service): only a nurse's
 * resolution with an assessment and the action taken closes a concern.
 */
const express = require('express');
const { pool, withTransaction } = require('./db');
const logger = require('./lib/logger');
const { requireInternalToken } = require('./lib/internalAuth');
const c = require('./concerns');

const router = express.Router();
router.use(['/api/patients/:id/concerns', '/api/clinic/concerns'], requireInternalToken);

const isNurse = (req) => req.user && req.user.role === 'clinic_staff';
const forbid = (res, message) => res.status(403).json({ error: 'forbidden', message });
const CONCERN_RE = /^CC-\d{6,}$/;

function toDto(r, events = null) {
  return {
    id: r.id, patient: { id: r.patient_id, name: r.patient_name || null }, category: r.category, categoryLabel: c.CATEGORIES[r.category] || r.category,
    description: r.description, related: r.related, status: r.status,
    reportedBy: { id: r.reported_by, name: r.reporter_name, role: r.reporter_role }, createdAt: r.created_at,
    acknowledged: r.acknowledged_at ? { by: r.acknowledged_by, at: r.acknowledged_at } : null,
    resolved: r.resolved_at ? { by: r.resolved_by, byName: r.resolved_by_name, at: r.resolved_at, assessment: r.assessment, actionTaken: r.action_taken } : null,
    ...(events ? { events: events.map((e) => ({ event: e.event, actor: { id: e.actor_id, name: e.actor_name, role: e.actor_role }, details: e.details, at: e.at })) } : {}),
  };
}

async function event(db, req, id, ev, details = {}) {
  await db.query('INSERT INTO concern_events (concern_id, event, actor_id, actor_name, actor_role, details) VALUES ($1,$2,$3,$4,$5,$6)',
    [id, ev, req.user.id, req.user.name || null, req.user.role, JSON.stringify(details)]);
}

/** A nurse may act on an elder's concerns when on the elder's care team (or when the elder has no team yet). */
async function nurseMayAct(db, req, patientId) {
  if (!isNurse(req)) return false;
  const { rows: [pc] } = await db.query('SELECT care_team_id, case_nurse_id FROM patient_care WHERE patient_id = $1', [patientId]);
  if (!pc || !pc.care_team_id) return true;
  if (pc.case_nurse_id === req.user.id) return true;
  const { rows } = await db.query('SELECT 1 FROM care_team_members WHERE team_id = $1 AND nurse_id = $2 AND removed_at IS NULL', [pc.care_team_id, req.user.id]);
  return rows.length > 0;
}

/** Open concerns of an elder, as kept with a handover. */
async function openConcerns(db, patientId) {
  const { rows } = await db.query("SELECT id, category, description, status, created_at FROM care_concerns WHERE patient_id = $1 AND status <> 'resolved' ORDER BY created_at", [patientId]);
  return rows.map((r) => ({ id: r.id, category: r.category, categoryLabel: c.CATEGORIES[r.category] || r.category, description: r.description, status: r.status, createdAt: r.created_at }));
}

router.post('/api/patients/:id/concerns', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!c.ID_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    const role = req.user && req.user.role;
    if (!(isNurse(req) || (role === 'caregiver' && req.user.patients.includes(patientId)))) {
      return forbid(res, "Only the elder's caregiver or a nurse can report a concern");
    }
    const v = c.validateConcern(req.body);
    if (!v.ok) return res.status(422).json({ error: 'validation_failed', details: v.errors });
    const row = await withTransaction(async (db) => {
      const { rows: [pc] } = await db.query('SELECT patient_name FROM patient_care WHERE patient_id = $1', [patientId]);
      const { rows: [{ n }] } = await db.query("SELECT nextval('care_concern_seq') AS n");
      const id = `CC-${String(n).padStart(6, '0')}`;
      const { rows: [r] } = await db.query(
        `INSERT INTO care_concerns (id, patient_id, patient_name, category, description, related, reported_by, reporter_name, reporter_role)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9) RETURNING *`,
        [id, patientId, pc ? pc.patient_name : null, v.value.category, v.value.description, JSON.stringify(v.value.related), req.user.id, req.user.name || null, role],
      );
      await event(db, req, id, 'reported', { category: v.value.category });
      return r;
    });
    logger.info('concern reported', { id: row.id, patientId, category: row.category, by: req.user.id });
    return res.status(201).json(toDto(row));
  } catch (err) {
    return next(err);
  }
});

router.get('/api/patients/:id/concerns', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!c.ID_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    const role = req.user && req.user.role;
    if (!(isNurse(req) || (role === 'caregiver' && req.user.patients.includes(patientId)))) return forbid(res, 'You cannot see the concerns for this elder');
    const { rows } = await pool.query('SELECT * FROM care_concerns WHERE patient_id = $1 ORDER BY (status = \'resolved\'), created_at DESC LIMIT 100', [patientId]);
    let list = rows;
    // A caregiver sees what they reported and whether a nurse has dealt with it.
    if (role === 'caregiver') list = rows.filter((r) => r.reported_by === req.user.id);
    let events = [];
    if (isNurse(req) && list.length) {
      ({ rows: events } = await pool.query('SELECT * FROM concern_events WHERE concern_id = ANY($1) ORDER BY at', [list.map((r) => r.id)]));
    }
    return res.json({ patientId, open: list.filter((r) => r.status !== 'resolved').length, concerns: list.map((r) => toDto(r, isNurse(req) ? events.filter((e) => e.concern_id === r.id) : null)) });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/clinic/concerns', async (req, res, next) => {
  try {
    if (!isNurse(req)) return forbid(res, 'Only nurses can see concerns across elders');
    const all = req.query.status === 'all';
    const { rows } = await pool.query(`SELECT * FROM care_concerns ${all ? '' : "WHERE status <> 'resolved'"} ORDER BY created_at DESC LIMIT 200`);
    return res.json({ open: rows.filter((r) => r.status !== 'resolved').length, concerns: rows.map((r) => toDto(r)) });
  } catch (err) {
    return next(err);
  }
});

function step(op) {
  return async (req, res, next) => {
    try {
      if (!isNurse(req)) return forbid(res, 'Only nurses can act on a concern');
      if (!CONCERN_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const b = req.body || {};
      let resolution = null;
      if (op === 'resolve') {
        const r = c.validateResolution(b);
        if (!r.ok) return res.status(422).json({ error: 'validation_failed', details: r.errors });
        resolution = r.value;
      }
      const note = typeof b.note === 'string' ? b.note.trim() : '';
      if (op === 'note' && (note.length < 3 || note.length > 1000)) return res.status(422).json({ error: 'validation_failed', details: ['note is required (3-1000 characters)'] });
      if (op === 'acknowledge' && note.length > 1000) return res.status(422).json({ error: 'validation_failed', details: ['note must be at most 1000 characters'] });

      const result = await withTransaction(async (db) => {
        const { rows: [row] } = await db.query('SELECT * FROM care_concerns WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!row) return { status: 404, body: { error: 'not_found', message: 'Concern not found' } };
        if (!(await nurseMayAct(db, req, row.patient_id))) return { status: 403, body: { error: 'not_on_care_team', message: "Only nurses on this elder's care team can act on the concern" } };
        const move = c.canMove(row.status, op);
        if (!move.ok) return { status: 409, body: { error: move.error, message: move.message } };
        let updated = row;
        if (op === 'acknowledge') {
          ({ rows: [updated] } = await db.query("UPDATE care_concerns SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now() WHERE id = $1 RETURNING *", [row.id, req.user.id]));
          await event(db, req, row.id, 'acknowledged', note ? { note } : {});
        } else if (op === 'note') {
          await event(db, req, row.id, 'note', { note });
        } else {
          ({ rows: [updated] } = await db.query(
            `UPDATE care_concerns SET status = 'resolved', resolved_by = $2, resolved_by_name = $3, resolved_at = now(), assessment = $4, action_taken = $5,
                    acknowledged_by = coalesce(acknowledged_by, $2), acknowledged_at = coalesce(acknowledged_at, now()) WHERE id = $1 RETURNING *`,
            [row.id, req.user.id, req.user.name || null, resolution.assessment, resolution.actionTaken],
          ));
          await event(db, req, row.id, 'resolved', resolution);
        }
        const { rows: events } = await db.query('SELECT * FROM concern_events WHERE concern_id = $1 ORDER BY at', [row.id]);
        return { status: 200, body: toDto(updated, events) };
      });
      if (result.status === 200) logger.info(`concern ${op}`, { id: req.params.id, by: req.user.id });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return next(err);
    }
  };
}
router.post('/api/clinic/concerns/:id/acknowledge', step('acknowledge'));
router.post('/api/clinic/concerns/:id/note', step('note'));
router.post('/api/clinic/concerns/:id/resolve', step('resolve'));

module.exports = { router, openConcerns };

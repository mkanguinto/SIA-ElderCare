'use strict';

const express = require('express');
const { pool, withTransaction } = require('./db');
const score = require('./riskScore');
const logger = require('./lib/logger');
const { request } = require('./lib/resilientHttp');
const { requireInternalToken, internalHeaders } = require('./lib/internalAuth');
const { validateVisit, validateVisitClose } = require('./visitValidation');

const router = express.Router();
router.use(requireInternalToken);

const ACTIVE = ['open', 'in_review', 'scheduled'];
const ADAPTER_URL = () => process.env.LEGACY_ADAPTER_URL || 'http://localhost:4004';
const PATIENT_SCOPED = ['caregiver', 'family_member'];
// A weather signal stops counting after this many hours unless a new weather check refreshes it.
const ENV_RISK_TTL_HOURS = Number(process.env.ENV_RISK_TTL_HOURS || 24);
// "Recent visits" = visits marked completed within this many days.
const RECENT_VISIT_DAYS = Number(process.env.RECENT_VISIT_DAYS || 30);
const UUID_RE = /^[0-9a-f-]{36}$/i;

function toDto(r) {
  return {
    id: r.id,
    patient: { id: r.patient_id, name: r.patient_name, zipCode: r.zip_code, assignedClinic: r.assigned_clinic, conditions: r.conditions, mobilityRestricted: r.mobility_restricted },
    scores: { total: r.total_score, health: r.health_score, environment: r.environment_score, emr: r.emr_score },
    priority: r.priority,
    category: r.category || score.CATEGORY[r.priority],
    priorityRule: r.priority_rule || null,
    status: r.status,
    reasons: r.reasons,
    assignedTo: r.assigned_to,
    lastEventAt: r.last_event_at,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    resolvedAt: r.resolved_at || null,
    resolvedBy: r.resolved_by || null,
    resolutionNotes: r.resolution_notes || null,
  };
}

function toVisitDto(r) {
  return {
    id: r.id,
    queueItemId: r.queue_item_id,
    patient: { id: r.patient_id, name: r.patient_name },
    visitType: r.visit_type,
    visitDate: r.visit_date,
    visitTime: String(r.visit_time).slice(0, 5),
    scheduledFor: r.scheduled_for,
    destination: r.destination,
    location: r.location,
    contactPhone: r.contact_phone,
    notes: r.notes,
    assignedTo: r.assigned_to,
    status: r.status,
    outcome: r.outcome,
    cancelledReason: r.cancelled_reason,
    createdBy: r.created_by,
    createdAt: r.created_at,
    completedAt: r.completed_at,
  };
}

function requireClinicStaff(req, res) {
  if (!req.user || req.user.role !== 'clinic_staff') {
    res.status(403).json({ error: 'forbidden', message: 'Only clinic staff can do this' });
    return false;
  }
  return true;
}

async function logAction(client, itemId, action, from, to, notes, by) {
  await client.query(
    `INSERT INTO followup_actions (queue_item_id, action, from_status, to_status, notes, performed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
    [itemId, action, from, to, notes || null, by],
  );
}

/**
 * Creates or updates the patient's single active triage item.
 * @param {object} patient  {id, fullName, zipCode, assignedClinic, conditions, mobilityRestricted}
 * @param {{health?:number, environment?:number, emr?:number}} signal  the scores this event changes
 * @param {object} reason   appended to the item's reasons list
 * @param {{onlyIfActive?:boolean, escalation?:boolean}} options
 *        onlyIfActive: do not open a new case (used for normal vitals)
 *        escalation:   a worsening signal may move a 'scheduled' case back to 'open'
 */
async function upsertQueueItem(patient, signal, reason, options = {}) {
  const attempt = () => withTransaction(async (client) => {
    // Idempotent receiver: the eventId is recorded in the SAME transaction as the queue change,
    // so a redelivered event is detected and a failed one rolls back together with its key.
    if (options.eventId) {
      const ins = await client.query('INSERT INTO processed_events (event_id) VALUES ($1) ON CONFLICT DO NOTHING', [options.eventId]);
      if (!ins.rowCount) return { item: null, created: false, duplicate: true };
    }
    const { rows: [existing] } = await client.query(
      `SELECT * FROM risk_queue WHERE patient_id = $1 AND status = ANY($2) FOR UPDATE`, [patient.id, ACTIVE],
    );
    if (!existing && options.onlyIfActive) return { item: null, created: false, skipped: true };
    // Out-of-order protection: an older check-in delivered late (outbox retry) must not override a newer one.
    if (signal.health !== undefined && existing && existing.health_at && options.healthAt
        && new Date(options.healthAt) < new Date(existing.health_at)) {
      return { item: existing, created: false, stale: true };
    }
    const healthAt = signal.health !== undefined ? (options.healthAt ? new Date(options.healthAt) : new Date()) : existing ? existing.health_at : null;

    const health = signal.health !== undefined ? signal.health : existing ? existing.health_score : 0;
    let environment = signal.environment !== undefined ? signal.environment : existing ? existing.environment_score : 0;
    // Weather risk expires: a stale environment signal no longer keeps a patient out of Routine.
    if (signal.environment === undefined && existing && existing.environment_at
        && Date.now() - new Date(existing.environment_at).getTime() > ENV_RISK_TTL_HOURS * 3600000) {
      environment = 0;
    }
    const environmentAt = signal.environment !== undefined ? new Date() : existing ? existing.environment_at : null;
    const emr = signal.emr !== undefined ? signal.emr : existing ? existing.emr_score : 0;
    const conditions = patient.conditions || (existing && existing.conditions) || [];
    const mobilityRestricted = patient.mobilityRestricted !== undefined ? patient.mobilityRestricted : Boolean(existing && existing.mobility_restricted);
    const c = score.classify({ health, environment, emr, conditions, mobilityRestricted });

    if (existing) {
      const reasons = [reason, ...existing.reasons].slice(0, 20);
      const { rows: [row] } = await client.query(
        `UPDATE risk_queue SET health_score = $2, environment_score = $3, emr_score = $4, total_score = $5, priority = $6,
                reasons = $7, conditions = $8, mobility_restricted = $9, category = $10, priority_rule = $11, environment_at = $12,
                health_at = $14, last_event_at = now(), updated_at = now(),
                status = CASE WHEN status = 'scheduled' AND $6 IN ('P1','P2') AND $13 THEN 'open' ELSE status END
          WHERE id = $1 RETURNING *`,
        [existing.id, health, environment, emr, c.total, c.priority, JSON.stringify(reasons), conditions, mobilityRestricted,
          c.category, c.rule, environmentAt, Boolean(options.escalation), healthAt],
      );
      if (row.priority !== existing.priority) {
        await logAction(client, row.id, 'priority_change', existing.status, row.status, `${existing.priority} -> ${row.priority}. ${c.rule}`, 'system');
      }
      return { item: row, created: false, previousPriority: existing.priority };
    }
    const { rows: [row] } = await client.query(
      `INSERT INTO risk_queue (patient_id, patient_name, zip_code, assigned_clinic, conditions, mobility_restricted,
                               health_score, environment_score, emr_score, total_score, priority, reasons, category, priority_rule, environment_at, health_at)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16) RETURNING *`,
      [patient.id, patient.fullName || patient.id, patient.zipCode || null, patient.assignedClinic || null, conditions, mobilityRestricted,
        health, environment, emr, c.total, c.priority, JSON.stringify([reason]), c.category, c.rule, environmentAt, healthAt],
    );
    return { item: row, created: true };
  });

  try {
    return await attempt();
  } catch (err) {
    if (err.code === '23505') return attempt(); // concurrent insert for same patient -> retry as update
    throw err;
  }
}

/* ---------------------------- GET /api/clinic/queue -------------------------- */
router.get('/api/clinic/queue', async (req, res, next) => {
  try {
    const statuses = String(req.query.status || 'open,in_review,scheduled').split(',').filter((s) => score.VALID_TRANSITIONS[s]);
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const params = [statuses.length ? statuses : ACTIVE, limit];
    let clinicFilter = '';
    if (req.query.clinic) { params.push(req.query.clinic); clinicFilter = `AND assigned_clinic = $${params.length}`; }
    if (req.query.priority) { params.push(String(req.query.priority).split(',')); clinicFilter += ` AND priority = ANY($${params.length})`; }
    if (req.query.category) { params.push(String(req.query.category).split(',')); clinicFilter += ` AND category = ANY($${params.length})`; }
    if (req.query.patientId) { params.push(String(req.query.patientId)); clinicFilter += ` AND patient_id = $${params.length}`; }

    const [{ rows }, { rows: counts }] = await Promise.all([
      pool.query(`SELECT * FROM risk_queue WHERE status = ANY($1) ${clinicFilter} ORDER BY priority ASC, total_score DESC, last_event_at DESC LIMIT $2`, params),
      pool.query(`SELECT priority, count(*)::int AS n FROM risk_queue WHERE status = ANY($1) GROUP BY priority`, [ACTIVE]),
    ]);
    res.json({
      generatedAt: new Date().toISOString(),
      summary: { P1: 0, P2: 0, P3: 0, P4: 0, ...Object.fromEntries(counts.map((c) => [c.priority, c.n])) },
      thresholds: score.THRESHOLDS,
      items: rows.map(toDto),
    });
  } catch (err) {
    next(err);
  }
});

/* ------------------------ PATCH /api/clinic/queue/:itemId -------------------- */
router.patch('/api/clinic/queue/:itemId', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'clinic_staff') return res.status(403).json({ error: 'forbidden' });
    if (!/^[0-9a-f-]{36}$/i.test(req.params.itemId)) return res.status(400).json({ error: 'bad_request', message: 'Invalid item id' });
    const { status, notes, assignedTo } = req.body || {};
    if (status === undefined && notes === undefined && assignedTo === undefined) {
      return res.status(422).json({ error: 'validation_failed', details: ['Provide status, notes and/or assignedTo'] });
    }
    if (notes !== undefined && (typeof notes !== 'string' || notes.length > 2000)) {
      return res.status(422).json({ error: 'validation_failed', details: ['notes must be a string up to 2000 characters'] });
    }

    const result = await withTransaction(async (client) => {
      const { rows: [item] } = await client.query('SELECT * FROM risk_queue WHERE id = $1 FOR UPDATE', [req.params.itemId]);
      if (!item) return { status: 404, body: { error: 'not_found' } };
      if (status !== undefined && status !== item.status && !score.VALID_TRANSITIONS[item.status].includes(status)) {
        return { status: 409, body: { error: 'invalid_transition', message: `Cannot move from ${item.status} to ${status}` } };
      }
      if (status === 'scheduled' && item.status !== 'scheduled') {
        return { status: 422, body: { error: 'visit_details_required', message: 'Use POST /api/clinic/queue/:itemId/visits with date, time, destination and location to schedule a visit' } };
      }
      const closing = ['resolved', 'dismissed'].includes(status) && status !== item.status;
      const { rows: [updated] } = await client.query(
        `UPDATE risk_queue SET status = coalesce($2, status), assigned_to = coalesce($3, assigned_to), updated_at = now(),
                resolved_at = CASE WHEN $4 THEN now() ELSE resolved_at END,
                resolved_by = CASE WHEN $4 THEN $5 ELSE resolved_by END,
                resolution_notes = CASE WHEN $4 THEN $6 ELSE resolution_notes END
          WHERE id = $1 RETURNING *`,
        [item.id, status || null, assignedTo || null, closing, req.user.id, notes || null],
      );
      if (closing) {
        await client.query(
          `UPDATE scheduled_visits SET status = 'cancelled', cancelled_reason = $2, updated_at = now() WHERE queue_item_id = $1 AND status = 'scheduled'`,
          [item.id, `Case ${status}`],
        );
      }
      await client.query(
        `INSERT INTO followup_actions (queue_item_id, action, from_status, to_status, notes, performed_by) VALUES ($1,$2,$3,$4,$5,$6)`,
        [item.id, status && status !== item.status ? 'status_change' : 'note', item.status, updated.status, notes || null, req.user.id],
      );
      const { rows: actions } = await client.query('SELECT * FROM followup_actions WHERE queue_item_id = $1 ORDER BY created_at DESC LIMIT 20', [item.id]);
      return { status: 200, body: { item: toDto(updated), followUps: actions } };
    });
    logger.info('triage item updated', { itemId: req.params.itemId, by: req.user.id, status });
    return res.status(result.status).json(result.body);
  } catch (err) {
    return next(err);
  }
});

/* ----------------- GET /api/clinic/patients/:id/emr-history ------------------ */
// Pulls legacy EMR history through the SOAP adapter and folds it into the risk score.
router.get('/api/clinic/patients/:id/emr-history', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(patientId)) return res.status(400).json({ error: 'bad_request' });
    let history;
    try {
      const r = await request('legacy-adapter', {
        method: 'GET', url: `${ADAPTER_URL()}/legacy/patients/${encodeURIComponent(patientId)}/history`, headers: internalHeaders(req.get('x-request-id')),
      }, { retries: 1, timeoutMs: 8000 });
      history = r.data;
    } catch (err) {
      if (err.response && err.response.status === 404) return res.status(404).json({ error: 'not_found', message: 'No legacy EMR record for this patient' });
      logger.warn('legacy EMR unavailable', { patientId, error: err.message });
      return res.status(503).json({ error: 'legacy_emr_unavailable', message: 'Legacy clinic EMR is temporarily unavailable' });
    }

    const emr = score.emrScore(history);
    const { rows: [active] } = await pool.query('SELECT * FROM risk_queue WHERE patient_id = $1 AND status = ANY($2)', [patientId, ACTIVE]);
    let item = active || null;
    // Only touch the queue when the EMR contribution actually changes; simply viewing the
    // history must not add a new reason line every time a nurse opens the patient.
    if (active && active.emr_score !== emr) {
      ({ item } = await upsertQueueItem({ id: patientId }, { emr }, {
        type: 'emr_enrichment',
        at: new Date().toISOString(),
        detail: `Legacy EMR history added ${emr} risk point${emr === 1 ? '' : 's'} (recent admissions and chronic diagnoses)`,
      }));
    }
    return res.json({ history, emrScore: emr, queueItem: item ? toDto(item) : null });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------- Scheduled visits ------------------------------ */

// POST /api/clinic/queue/:itemId/visits   (clinic staff) - schedule (or reschedule) a visit for a case
router.post('/api/clinic/queue/:itemId/visits', async (req, res, next) => {
  try {
    if (!requireClinicStaff(req, res)) return undefined;
    if (!UUID_RE.test(req.params.itemId)) return res.status(400).json({ error: 'bad_request', message: 'Invalid item id' });
    const r = validateVisit(req.body);
    if (!r.ok) return res.status(422).json({ error: 'validation_failed', details: r.errors });
    const v = r.value;

    const result = await withTransaction(async (client) => {
      const { rows: [item] } = await client.query('SELECT * FROM risk_queue WHERE id = $1 FOR UPDATE', [req.params.itemId]);
      if (!item) return { status: 404, body: { error: 'not_found', message: 'Case not found' } };
      if (!ACTIVE.includes(item.status)) return { status: 409, body: { error: 'case_closed', message: `This case is already ${item.status}` } };

      // Rescheduling: the previous open visit for this case is cancelled, not deleted (kept for history).
      const { rows: replaced } = await client.query(
        `UPDATE scheduled_visits SET status = 'cancelled', cancelled_reason = 'Rescheduled', updated_at = now()
          WHERE queue_item_id = $1 AND status = 'scheduled' RETURNING id`, [item.id],
      );
      const { rows: [visit] } = await client.query(
        `INSERT INTO scheduled_visits (queue_item_id, patient_id, patient_name, visit_type, visit_date, visit_time, scheduled_for,
                                       destination, location, contact_phone, notes, assigned_to, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13) RETURNING *`,
        [item.id, item.patient_id, item.patient_name, v.visitType, v.visitDate, v.visitTime, v.scheduledFor,
          v.destination, v.location, v.contactPhone || null, v.notes || null, v.assignedTo || req.user.id, req.user.id],
      );
      const { rows: [updated] } = await client.query(
        `UPDATE risk_queue SET status = 'scheduled', assigned_to = $2, updated_at = now() WHERE id = $1 RETURNING *`,
        [item.id, v.assignedTo || req.user.id],
      );
      await logAction(client, item.id, replaced.length ? 'visit_rescheduled' : 'visit_scheduled', item.status, 'scheduled',
        `${v.visitType.replace('_', ' ')} on ${v.visitDate} ${v.visitTime} at ${v.destination} (${v.location})${v.notes ? `. ${v.notes}` : ''}`, req.user.id);
      return { status: 201, body: { visit: toVisitDto(visit), item: toDto(updated), replacedVisitIds: replaced.map((x) => x.id) } };
    });
    logger.info('visit scheduled', { itemId: req.params.itemId, by: req.user.id, status: result.status });
    return res.status(result.status).json(result.body);
  } catch (err) {
    return next(err);
  }
});

// GET /api/clinic/visits?view=upcoming|recent|all&patientId=&days=&limit=
//   upcoming: status 'scheduled', soonest first (includes visits up to 12 hours overdue)
//   recent:   status 'completed' with completed_at in the last RECENT_VISIT_DAYS days (default 30) - this is
//             exactly what populates the clinic's "Recent visits" list
// Caregivers / family members (via GET /api/patients/:id/visits) only see their own patients' visits.
router.get('/api/clinic/visits', async (req, res, next) => {
  try {
    const view = ['upcoming', 'recent', 'all'].includes(req.query.view) ? req.query.view : 'upcoming';
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || RECENT_VISIT_DAYS, 1), 365);
    const patientId = req.query.patientId ? String(req.query.patientId) : null;
    if (req.user && PATIENT_SCOPED.includes(req.user.role) && (!patientId || !req.user.patients.includes(patientId))) {
      return res.status(403).json({ error: 'forbidden', message: 'You are not assigned to this patient' });
    }
    const params = [limit];
    const where = [];
    if (patientId) { params.push(patientId); where.push(`patient_id = $${params.length}`); }
    let order = 'scheduled_for DESC';
    if (view === 'upcoming') { where.push(`status = 'scheduled' AND scheduled_for >= now() - interval '12 hours'`); order = 'scheduled_for ASC'; }
    if (view === 'recent') { params.push(String(days)); where.push(`status = 'completed' AND completed_at >= now() - ($${params.length} || ' days')::interval`); order = 'completed_at DESC'; }
    const { rows } = await pool.query(
      `SELECT * FROM scheduled_visits ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY ${order} LIMIT $1`, params,
    );
    return res.json({ view, days: view === 'recent' ? days : undefined, visits: rows.map(toVisitDto) });
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/clinic/visits/:visitId   (clinic staff) { status: completed|cancelled|no_show, outcome, resolveCase }
//   completed (+ resolveCase) -> case resolved and moved to history; completed (no resolve) -> case back to in_review
//   cancelled / no_show       -> case back to open so it can be rescheduled
router.patch('/api/clinic/visits/:visitId', async (req, res, next) => {
  try {
    if (!requireClinicStaff(req, res)) return undefined;
    if (!UUID_RE.test(req.params.visitId)) return res.status(400).json({ error: 'bad_request', message: 'Invalid visit id' });
    const r = validateVisitClose(req.body);
    if (!r.ok) return res.status(422).json({ error: 'validation_failed', details: r.errors });
    const { status, outcome, resolveCase } = r.value;

    const result = await withTransaction(async (client) => {
      const { rows: [visit] } = await client.query('SELECT * FROM scheduled_visits WHERE id = $1 FOR UPDATE', [req.params.visitId]);
      if (!visit) return { status: 404, body: { error: 'not_found', message: 'Visit not found' } };
      if (visit.status !== 'scheduled') return { status: 409, body: { error: 'invalid_transition', message: `This visit is already ${visit.status}` } };

      const { rows: [updatedVisit] } = await client.query(
        `UPDATE scheduled_visits SET status = $2, outcome = $3, updated_at = now(),
                completed_at = CASE WHEN $2 = 'completed' THEN now() ELSE completed_at END,
                cancelled_reason = CASE WHEN $2 <> 'completed' THEN $3 ELSE cancelled_reason END
          WHERE id = $1 RETURNING *`,
        [visit.id, status, outcome],
      );

      let item = null;
      if (visit.queue_item_id) {
        const { rows: [current] } = await client.query('SELECT * FROM risk_queue WHERE id = $1 FOR UPDATE', [visit.queue_item_id]);
        if (current && ACTIVE.includes(current.status)) {
          let next;
          if (status === 'completed') next = resolveCase ? 'resolved' : 'in_review';
          else next = 'open';
          const closing = next === 'resolved';
          ({ rows: [item] } = await client.query(
            `UPDATE risk_queue SET status = $2, updated_at = now(),
                    resolved_at = CASE WHEN $3 THEN now() ELSE resolved_at END,
                    resolved_by = CASE WHEN $3 THEN $4 ELSE resolved_by END,
                    resolution_notes = CASE WHEN $3 THEN $5 ELSE resolution_notes END
              WHERE id = $1 RETURNING *`,
            [current.id, next, closing, req.user.id, closing ? `Visit completed: ${outcome}` : null],
          ));
          await logAction(client, current.id, `visit_${status}`, current.status, next, outcome, req.user.id);
        }
      }
      return { status: 200, body: { visit: toVisitDto(updatedVisit), item: item ? toDto(item) : null } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    return next(err);
  }
});

/* ---------------------------- Resolved case history ---------------------------- */

// GET /api/clinic/queue/history?patientId=&outcome=resolved|dismissed&from=YYYY-MM-DD&to=YYYY-MM-DD&limit=
router.get('/api/clinic/queue/history', async (req, res, next) => {
  try {
    const limit = Math.min(Math.max(parseInt(req.query.limit, 10) || 50, 1), 200);
    const params = [limit];
    const where = [`q.status IN ('resolved','dismissed')`];
    if (['resolved', 'dismissed'].includes(req.query.outcome)) { params.push(req.query.outcome); where.push(`q.status = $${params.length}`); }
    if (req.query.patientId) { params.push(String(req.query.patientId)); where.push(`q.patient_id = $${params.length}`); }
    for (const [key, op] of [['from', '>='], ['to', '<']]) {
      const d = String(req.query[key] || '');
      if (!d) continue;
      if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) return res.status(422).json({ error: 'validation_failed', details: [`${key} must be YYYY-MM-DD`] });
      params.push(d);
      where.push(key === 'to' ? `q.resolved_at < ($${params.length}::date + 1)` : `q.resolved_at ${op} $${params.length}::date`);
    }
    const { rows } = await pool.query(
      `SELECT q.*,
              coalesce((SELECT json_agg(f ORDER BY f.created_at DESC) FROM
                 (SELECT action, from_status, to_status, notes, performed_by, created_at FROM followup_actions
                   WHERE queue_item_id = q.id ORDER BY created_at DESC LIMIT 15) f), '[]') AS followups,
              coalesce((SELECT json_agg(v ORDER BY v.scheduled_for DESC) FROM
                 (SELECT id, visit_type, visit_date, to_char(visit_time, 'HH24:MI') AS visit_time, destination, status, outcome, completed_at, scheduled_for
                    FROM scheduled_visits WHERE queue_item_id = q.id) v), '[]') AS visits
         FROM risk_queue q WHERE ${where.join(' AND ')}
        ORDER BY q.resolved_at DESC NULLS LAST LIMIT $1`,
      params,
    );
    const { rows: [counts] } = await pool.query(
      `SELECT count(*) FILTER (WHERE status = 'resolved')::int AS resolved, count(*) FILTER (WHERE status = 'dismissed')::int AS dismissed,
              count(*) FILTER (WHERE status IN ('resolved','dismissed') AND resolved_at >= now() - interval '30 days')::int AS last30days
         FROM risk_queue`,
    );
    return res.json({
      summary: counts,
      cases: rows.map((r) => ({
        ...toDto(r),
        openedAt: r.created_at,
        durationHours: r.resolved_at ? Math.round((new Date(r.resolved_at) - new Date(r.created_at)) / 36e5 * 10) / 10 : null,
        followUps: r.followups,
        visits: r.visits,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------ Event consumer ------------------------------ */
// Consumes checkin.* and weather.risk_detected from RabbitMQ (queue clinic-risk-service.events)
// or, in EVENT_TRANSPORT=http mode, from POST /internal/events. Idempotent on eventId.
const HANDLED = ['checkin.normal', 'checkin.anomaly_detected', 'checkin.missed', 'weather.risk_detected'];

/** @returns {Promise<{status:number, body:object}>} throws on failure so the broker retries */
async function handleEvent(evt) {
  if (!evt || !evt.eventId || !evt.type || !evt.patient || !evt.patient.id) {
    const err = new Error('eventId, type and patient.id are required');
    err.permanent = true;
    err.status = 400;
    throw err;
  }
  if (!HANDLED.includes(evt.type)) return { status: 202, body: { ignored: true } };

  let signal;
  let reason;
  let options;
  switch (evt.type) {
    case 'checkin.normal': {
      // Normal vitals de-escalate an OPEN case (health score -> 0). They never open a new case.
      const v = (evt.checkin && evt.checkin.vitals) || {};
      const parts = [v.systolic && `BP ${v.systolic}/${v.diastolic}`, v.heartRate && `HR ${v.heartRate}`, v.temperatureC && `${v.temperatureC} °C`, v.spo2 && `SpO2 ${v.spo2}%`].filter(Boolean);
      signal = { health: 0 };
      options = { onlyIfActive: true, healthAt: evt.checkin && evt.checkin.recordedAt };
      reason = {
        type: 'vitals_normal',
        at: evt.occurredAt,
        severity: 'none',
        detail: `Normal check-in recorded${parts.length ? `: ${parts.join(', ')}` : ''}. Health risk cleared.`,
        checkinId: evt.checkin ? evt.checkin.id : undefined,
      };
      break;
    }
    case 'checkin.anomaly_detected':
    case 'checkin.missed':
      signal = { health: Number(evt.severityScore) || 0 };
      reason = {
        type: evt.type === 'checkin.missed' ? 'missed_checkin' : 'health_anomaly',
        at: evt.occurredAt,
        severity: evt.severity,
        detail: (evt.anomalies || []).map((a) => (a.value !== undefined ? `${a.message} (${a.value})` : a.message)).join('; '),
        checkinId: evt.checkin ? evt.checkin.id : undefined,
      };
      options = { escalation: true, healthAt: evt.checkin ? evt.checkin.recordedAt : evt.occurredAt };
      break;
    default: // weather.risk_detected
      signal = { environment: score.environmentScore(evt.environment) };
      reason = {
        type: 'environmental_risk',
        at: evt.occurredAt,
        hazard: evt.environment.hazard,
        detail: evt.environment.hazard === 'heat'
          ? `Heat index ${evt.environment.heatIndexC} °C in their area (${String(evt.environment.level || '').replace(/_/g, ' ')} level). A preventive check is recommended.`
          : `Severe weather in their area: ${(evt.environment.reasons || []).join('; ')}. Patient has limited mobility, so check evacuation plans.`,
      };
      options = { escalation: true };
  }

  const r = await upsertQueueItem(evt.patient, signal, reason, { ...options, eventId: evt.eventId });
  if (r.duplicate) return { status: 200, body: { duplicate: true } };
  if (r.skipped) return { status: 202, body: { ignored: true, reason: 'no open case for this patient' } };
  if (r.stale) return { status: 202, body: { ignored: true, reason: 'older than the latest reading' } };
  logger.info(r.created ? 'triage item created' : 'triage item updated', {
    itemId: r.item.id, patientId: r.item.patient_id, total: r.item.total_score, priority: r.item.priority, previousPriority: r.previousPriority, eventType: evt.type, eventId: evt.eventId,
  });
  return { status: r.created ? 201 : 200, body: { item: toDto(r.item), created: r.created, previousPriority: r.previousPriority || null } };
}

/* --------------------------- POST /internal/events --------------------------- */
// HTTP fallback (EVENT_TRANSPORT=http) and manual testing with Postman.
router.post('/internal/events', async (req, res, next) => {
  try {
    const { status, body } = await handleEvent(req.body);
    return res.status(status).json(body);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: 'bad_request', message: err.message });
    return next(err);
  }
});

module.exports = router;
module.exports.upsertQueueItem = upsertQueueItem;
module.exports.handleEvent = handleEvent;

'use strict';

/**
 * Care teams, case ownership, nurse handover and duty coverage (Batch 2).
 *
 *   POST /api/clinic/handover                     {patientId, toNurseId, concern, actionTaken, pendingAction, dueTime}   nurse holding the case
 *   POST /api/clinic/handover/:id/accept|decline  {note?, acknowledgeOpenItems?}   incoming nurse (open concerns must be acknowledged)
 *   POST /api/clinic/handover/:id/cancel          {note?}   outgoing nurse
 *   GET  /api/clinic/my-cases                     elders whose case I hold, with the open queue item and any outgoing handover
 *   GET  /api/clinic/queue/pending-handovers      {incoming, outgoing} pending handovers for me
 *   GET  /api/clinic/patients/:id/care            care team, case nurse, duty, handover chain (nurses)
 *   GET  /api/clinic/patients/:id/care-summary    care team and case nurse names (the elder's caregiver / family, nurses)
 *   GET  /api/clinic/duty                         nurses and whether they are on duty
 *   PUT  /api/clinic/duty/me                      {onDuty}  set by the nurse; independent of login sessions
 *   GET  /api/clinic/care-teams                   teams, members, elders, monitoring plans (nurses, admin; no clinical content)
 *   POST /api/clinic/care-teams                   {id, name, clinicId}                admin
 *   POST /api/clinic/care-teams/:id/members       {nurseId, nurseName, teamRole}      admin
 *   DELETE /api/clinic/care-teams/:id/members/:nurseId                                admin
 *   PUT  /api/clinic/patients/:id/care            {patientName, careTeamId, monitoringPlanId, caseNurseId}   admin
 *   GET  /api/clinic/care-log                     who changed teams, assignments, duty and handovers   admin
 */
const express = require('express');
const { pool, withTransaction } = require('./db');
const logger = require('./lib/logger');
const { requireInternalToken } = require('./lib/internalAuth');
const { validateHandover, canSubmit, respond, isOverdue } = require('./handover');
const { handoverAcknowledgement } = require('./concerns');
// eslint-disable-next-line global-require
const openConcerns = (db, patientId) => require('./concernRoutes').openConcerns(db, patientId);

const router = express.Router();
router.use('/api/clinic', requireInternalToken);

const ACTIVE = ['open', 'in_review', 'scheduled'];
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const isNurse = (req) => req.user && req.user.role === 'clinic_staff';
const isAdmin = (req) => req.user && req.user.role === 'system_admin';
const forbid = (res, message) => res.status(403).json({ error: 'forbidden', message });
/** Teams this nurse leads (team_role = 'lead'). A team-lead nurse registers and links elders for those teams. */
async function leadTeams(nurseId, db = pool) {
  if (!nurseId) return [];
  const { rows } = await db.query(`SELECT team_id FROM care_team_members WHERE nurse_id = $1 AND team_role = 'lead' AND removed_at IS NULL`, [nurseId]);
  return rows.map((r) => r.team_id);
}

// GET /internal/staff/:id/lead-teams   (gateway) - which teams a nurse leads, for the team-lead tools
router.get('/internal/staff/:id/lead-teams', requireInternalToken, async (req, res, next) => {
  try {
    return res.json({ nurseId: req.params.id, teams: await leadTeams(req.params.id) });
  } catch (err) {
    return next(err);
  }
});
// eslint-disable-next-line global-require
const queueDto = (r) => require('./routes').toDto(r);

function toHandoverDto(r) {
  const h = {
    id: r.id,
    patient: { id: r.patient_id, name: r.patient_name || null },
    queueItemId: r.queue_item_id,
    fromNurse: { id: r.from_nurse, name: r.from_nurse_name },
    toNurse: { id: r.to_nurse, name: r.to_nurse_name },
    concern: r.concern,
    actionTaken: r.action_taken,
    pendingAction: r.pending_action,
    dueTime: r.due_time,
    status: r.status,
    createdAt: r.created_at,
    respondedAt: r.responded_at,
    respondedBy: r.responded_by,
    responseNote: r.response_note,
    priority: r.priority || null,
    // Open concerns when the handover was sent; the incoming nurse confirms reading them when accepting.
    openItems: r.open_items || [],
    openItemsAcknowledged: r.open_items_acknowledged ?? null,
  };
  h.overdue = isOverdue(h);
  return h;
}

async function careLog(client, req, action, { patientId = null, teamId = null, details = {} } = {}) {
  await client.query(
    'INSERT INTO care_assignment_log (action, actor_id, actor_role, patient_id, team_id, details) VALUES ($1,$2,$3,$4,$5,$6)',
    [action, req.user.id, req.user.role, patientId, teamId, JSON.stringify(details)],
  );
}

async function followUp(client, itemId, action, notes, by) {
  if (!itemId) return;
  await client.query('INSERT INTO followup_actions (queue_item_id, action, notes, performed_by) VALUES ($1,$2,$3,$4)', [itemId, action, notes, by]);
}

/** patient_care row + the active members of its team. */
async function loadCare(db, patientId, lock = false) {
  const { rows: [pc] } = await db.query(`SELECT * FROM patient_care WHERE patient_id = $1 ${lock ? 'FOR UPDATE' : ''}`, [patientId]);
  if (!pc) return null;
  const { rows: members } = await db.query(
    `SELECT nurse_id, nurse_name, team_role FROM care_team_members WHERE team_id = $1 AND removed_at IS NULL ORDER BY (team_role = 'lead') DESC, nurse_name`, [pc.care_team_id],
  );
  return { row: pc, members, caseNurseId: pc.case_nurse_id, teamNurseIds: members.map((m) => m.nurse_id) };
}

/* --------------------------------- handover --------------------------------- */
router.post('/api/clinic/handover', async (req, res, next) => {
  try {
    if (!isNurse(req)) return forbid(res, 'Only nurses can hand over a case');
    const v = validateHandover(req.body);
    if (!v.ok) return res.status(422).json({ error: 'validation_failed', details: v.errors });
    const h = v.value;
    const result = await withTransaction(async (client) => {
      const care = await loadCare(client, h.patientId, true);
      const allowed = canSubmit(care, req.user.id, h.toNurseId);
      if (!allowed.ok) return { status: allowed.status, body: { error: allowed.error, message: allowed.message } };
      const { rows: [item] } = await client.query('SELECT id FROM risk_queue WHERE patient_id = $1 AND status = ANY($2) FOR UPDATE', [h.patientId, ACTIVE]);
      const to = care.members.find((m) => m.nurse_id === h.toNurseId);
      const open = await openConcerns(client, h.patientId);
      const { rows: [row] } = await client.query(
        `INSERT INTO handover_record (patient_id, queue_item_id, from_nurse, from_nurse_name, to_nurse, to_nurse_name, concern, action_taken, pending_action, due_time, open_items)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
        [h.patientId, item ? item.id : null, req.user.id, req.user.name || care.row.case_nurse_name, to.nurse_id, to.nurse_name,
          h.concern, h.actionTaken, h.pendingAction, h.dueTime, JSON.stringify(open)],
      );
      if (item) await client.query(`UPDATE risk_queue SET handover_status = 'pending', updated_at = now() WHERE id = $1`, [item.id]);
      await followUp(client, item && item.id, 'handover_submitted', `Handover to ${to.nurse_name} pending acceptance. Due ${h.dueTime.toISOString()}`, req.user.id);
      await careLog(client, req, 'handover_submitted', { patientId: h.patientId, details: { handoverId: row.id, from: req.user.id, to: to.nurse_id } });
      return { status: 201, body: { handover: toHandoverDto({ ...row, patient_name: care.row.patient_name }) } };
    });
    if (result.status === 201) logger.info('handover submitted', { handoverId: result.body.handover.id, from: req.user.id, to: result.body.handover.toNurse.id });
    return res.status(result.status).json(result.body);
  } catch (err) {
    if (err.code === '23505') return res.status(409).json({ error: 'handover_pending', message: 'This elder already has a handover waiting for acceptance' });
    return next(err);
  }
});

function answer(op) {
  return async (req, res, next) => {
    try {
      if (!isNurse(req)) return forbid(res, 'Only nurses can answer a handover');
      if (!UUID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const note = req.body && req.body.note;
      if (note !== undefined && note !== null && (typeof note !== 'string' || note.length > 500)) {
        return res.status(422).json({ error: 'validation_failed', details: ['note must be a string of at most 500 characters'] });
      }
      if (op === 'decline' && (!note || note.trim().length < 3)) {
        return res.status(422).json({ error: 'validation_failed', details: ['note is required when declining (say why, 3-500 characters)'] });
      }
      const result = await withTransaction(async (client) => {
        const { rows: [row] } = await client.query('SELECT * FROM handover_record WHERE id = $1 FOR UPDATE', [req.params.id]);
        const r = respond(row && { status: row.status, fromNurse: row.from_nurse, toNurse: row.to_nurse }, op, req.user.id);
        if (!r.ok) return { status: r.status, body: { error: r.error, message: r.message } };
        if (op === 'accept') {
          const ack = handoverAcknowledgement(row.open_items, req.body);
          if (!ack.ok) return { status: 422, body: { error: 'acknowledge_open_items', message: ack.message, openItems: row.open_items } };
        }
        const care = await loadCare(client, row.patient_id, true);
        if (r.transfersCase) {
          // The case can only have moved through this handover, but never transfer a case the outgoing nurse no longer holds.
          if (care.caseNurseId !== row.from_nurse) return { status: 409, body: { error: 'case_moved', message: 'The case is no longer held by the outgoing nurse' } };
          if (!care.teamNurseIds.includes(req.user.id)) return { status: 409, body: { error: 'not_on_team', message: "You are no longer on this elder's care team" } };
          await client.query(
            'UPDATE patient_care SET case_nurse_id = $2, case_nurse_name = $3, case_since = now(), updated_by = $2, updated_at = now() WHERE patient_id = $1',
            [row.patient_id, row.to_nurse, row.to_nurse_name],
          );
        }
        const { rows: [updated] } = await client.query(
          'UPDATE handover_record SET status = $2, responded_at = now(), responded_by = $3, response_note = $4, open_items_acknowledged = $5 WHERE id = $1 RETURNING *',
          [row.id, r.status, req.user.id, note ? note.trim() : null, op === 'accept' && (row.open_items || []).length ? true : null],
        );
        const { rows: items } = await client.query(
          `UPDATE risk_queue SET handover_status = $2, assigned_to = CASE WHEN $3 THEN $4 ELSE assigned_to END, updated_at = now()
            WHERE patient_id = $1 AND status = ANY($5) RETURNING id`,
          [row.patient_id, r.transfersCase ? 'accepted' : 'none', r.transfersCase, row.to_nurse, ACTIVE],
        );
        if (r.transfersCase) {
          // Each open concern's history shows who took it over (the concern itself stays open).
          for (const it of row.open_items || []) {
            await client.query(
              `INSERT INTO concern_events (concern_id, event, actor_id, actor_name, actor_role, details)
               SELECT $1, 'handed_over', $2, $3, 'clinic_staff', $4 WHERE EXISTS (SELECT 1 FROM care_concerns WHERE id = $1 AND status <> 'resolved')`,
              [it.id, req.user.id, row.to_nurse_name, JSON.stringify({ from: row.from_nurse_name, to: row.to_nurse_name, handoverId: row.id })],
            );
          }
        }
        const words = { accepted: `Handover accepted by ${row.to_nurse_name}: case moved from ${row.from_nurse_name}`, declined: `Handover declined by ${row.to_nurse_name}: ${note}`, cancelled: `Handover cancelled by ${row.from_nurse_name}` };
        for (const it of items) await followUp(client, it.id, `handover_${r.status}`, words[r.status], req.user.id);
        await careLog(client, req, `handover_${r.status}`, { patientId: row.patient_id, details: { handoverId: row.id, from: row.from_nurse, to: row.to_nurse } });
        return { status: 200, body: { handover: toHandoverDto({ ...updated, patient_name: care.row.patient_name }), caseNurse: r.transfersCase ? { id: row.to_nurse, name: row.to_nurse_name } : { id: care.caseNurseId, name: care.row.case_nurse_name } } };
      });
      if (result.status === 200) logger.info(`handover ${op}`, { handoverId: req.params.id, by: req.user.id });
      return res.status(result.status).json(result.body);
    } catch (err) {
      return next(err);
    }
  };
}
router.post('/api/clinic/handover/:id/accept', answer('accept'));
router.post('/api/clinic/handover/:id/decline', answer('decline'));
router.post('/api/clinic/handover/:id/cancel', answer('cancel'));

const HANDOVER_SELECT = `SELECT h.*, pc.patient_name, q.priority FROM handover_record h
  JOIN patient_care pc ON pc.patient_id = h.patient_id
  LEFT JOIN risk_queue q ON q.patient_id = h.patient_id AND q.status IN ('open', 'in_review', 'scheduled')`;

router.get('/api/clinic/queue/pending-handovers', async (req, res, next) => {
  try {
    if (!isNurse(req)) return forbid(res, 'Only nurses have handovers');
    const { rows } = await pool.query(`${HANDOVER_SELECT} WHERE h.status = 'pending' AND (h.to_nurse = $1 OR h.from_nurse = $1) ORDER BY h.due_time`, [req.user.id]);
    const all = rows.map(toHandoverDto);
    const order = (a, b) => Number(b.overdue) - Number(a.overdue) || new Date(a.dueTime) - new Date(b.dueTime);
    return res.json({ incoming: all.filter((h) => h.toNurse.id === req.user.id).sort(order), outgoing: all.filter((h) => h.fromNurse.id === req.user.id).sort(order) });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/clinic/my-cases', async (req, res, next) => {
  try {
    if (!isNurse(req)) return forbid(res, 'Only nurses hold cases');
    const { rows } = await pool.query(
      `SELECT pc.*, t.name AS team_name, mp.name AS plan_name, mp.checkins_per_day, mp.review_within_hours
         FROM patient_care pc LEFT JOIN care_teams t ON t.id = pc.care_team_id LEFT JOIN monitoring_plans mp ON mp.id = pc.monitoring_plan_id
        WHERE pc.case_nurse_id = $1 ORDER BY pc.patient_name`, [req.user.id],
    );
    const ids = rows.map((r) => r.patient_id);
    const [{ rows: items }, { rows: handovers }] = await Promise.all([
      pool.query('SELECT * FROM risk_queue WHERE patient_id = ANY($1) AND status = ANY($2)', [ids, ACTIVE]),
      pool.query(`${HANDOVER_SELECT} WHERE h.patient_id = ANY($1) AND h.status = 'pending'`, [ids]),
    ]);
    const cases = rows.map((r) => {
      const item = items.find((i) => i.patient_id === r.patient_id);
      const h = handovers.find((x) => x.patient_id === r.patient_id);
      return {
        patient: { id: r.patient_id, name: r.patient_name },
        careTeam: { id: r.care_team_id, name: r.team_name },
        monitoringPlan: r.monitoring_plan_id ? { id: r.monitoring_plan_id, name: r.plan_name, checkinsPerDay: r.checkins_per_day, reviewWithinHours: r.review_within_hours } : null,
        caseSince: r.case_since,
        item: item ? queueDto(item) : null,
        pendingHandover: h ? toHandoverDto(h) : null,
      };
    });
    const rank = { P1: 0, P2: 1, P3: 2, P4: 3 };
    cases.sort((a, b) => (a.item ? rank[a.item.priority] : 9) - (b.item ? rank[b.item.priority] : 9) || a.patient.name.localeCompare(b.patient.name));
    return res.json({ cases });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/clinic/patients/:id/care', async (req, res, next) => {
  try {
    if (!isNurse(req)) return forbid(res, 'Only nurses can see the handover chain');
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const care = await loadCare(pool, req.params.id);
    if (!care) return res.status(404).json({ error: 'not_found', message: 'This elder has no care team yet' });
    const [{ rows: [team] }, { rows: [plan] }, { rows: duty }, { rows: chain }] = await Promise.all([
      pool.query('SELECT * FROM care_teams WHERE id = $1', [care.row.care_team_id]),
      pool.query('SELECT * FROM monitoring_plans WHERE id = $1', [care.row.monitoring_plan_id]),
      pool.query('SELECT nurse_id, on_duty, changed_at FROM nurse_duty WHERE nurse_id = ANY($1)', [care.teamNurseIds]),
      pool.query(`${HANDOVER_SELECT} WHERE h.patient_id = $1 ORDER BY h.created_at DESC`, [req.params.id]),
    ]);
    return res.json({
      patient: { id: care.row.patient_id, name: care.row.patient_name },
      careTeam: team ? { id: team.id, name: team.name, clinicId: team.clinic_id } : null,
      monitoringPlan: plan ? { id: plan.id, name: plan.name, checkinsPerDay: plan.checkins_per_day, reviewWithinHours: plan.review_within_hours } : null,
      caseNurse: care.caseNurseId ? { id: care.caseNurseId, name: care.row.case_nurse_name, since: care.row.case_since } : null,
      members: care.members.map((m) => {
        const d = duty.find((x) => x.nurse_id === m.nurse_id);
        return { id: m.nurse_id, name: m.nurse_name, teamRole: m.team_role, onDuty: Boolean(d && d.on_duty), dutySince: d ? d.changed_at : null };
      }),
      handovers: chain.map(toHandoverDto),
    });
  } catch (err) {
    return next(err);
  }
});

/** Who looks after an elder, for the elder's caregiver and family (names only, nothing clinical). */
router.get('/api/clinic/patients/:id/care-summary', async (req, res, next) => {
  try {
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const linked = req.user && ['caregiver', 'family_member'].includes(req.user.role) && req.user.patients.includes(req.params.id);
    if (!isNurse(req) && !linked) return forbid(res, 'You are not linked to this elder');
    const { rows: [r] } = await pool.query(
      'SELECT pc.case_nurse_id, pc.case_nurse_name, t.name AS team_name FROM patient_care pc LEFT JOIN care_teams t ON t.id = pc.care_team_id WHERE pc.patient_id = $1',
      [req.params.id],
    );
    return res.json({
      careTeam: r && r.team_name ? { name: r.team_name } : null,
      caseNurse: r && r.case_nurse_id ? { id: r.case_nurse_id, name: r.case_nurse_name } : null,
    });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------------- duty coverage ------------------------------ */
router.get('/api/clinic/duty', async (req, res, next) => {
  try {
    if (!isNurse(req) && !isAdmin(req)) return forbid(res);
    const { rows } = await pool.query(
      `SELECT m.nurse_id, max(m.nurse_name) AS nurse_name, array_agg(DISTINCT m.team_id) AS teams, coalesce(bool_or(d.on_duty), false) AS on_duty, max(d.changed_at) AS changed_at,
              (SELECT count(*)::int FROM patient_care pc WHERE pc.case_nurse_id = m.nurse_id) AS cases
         FROM care_team_members m LEFT JOIN nurse_duty d ON d.nurse_id = m.nurse_id
        WHERE m.removed_at IS NULL GROUP BY m.nurse_id ORDER BY 2`,
    );
    return res.json({ nurses: rows.map((r) => ({ id: r.nurse_id, name: r.nurse_name, teams: r.teams, onDuty: r.on_duty, since: r.changed_at, cases: r.cases })) });
  } catch (err) {
    return next(err);
  }
});

router.put('/api/clinic/duty/me', async (req, res, next) => {
  try {
    if (!isNurse(req)) return forbid(res, 'Only nurses go on duty');
    if (typeof (req.body || {}).onDuty !== 'boolean') return res.status(422).json({ error: 'validation_failed', details: ['onDuty must be true or false'] });
    const onDuty = req.body.onDuty;
    const result = await withTransaction(async (client) => {
      const { rows: [row] } = await client.query(
        `INSERT INTO nurse_duty (nurse_id, nurse_name, on_duty, changed_by) VALUES ($1,$2,$3,$1)
         ON CONFLICT (nurse_id) DO UPDATE SET on_duty = $3, nurse_name = $2, changed_by = $1, changed_at = now() RETURNING *`,
        [req.user.id, req.user.name || req.user.id, onDuty],
      );
      await careLog(client, req, 'duty_changed', { details: { nurseId: req.user.id, onDuty } });
      const { rows: [{ n }] } = await client.query('SELECT count(*)::int AS n FROM patient_care WHERE case_nurse_id = $1', [req.user.id]);
      return { row, n };
    });
    return res.json({
      onDuty, since: result.row.changed_at, cases: result.n,
      // Going off duty does not move cases (and neither does signing out): they move only by an accepted handover.
      warning: !onDuty && result.n ? `You still hold ${result.n} case${result.n === 1 ? '' : 's'}. Going off duty does not hand them over.` : null,
    });
  } catch (err) {
    return next(err);
  }
});

/* ------------------------- care teams (admin) ------------------------- */
router.get('/api/clinic/care-teams', async (req, res, next) => {
  try {
    if (!isNurse(req) && !isAdmin(req)) return forbid(res);
    const [{ rows: teams }, { rows: members }, { rows: patients }, { rows: plans }, { rows: pending }] = await Promise.all([
      pool.query('SELECT * FROM care_teams ORDER BY name'),
      pool.query(`SELECT * FROM care_team_members WHERE removed_at IS NULL ORDER BY (team_role = 'lead') DESC, nurse_name`),
      pool.query('SELECT patient_id, patient_name, care_team_id, monitoring_plan_id, case_nurse_id, case_nurse_name, case_since FROM patient_care ORDER BY patient_name'),
      pool.query('SELECT * FROM monitoring_plans ORDER BY checkins_per_day, id'),
      pool.query(`SELECT patient_id, to_nurse_name FROM handover_record WHERE status = 'pending'`),
    ]);
    return res.json({
      teams: teams.map((t) => ({
        id: t.id, name: t.name, clinicId: t.clinic_id,
        members: members.filter((m) => m.team_id === t.id).map((m) => ({ id: m.nurse_id, name: m.nurse_name, teamRole: m.team_role, since: m.added_at })),
      })),
      // Who is linked to what (names only - no clinical content, so the admin can manage it).
      patients: patients.map((p) => {
        const h = pending.find((x) => x.patient_id === p.patient_id);
        return {
          id: p.patient_id, name: p.patient_name, careTeamId: p.care_team_id, monitoringPlanId: p.monitoring_plan_id,
          caseNurse: p.case_nurse_id ? { id: p.case_nurse_id, name: p.case_nurse_name, since: p.case_since } : null,
          handoverPendingTo: h ? h.to_nurse_name : null,
        };
      }),
      monitoringPlans: plans.map((m) => ({ id: m.id, name: m.name, checkinsPerDay: m.checkins_per_day, reviewWithinHours: m.review_within_hours, description: m.description })),
    });
  } catch (err) {
    return next(err);
  }
});

router.post('/api/clinic/care-teams', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return forbid(res, 'Only the health center administrator manages care teams');
    const { id, name, clinicId } = req.body || {};
    const errors = [];
    if (typeof id !== 'string' || !/^CT-[A-Z0-9-]{1,30}$/.test(id)) errors.push('id must look like CT-MNL-A (capital letters, digits, -)');
    if (typeof name !== 'string' || name.trim().length < 3 || name.length > 100) errors.push('name is required (3-100 characters)');
    if (clinicId !== undefined && clinicId !== null && (typeof clinicId !== 'string' || !ID_RE.test(clinicId))) errors.push('clinicId must be an id like RHU-MNL-01');
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
    const team = await withTransaction(async (client) => {
      const { rows: [row] } = await client.query('INSERT INTO care_teams (id, name, clinic_id, created_by) VALUES ($1,$2,$3,$4) ON CONFLICT (id) DO NOTHING RETURNING *',
        [id, name.trim(), clinicId || null, req.user.id]);
      if (row) await careLog(client, req, 'team_created', { teamId: id, details: { name: row.name } });
      return row;
    });
    if (!team) return res.status(409).json({ error: 'conflict', message: `Care team ${id} already exists` });
    return res.status(201).json({ team: { id: team.id, name: team.name, clinicId: team.clinic_id, members: [] } });
  } catch (err) {
    return next(err);
  }
});

router.post('/api/clinic/care-teams/:id/members', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return forbid(res, 'Only the health center administrator manages care teams');
    const { nurseId, nurseName, teamRole = 'nurse' } = req.body || {};
    const errors = [];
    if (typeof nurseId !== 'string' || !/^U-CS-[0-9A-Za-z-]{1,40}$/.test(nurseId)) errors.push('nurseId must be a nurse account id (U-CS-...)');
    if (typeof nurseName !== 'string' || nurseName.trim().length < 2 || nurseName.length > 100) errors.push('nurseName is required');
    if (!['nurse', 'lead'].includes(teamRole)) errors.push('teamRole must be nurse or lead');
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
    const result = await withTransaction(async (client) => {
      const { rows: [team] } = await client.query('SELECT id FROM care_teams WHERE id = $1', [req.params.id]);
      if (!team) return { status: 404, body: { error: 'not_found', message: 'Care team not found' } };
      const { rows: [row] } = await client.query(
        `INSERT INTO care_team_members (team_id, nurse_id, nurse_name, team_role, added_by) VALUES ($1,$2,$3,$4,$5)
         ON CONFLICT (team_id, nurse_id) WHERE removed_at IS NULL DO NOTHING RETURNING *`,
        [team.id, nurseId, nurseName.trim(), teamRole, req.user.id],
      );
      if (!row) return { status: 409, body: { error: 'conflict', message: `${nurseName} is already on this team` } };
      await careLog(client, req, 'member_added', { teamId: team.id, details: { nurseId, nurseName: row.nurse_name, teamRole } });
      return { status: 201, body: { member: { id: row.nurse_id, name: row.nurse_name, teamRole: row.team_role, since: row.added_at } } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    return next(err);
  }
});

router.delete('/api/clinic/care-teams/:id/members/:nurseId', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return forbid(res, 'Only the health center administrator manages care teams');
    const result = await withTransaction(async (client) => {
      const { rows: [m] } = await client.query('SELECT * FROM care_team_members WHERE team_id = $1 AND nurse_id = $2 AND removed_at IS NULL FOR UPDATE', [req.params.id, req.params.nurseId]);
      if (!m) return { status: 404, body: { error: 'not_found', message: 'This nurse is not on the team' } };
      // A nurse still holding (or about to receive) a case on this team must hand it over first: no case is left without a nurse.
      const { rows: held } = await client.query(
        `SELECT pc.patient_name FROM patient_care pc WHERE pc.care_team_id = $1 AND pc.case_nurse_id = $2
         UNION SELECT pc.patient_name FROM handover_record h JOIN patient_care pc ON pc.patient_id = h.patient_id
          WHERE pc.care_team_id = $1 AND h.status = 'pending' AND (h.to_nurse = $2 OR h.from_nurse = $2)`,
        [req.params.id, req.params.nurseId],
      );
      if (held.length) {
        return { status: 409, body: { error: 'handover_required', message: `${m.nurse_name} still holds or is receiving cases on this team (${held.map((h) => h.patient_name).join(', ')}). They must be handed over first.` } };
      }
      await client.query('UPDATE care_team_members SET removed_at = now(), removed_by = $2 WHERE id = $1', [m.id, req.user.id]);
      await careLog(client, req, 'member_removed', { teamId: req.params.id, details: { nurseId: m.nurse_id, nurseName: m.nurse_name } });
      return { status: 200, body: { removed: { id: m.nurse_id, name: m.nurse_name } } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    return next(err);
  }
});

/**
 * Admin links an elder to a care team and monitoring plan and records the first case nurse. Once a nurse
 * holds the case it moves only by a handover the incoming nurse accepts - the admin cannot reassign it.
 */
router.put('/api/clinic/patients/:id/care', async (req, res, next) => {
  try {
    // The admin, or a team-lead nurse for the teams they lead (both the elder's current team and the new one).
    const led = isNurse(req) ? await leadTeams(req.user.id) : [];
    if (!isAdmin(req) && !led.length) return forbid(res, 'Only the admin or a team-lead nurse links elders to care teams');
    if (!ID_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
    const { patientName, careTeamId, monitoringPlanId, caseNurseId } = req.body || {};
    if (!isAdmin(req)) {
      if (!led.includes(careTeamId)) return forbid(res, 'You can link elders only to a team you lead');
      const { rows: [now] } = await pool.query('SELECT care_team_id FROM patient_care WHERE patient_id = $1', [req.params.id]);
      if (now && now.care_team_id && !led.includes(now.care_team_id)) return forbid(res, 'This elder is on a team you do not lead');
    }
    const errors = [];
    if (patientName !== undefined && (typeof patientName !== 'string' || patientName.trim().length < 2 || patientName.length > 120)) errors.push('patientName must be 2-120 characters');
    if (typeof careTeamId !== 'string' || !ID_RE.test(careTeamId)) errors.push('careTeamId is required');
    if (monitoringPlanId !== undefined && monitoringPlanId !== null && (typeof monitoringPlanId !== 'string' || !ID_RE.test(monitoringPlanId))) errors.push('monitoringPlanId must be a plan id');
    if (caseNurseId !== undefined && caseNurseId !== null && (typeof caseNurseId !== 'string' || !ID_RE.test(caseNurseId))) errors.push('caseNurseId must be a nurse id');
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    const result = await withTransaction(async (client) => {
      const { rows: [team] } = await client.query('SELECT id FROM care_teams WHERE id = $1', [careTeamId]);
      if (!team) return { status: 422, body: { error: 'validation_failed', details: [`Care team ${careTeamId} does not exist`] } };
      if (monitoringPlanId) {
        const { rows: [plan] } = await client.query('SELECT id FROM monitoring_plans WHERE id = $1', [monitoringPlanId]);
        if (!plan) return { status: 422, body: { error: 'validation_failed', details: [`Monitoring plan ${monitoringPlanId} does not exist`] } };
      }
      const { rows: members } = await client.query('SELECT nurse_id, nurse_name FROM care_team_members WHERE team_id = $1 AND removed_at IS NULL', [careTeamId]);
      const { rows: [current] } = await client.query('SELECT * FROM patient_care WHERE patient_id = $1 FOR UPDATE', [req.params.id]);
      if (!current && !patientName) return { status: 422, body: { error: 'validation_failed', details: ['patientName is required for an elder not yet on a care team'] } };
      const holder = current && current.case_nurse_id;
      const holderStays = holder && members.some((m) => m.nurse_id === holder);
      let nurse = null;
      if (caseNurseId) {
        nurse = members.find((m) => m.nurse_id === caseNurseId);
        if (!nurse) return { status: 422, body: { error: 'validation_failed', details: ['The case nurse must be on the chosen care team'] } };
        if (holder && holder !== caseNurseId) {
          return { status: 409, body: { error: 'handover_required', message: `${current.case_nurse_name} holds this case. It moves only when they hand it over and the new nurse accepts.` } };
        }
      } else if (holder && !holderStays) {
        return { status: 409, body: { error: 'handover_required', message: `${current.case_nurse_name} holds this case and is not on ${careTeamId}. Hand the case over to a nurse on that team first.` } };
      }
      const { rows: [pending] } = await client.query(`SELECT 1 FROM handover_record WHERE patient_id = $1 AND status = 'pending'`, [req.params.id]);
      if (pending && current && current.care_team_id !== careTeamId) return { status: 409, body: { error: 'handover_pending', message: 'Finish the pending handover before moving this elder to another team' } };

      const caseNurse = holder ? { id: holder, name: current.case_nurse_name, since: current.case_since } : nurse ? { id: nurse.nurse_id, name: nurse.nurse_name, since: new Date() } : { id: null, name: null, since: null };
      const { rows: [row] } = await client.query(
        `INSERT INTO patient_care (patient_id, patient_name, care_team_id, monitoring_plan_id, case_nurse_id, case_nurse_name, case_since, updated_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8)
         ON CONFLICT (patient_id) DO UPDATE SET patient_name = coalesce($2, patient_care.patient_name), care_team_id = $3,
                monitoring_plan_id = coalesce($4, patient_care.monitoring_plan_id), case_nurse_id = $5, case_nurse_name = $6, case_since = $7,
                updated_by = $8, updated_at = now()
         RETURNING *`,
        [req.params.id, patientName ? patientName.trim() : null, careTeamId, monitoringPlanId || null, caseNurse.id, caseNurse.name, caseNurse.since, req.user.id],
      );
      if (!holder && nurse) {
        await client.query('UPDATE risk_queue SET assigned_to = $2, updated_at = now() WHERE patient_id = $1 AND status = ANY($3)', [row.patient_id, nurse.nurse_id, ACTIVE]);
      }
      await careLog(client, req, 'patient_assigned', {
        patientId: row.patient_id, teamId: careTeamId,
        details: { monitoringPlanId: row.monitoring_plan_id, caseNurseId: row.case_nurse_id, previousTeamId: current ? current.care_team_id : null, firstCaseNurse: Boolean(!holder && nurse) },
      });
      return { status: current ? 200 : 201, body: { patient: { id: row.patient_id, name: row.patient_name, careTeamId: row.care_team_id, monitoringPlanId: row.monitoring_plan_id, caseNurse: row.case_nurse_id ? { id: row.case_nurse_id, name: row.case_nurse_name, since: row.case_since } : null } } };
    });
    return res.status(result.status).json(result.body);
  } catch (err) {
    return next(err);
  }
});

router.get('/api/clinic/care-log', async (req, res, next) => {
  try {
    const led = isNurse(req) ? await leadTeams(req.user.id) : [];
    if (!isAdmin(req) && !led.length) return forbid(res, 'Only the admin or a team-lead nurse reads the assignment log');
    const limit = Math.min(Number(req.query.limit) || 100, 500);
    // A team lead sees the log of the teams they lead.
    const { rows } = isAdmin(req)
      ? await pool.query('SELECT * FROM care_assignment_log ORDER BY created_at DESC, id DESC LIMIT $1', [limit])
      : await pool.query('SELECT * FROM care_assignment_log WHERE team_id = ANY($2) ORDER BY created_at DESC, id DESC LIMIT $1', [limit, led]);
    return res.json({ entries: rows.map((r) => ({ id: r.id, action: r.action, actorId: r.actor_id, actorRole: r.actor_role, patientId: r.patient_id, teamId: r.team_id, details: r.details, at: r.created_at })) });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

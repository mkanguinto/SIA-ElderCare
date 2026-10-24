'use strict';

/**
 * Care plan versions (v3). RBAC is enforced at the gateway and again here; changing a plan also needs the nurse
 * to be on the elder's care team (or to hold the case), checked with the clinic service.
 *
 *   GET    /api/patients/:id/care-plan/versions          clinic             versions + change history
 *   POST   /api/patients/:id/care-plan/drafts            care-team nurse    start a draft (copy of the active plan)
 *   GET    /api/care-plan/versions/:vid                  clinic; caregiver (own elder, not drafts)
 *   PATCH  /api/care-plan/versions/:vid                  care-team nurse    edit a draft
 *   POST   /api/care-plan/versions/:vid/verification     care-team nurse    record the clinician's verification
 *   POST   /api/care-plan/versions/:vid/activate         care-team nurse    draft -> active, previous -> superseded
 *   POST   /api/care-plan/versions/:vid/discard          care-team nurse    drop a draft (kept in the history)
 */
const express = require('express');
const { pool, withTransaction } = require('./db');
const logger = require('./lib/logger');
const plan = require('./planContent');
const schedule = require('./schedule');
const { careOf, medicationsOf } = require('./peers');

const router = express.Router();
const TZ = () => process.env.CARE_TZ_OFFSET || process.env.VISIT_TZ_OFFSET || '+08:00';
const PATIENT_RE = /^[A-Za-z0-9_-]{1,64}$/;
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function toVersionDto(r) {
  if (!r) return null;
  return {
    id: r.id, patientId: r.patient_id, version: r.version, status: r.status, content: r.content || {},
    careTeamId: r.care_team_id, responsibleNurseId: r.responsible_nurse_id, responsibleNurseName: r.responsible_nurse_name,
    elderInvolved: r.elder_involved, caregiverInvolved: r.caregiver_involved, involvementNote: r.involvement_note,
    effectiveDate: r.effective_date, reviewDate: r.review_date, verification: r.verification, legacy: r.legacy,
    changeSummary: r.change_summary, createdBy: r.created_by, createdAt: r.created_at, updatedBy: r.updated_by, updatedAt: r.updated_at,
    activatedBy: r.activated_by, activatedAt: r.activated_at, supersededAt: r.superseded_at, supersededBy: r.superseded_by,
  };
}

async function event(db, req, patientId, versionId, action, details = {}) {
  await db.query('INSERT INTO care_plan_events (patient_id, version_id, action, actor_id, actor_role, details) VALUES ($1,$2,$3,$4,$5,$6)',
    [patientId, versionId, action, req.user.id, req.user.role, JSON.stringify(details)]);
}

const fail = (status, error, message, extra = {}) => Object.assign(new Error(message), { status, body: { error, message, ...extra } });

/**
 * The caller may change this elder's care plan: a nurse on the elder's care team, or the nurse holding the case.
 * @returns {Promise<object>} the clinic's care record (team, members, case nurse)
 */
async function authoriseNurse(req, patientId) {
  if (!req.user || req.user.role !== 'clinic_staff') throw fail(403, 'forbidden', 'Only nurses can change a care plan');
  const care = await careOf(req, patientId);
  if (!care) throw fail(409, 'no_care_team', 'This elder is not linked to a care team yet. An administrator links elders to care teams.');
  const onTeam = care.members.some((m) => m.id === req.user.id) || (care.caseNurse && care.caseNurse.id === req.user.id);
  if (!onTeam) throw fail(403, 'not_on_care_team', "Only nurses on this elder's care team can change the care plan");
  return care;
}

async function loadVersion(db, vid, lock = false) {
  if (!UUID_RE.test(vid)) throw fail(404, 'not_found', 'Care plan version not found');
  const { rows: [r] } = await db.query(`SELECT * FROM care_plan_versions WHERE id = $1 ${lock ? 'FOR UPDATE' : ''}`, [vid]);
  if (!r) throw fail(404, 'not_found', 'Care plan version not found');
  return r;
}

async function versionTasks(db, vid) {
  const { rows } = await db.query('SELECT * FROM care_tasks WHERE plan_version_id = $1 ORDER BY category, title', [vid]);
  return rows;
}

/** Starts a draft: a copy of the active version (content and tasks), or an empty plan for a new elder. */
async function createDraft(client, req, patientId, care, changeSummary) {
  const { rows: [existing] } = await client.query("SELECT * FROM care_plan_versions WHERE patient_id = $1 AND status = 'draft'", [patientId]);
  if (existing) return { draft: existing, created: false };
  await client.query('INSERT INTO care_plans (patient_id, created_by, updated_by) VALUES ($1, $2, $2) ON CONFLICT (patient_id) DO NOTHING', [patientId, req.user.id]);
  await client.query('SELECT patient_id FROM care_plans WHERE patient_id = $1 FOR UPDATE', [patientId]);
  const { rows: [active] } = await client.query("SELECT * FROM care_plan_versions WHERE patient_id = $1 AND status = 'active'", [patientId]);
  const { rows: [{ next }] } = await client.query('SELECT coalesce(max(version), 0) + 1 AS next FROM care_plan_versions WHERE patient_id = $1', [patientId]);
  const holder = care && care.caseNurse ? care.caseNurse : null;
  const { rows: [draft] } = await client.query(
    `INSERT INTO care_plan_versions (patient_id, version, status, content, care_team_id, responsible_nurse_id, responsible_nurse_name,
                                     elder_involved, caregiver_involved, involvement_note, review_date, change_summary, created_by, updated_by)
     VALUES ($1,$2,'draft',$3,$4,$5,$6,NULL,NULL,NULL,NULL,$7,$8,$8) RETURNING *`,
    [patientId, next, JSON.stringify(active ? active.content : {}), care && care.careTeam ? care.careTeam.id : null,
      active ? active.responsible_nurse_id : holder && holder.id, active ? active.responsible_nurse_name : holder && holder.name,
      changeSummary || null, req.user.id],
  );
  if (active) {
    // The draft starts with the active version's tasks; copied_from links each copy to the task it replaces.
    await client.query(
      `INSERT INTO care_tasks (patient_id, category, title, instructions, frequency, times, days_of_week, due_date, start_date, end_date, active,
                               kind, measurement, specialised, source, plan_version_id, copied_from, created_by, updated_by)
       SELECT patient_id, category, title, instructions, frequency, times, days_of_week, due_date, start_date, end_date, active,
              kind, measurement, specialised, source, $2, id, $3, $3
         FROM care_tasks WHERE plan_version_id = $1 AND active`,
      [active.id, draft.id, req.user.id],
    );
  }
  await event(client, req, patientId, draft.id, 'draft_created', { version: draft.version, from: active ? active.version : null, changeSummary: changeSummary || null });
  return { draft, created: true };
}

/** The open draft of an elder's plan, created from the active version when there is none. */
async function draftFor(req, patientId) {
  const care = await authoriseNurse(req, patientId);
  return withTransaction((client) => createDraft(client, req, patientId, care));
}

function handle(fn) {
  return async (req, res, next) => {
    try { return await fn(req, res); } catch (err) {
      if (err.body) return res.status(err.status).json(err.body);
      if (err.status === 503) return res.status(503).json({ error: 'dependency_unavailable', message: err.message });
      if (err.code === 'check_violation' || err.code === '23514') return res.status(409).json({ error: 'conflict', message: err.message });
      if (err.code === '23505') return res.status(409).json({ error: 'conflict', message: 'Another draft or active version was saved at the same time. Reload and try again.' });
      return next(err);
    }
  };
}

/* ------------------------------- versions + history ------------------------------- */
router.get('/api/patients/:id/care-plan/versions', handle(async (req, res) => {
  if (!req.user || req.user.role !== 'clinic_staff') return res.status(403).json({ error: 'forbidden', message: 'Only nurses can see the plan history' });
  if (!PATIENT_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const [{ rows: versions }, { rows: events }] = await Promise.all([
    pool.query('SELECT * FROM care_plan_versions WHERE patient_id = $1 ORDER BY version DESC', [req.params.id]),
    pool.query('SELECT * FROM care_plan_events WHERE patient_id = $1 ORDER BY at DESC, id DESC LIMIT 200', [req.params.id]),
  ]);
  return res.json({
    patientId: req.params.id,
    versions: versions.map((v) => {
      const d = toVersionDto(v);
      return { id: d.id, version: d.version, status: d.status, effectiveDate: d.effectiveDate, reviewDate: d.reviewDate, legacy: d.legacy,
        changeSummary: d.changeSummary, createdBy: d.createdBy, createdAt: d.createdAt, activatedBy: d.activatedBy, activatedAt: d.activatedAt,
        supersededAt: d.supersededAt, verified: Boolean(d.verification), responsibleNurseName: d.responsibleNurseName };
    }),
    history: events.map((e) => ({ id: e.id, versionId: e.version_id, action: e.action, actorId: e.actor_id, actorRole: e.actor_role, details: e.details, at: e.at })),
  });
}));

router.post('/api/patients/:id/care-plan/drafts', handle(async (req, res) => {
  if (!PATIENT_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
  const changeSummary = typeof (req.body || {}).changeSummary === 'string' ? req.body.changeSummary.trim().slice(0, 500) : null;
  const care = await authoriseNurse(req, req.params.id);
  const { draft, created } = await withTransaction((client) => createDraft(client, req, req.params.id, care, changeSummary));
  const tasks = await versionTasks(pool, draft.id);
  logger.info('care plan draft', { patientId: req.params.id, version: draft.version, created, by: req.user.id });
  return res.status(created ? 201 : 200).json({ ...toVersionDto(draft), tasks: tasks.length, created });
}));

router.get('/api/care-plan/versions/:vid', handle(async (req, res) => {
  const v = await loadVersion(pool, req.params.vid);
  const role = req.user && req.user.role;
  const ownElder = req.user && req.user.patients.includes(v.patient_id);
  if (!(role === 'clinic_staff' || (role === 'caregiver' && ownElder && v.status !== 'draft' && v.status !== 'discarded'))) {
    return res.status(403).json({ error: 'forbidden', message: 'You cannot see this care plan version' });
  }
  const tasks = await versionTasks(pool, v.id);
  const dto = toVersionDto(v);
  const today = schedule.localNow(TZ()).date;
  return res.json({
    ...dto,
    tasks: tasks.map((t) => ({ id: t.id, category: t.category, title: t.title, instructions: t.instructions, frequency: t.frequency, times: t.times,
      daysOfWeek: t.days_of_week.map(Number), dueDate: t.due_date, startDate: t.start_date, endDate: t.end_date, active: t.active, kind: t.kind,
      measurement: t.measurement, specialised: t.specialised, source: t.source, copiedFrom: t.copied_from })),
    needsApproval: plan.approvalItems(dto.content),
    ...(dto.status === 'draft' ? { problems: plan.activationProblems(dto, tasks.map((t) => ({ title: t.title, active: t.active, specialised: t.specialised, source: t.source })), today) } : {}),
  });
}));

/* ------------------------------- edit a draft ------------------------------- */
router.patch('/api/care-plan/versions/:vid', handle(async (req, res) => {
  const v0 = await loadVersion(pool, req.params.vid);
  if (v0.status !== 'draft') return res.status(409).json({ error: 'not_draft', message: `Version ${v0.version} is ${v0.status}. Start a draft to change the plan.` });
  const care = await authoriseNurse(req, v0.patient_id);
  const b = req.body || {};
  const errors = [];
  const allowed = ['content', 'responsibleNurseId', 'elderInvolved', 'caregiverInvolved', 'involvementNote', 'effectiveDate', 'reviewDate', 'changeSummary'];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) errors.push(`unknown field(s): ${unknown.join(', ')}`);
  const sets = {};
  let content = null;
  if (b.content !== undefined) {
    const r = plan.validateContent(b.content);
    errors.push(...r.errors);
    content = { ...(v0.content || {}), ...r.value };
    sets.content = JSON.stringify(content);
  }
  if (b.responsibleNurseId !== undefined) {
    const m = care.members.find((x) => x.id === b.responsibleNurseId);
    if (!m) errors.push("responsibleNurseId must be a nurse on the elder's care team");
    else { sets.responsible_nurse_id = m.id; sets.responsible_nurse_name = m.name; }
  }
  for (const [k, col] of [['elderInvolved', 'elder_involved'], ['caregiverInvolved', 'caregiver_involved']]) {
    if (b[k] !== undefined) { if (typeof b[k] !== 'boolean') errors.push(`${k} must be true or false`); else sets[col] = b[k]; }
  }
  for (const [k, col, max] of [['involvementNote', 'involvement_note', 500], ['changeSummary', 'change_summary', 500]]) {
    if (b[k] !== undefined) {
      if (b[k] !== null && (typeof b[k] !== 'string' || b[k].length > max)) errors.push(`${k} must be at most ${max} characters`);
      else sets[col] = b[k] ? b[k].trim() : null;
    }
  }
  for (const [k, col] of [['effectiveDate', 'effective_date'], ['reviewDate', 'review_date']]) {
    if (b[k] !== undefined) { if (b[k] !== null && !plan.isDate(b[k])) errors.push(`${k} must be YYYY-MM-DD`); else sets[col] = b[k]; }
  }
  if (!errors.length && !Object.keys(sets).length) errors.push('nothing to update');
  if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

  // A verification covers the wording that was verified: changing an instruction that needs approval clears it.
  let cleared = false;
  if (content && v0.verification && JSON.stringify(plan.approvalItems(content)) !== JSON.stringify(plan.approvalItems(v0.content || {}))) {
    sets.verification = null;
    cleared = true;
  }
  const keys = Object.keys(sets);
  const row = await withTransaction(async (client) => {
    const { rows: [r] } = await client.query(
      `UPDATE care_plan_versions SET ${keys.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${keys.length + 2}, updated_at = now()
        WHERE id = $1 AND status = 'draft' RETURNING *`,
      [v0.id, ...keys.map((k) => sets[k]), req.user.id],
    );
    if (!r) throw fail(409, 'not_draft', 'This draft was activated or discarded meanwhile');
    await event(client, req, r.patient_id, r.id, 'draft_updated', { fields: Object.keys(b), ...(cleared ? { verificationCleared: true } : {}) });
    return r;
  });
  return res.json({ ...toVersionDto(row), verificationCleared: cleared });
}));

router.post('/api/care-plan/versions/:vid/verification', handle(async (req, res) => {
  const v0 = await loadVersion(pool, req.params.vid);
  if (v0.status !== 'draft') return res.status(409).json({ error: 'not_draft', message: 'Only a draft can be verified; an active version stays as it was verified' });
  await authoriseNurse(req, v0.patient_id);
  const today = schedule.localNow(TZ()).date;
  const { errors, value } = plan.validateVerification(req.body, today);
  const items = plan.approvalItems(v0.content || {});
  if (!items.length) errors.push('nothing in this draft needs partner-clinic approval');
  if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
  const verification = { ...value, items, recordedBy: req.user.id, recordedByName: req.user.name || null, recordedAt: new Date().toISOString() };
  const row = await withTransaction(async (client) => {
    const { rows: [r] } = await client.query(
      "UPDATE care_plan_versions SET verification = $2, updated_by = $3, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *",
      [v0.id, JSON.stringify(verification), req.user.id],
    );
    if (!r) throw fail(409, 'not_draft', 'This draft was activated or discarded meanwhile');
    await event(client, req, r.patient_id, r.id, 'verified', { clinicianName: value.clinicianName, clinicianRole: value.clinicianRole, method: value.method, items: items.length });
    return r;
  });
  return res.json(toVersionDto(row));
}));

/* ------------------------------- activate / discard ------------------------------- */
router.post('/api/care-plan/versions/:vid/activate', handle(async (req, res) => {
  const v0 = await loadVersion(pool, req.params.vid);
  await authoriseNurse(req, v0.patient_id);
  const today = schedule.localNow(TZ()).date;
  // The medicines in effect when the plan starts are kept with the version (what the plan referred to).
  let meds = null;
  try {
    meds = (await medicationsOf(req, v0.patient_id)).filter((m) => m.active).map((m) => ({ id: m.id, name: m.name, dosage: m.dosage, strength: m.strength || null, dose: m.dose || null, times: m.times }));
  } catch { meds = null; }
  const row = await withTransaction(async (client) => {
    const v = await loadVersion(client, req.params.vid, true);
    const tasks = await versionTasks(client, v.id);
    const problems = plan.activationProblems(toVersionDto(v), tasks.map((t) => ({ title: t.title, active: t.active, specialised: t.specialised, source: t.source })), today);
    if (problems.length) throw fail(422, 'not_ready', 'The draft is not ready to activate', { details: problems });
    const { rows: [active] } = await client.query("SELECT * FROM care_plan_versions WHERE patient_id = $1 AND status = 'active' FOR UPDATE", [v.patient_id]);
    if (active && active.effective_date && v.effective_date < active.effective_date) {
      throw fail(422, 'not_ready', 'The draft cannot start before the active version', { details: [`the effective date must be on or after ${active.effective_date}`] });
    }
    if (active) {
      await client.query("UPDATE care_plan_versions SET status = 'superseded', superseded_at = now(), superseded_by = $2 WHERE id = $1", [active.id, v.id]);
      await event(client, req, v.patient_id, active.id, 'superseded', { by: v.version });
    }
    const content = { ...(v.content || {}), ...(meds ? { medicationsAtActivation: meds } : {}) };
    const { rows: [r] } = await client.query(
      "UPDATE care_plan_versions SET status = 'active', content = $2, activated_by = $3, activated_at = now(), updated_by = $3, updated_at = now() WHERE id = $1 RETURNING *",
      [v.id, JSON.stringify(content), req.user.id],
    );
    await client.query('UPDATE care_plans SET goals = $2, notes = $3, updated_by = $4, updated_at = now() WHERE patient_id = $1',
      [v.patient_id, content.goals || null, content.notes || null, req.user.id]);
    await event(client, req, v.patient_id, v.id, 'activated', { version: v.version, effectiveDate: v.effective_date, reviewDate: v.review_date, replaces: active ? active.version : null });
    return r;
  });
  logger.info('care plan activated', { patientId: row.patient_id, version: row.version, by: req.user.id });
  return res.json(toVersionDto(row));
}));

router.post('/api/care-plan/versions/:vid/discard', handle(async (req, res) => {
  const v0 = await loadVersion(pool, req.params.vid);
  if (v0.status !== 'draft') return res.status(409).json({ error: 'not_draft', message: 'Only a draft can be discarded' });
  await authoriseNurse(req, v0.patient_id);
  const reason = typeof (req.body || {}).reason === 'string' ? req.body.reason.trim() : '';
  if (reason.length < 3) return res.status(422).json({ error: 'validation_failed', details: ['reason is required (at least 3 characters)'] });
  const row = await withTransaction(async (client) => {
    const { rows: [r] } = await client.query("UPDATE care_plan_versions SET status = 'discarded', updated_by = $2, updated_at = now() WHERE id = $1 AND status = 'draft' RETURNING *", [v0.id, req.user.id]);
    if (!r) throw fail(409, 'not_draft', 'This draft was activated or discarded meanwhile');
    await event(client, req, r.patient_id, r.id, 'discarded', { reason });
    return r;
  });
  return res.json(toVersionDto(row));
}));

module.exports = { router, toVersionDto, authoriseNurse, draftFor, event, handle, fail };

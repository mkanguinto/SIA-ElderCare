'use strict';

/**
 * Family and caregivers contacting the clinic, with proof (who, when, why, what the clinic did).
 *
 *   GET  /api/clinic/contact-info                        the clinic's phone number and hours (any signed-in user)
 *   POST /api/patients/:id/clinic-contact                {channel: message|call, reason, message?, callback?}   family / caregiver of the elder
 *   GET  /api/patients/:id/clinic-contact                that elder's contacts with every step (family / caregiver of the elder, nurses)
 *   GET  /api/clinic/contact-requests?status=open|all    the clinic's inbox (nurses)
 *   POST /api/clinic/contact-requests/:id/seen           a nurse opened it
 *   POST /api/clinic/contact-requests/:id/reply          {reply}  the nurse's answer, shown to the family
 *   POST /api/clinic/contact-requests/:id/close          {note}   e.g. "Called back, all fine"
 *
 * A call started from the app is recorded as "call started": the app cannot know whether it connected. Every
 * contact also texts a short notice (no health details) to the clinic hotline (CLINIC_HOTLINE) through the alert
 * service, so the clinic phone has a record too; its delivery is reported honestly (simulated = NOT sent).
 * Steps are written to contact_request_events, which is append-only.
 */
const express = require('express');
const { pool, withTransaction } = require('./db');
const logger = require('./lib/logger');
const { request } = require('./lib/resilientHttp');
const { requireInternalToken, internalHeaders } = require('./lib/internalAuth');
const C = require('./contact');

const router = express.Router();
const ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
const CR_RE = /^CR-\d{6,}$/;
const FAMILY_SIDE = ['family_member', 'caregiver'];
const PER_HOUR = Number(process.env.CONTACT_REQUESTS_PER_HOUR || 6);
const ALERT_URL = () => process.env.ALERT_SERVICE_URL || 'http://localhost:4002';
const isNurse = (req) => req.user && req.user.role === 'clinic_staff';
const forbid = (res, message) => res.status(403).json({ error: 'forbidden', message });

/** 09171234567 -> "0917 123 4567" for display; null when the hotline is not configured. */
function hotline() {
  const raw = String(process.env.CLINIC_HOTLINE || '').replace(/[\s().-]/g, '');
  let local = null;
  if (/^09\d{9}$/.test(raw)) local = raw;
  else if (/^\+639\d{9}$/.test(raw)) local = `0${raw.slice(3)}`;
  else if (/^639\d{9}$/.test(raw)) local = `0${raw.slice(2)}`;
  if (!local) return null;
  return { display: `${local.slice(0, 4)} ${local.slice(4, 7)} ${local.slice(7)}`, tel: `+63${local.slice(1)}` };
}

function toDto(r, events) {
  return {
    id: r.id,
    patient: { id: r.patient_id, name: r.patient_name || r.patient_id },
    from: { id: r.from_user_id, name: r.from_name, role: r.from_role },
    channel: r.channel,
    reason: r.reason,
    reasonLabel: C.REASONS[r.reason] || r.reason,
    message: r.message,
    callback: r.callback,
    status: r.status,
    createdAt: r.created_at,
    clinicNotice: r.clinic_sms ? { delivery: r.clinic_sms, note: r.clinic_sms_note } : null,
    seen: r.seen_at ? { at: r.seen_at, by: { id: r.seen_by, name: r.seen_by_name } } : null,
    reply: r.replied_at ? { text: r.reply, at: r.replied_at, by: { id: r.replied_by, name: r.replied_by_name } } : null,
    caseNurse: r.case_nurse_name ? { id: r.case_nurse_id, name: r.case_nurse_name } : null,
    ...(events ? { events: events.map((e) => ({ at: e.at, event: e.event, actor: { id: e.actor_id, name: e.actor_name, role: e.actor_role }, details: e.details })) } : {}),
  };
}

/** Appends one step; `req` null = a system step (the SMS notice). */
function event(db, requestId, req, name, details = {}) {
  const u = req && req.user;
  return db.query(
    'INSERT INTO contact_request_events (request_id, actor_id, actor_name, actor_role, event, details) VALUES ($1,$2,$3,$4,$5,$6)',
    [requestId, u ? u.id : 'system', u ? u.name : 'SMS provider', u ? u.role : 'system', name, JSON.stringify(details)],
  );
}

async function eventsFor(ids) {
  if (!ids.length) return {};
  const { rows } = await pool.query('SELECT * FROM contact_request_events WHERE request_id = ANY($1) ORDER BY at, id', [ids]);
  return rows.reduce((acc, e) => ({ ...acc, [e.request_id]: [...(acc[e.request_id] || []), e] }), {});
}

const SELECT = `SELECT r.*, pc.case_nurse_id, pc.case_nurse_name FROM contact_requests r LEFT JOIN patient_care pc ON pc.patient_id = r.patient_id`;

/** Texts the clinic hotline; returns what really happened (simulated / queued / failed / not_configured). */
async function notifyClinic(text, requestId) {
  const h = hotline();
  if (!h) return { delivery: 'not_configured', note: 'CLINIC_HOTLINE is not set: no SMS to the clinic' };
  try {
    const r = await request('alert-service', {
      method: 'POST', url: `${ALERT_URL()}/internal/messages/sms`, headers: internalHeaders(requestId),
      data: { to: h.tel, body: text, purpose: 'clinic_contact' }, validateStatus: () => true,
    }, { retries: 0, timeoutMs: 8000 });
    if (r.status === 200) return { delivery: r.data.status, note: r.data.note || null, ref: r.data.ref || null };
    return { delivery: 'failed', note: (r.data && r.data.message) || `SMS service answered ${r.status}` };
  } catch (err) {
    return { delivery: 'failed', note: 'The SMS service could not be reached' };
  }
}

/** Brings a queued / sent hotline notice up to date from the SMS provider (delivered, failed, ...). */
async function followNotice(row, requestId) {
  if (!row.clinic_sms_ref || !['queued', 'sent', 'unknown'].includes(row.clinic_sms) || Date.now() - new Date(row.created_at).getTime() > 48 * 3600000) return row;
  try {
    const r = await request('alert-service', {
      method: 'GET', url: `${ALERT_URL()}/internal/messages/sms/${encodeURIComponent(row.clinic_sms_ref)}`, headers: internalHeaders(requestId), validateStatus: () => true,
    }, { retries: 0, timeoutMs: 5000 });
    if (r.status !== 200 || r.data.status === row.clinic_sms) return row;
    await pool.query('UPDATE contact_requests SET clinic_sms = $2, clinic_sms_note = $3 WHERE id = $1', [row.id, r.data.status, r.data.note || null]);
    await event(pool, row.id, null, 'clinic_notified', { delivery: r.data.status, note: r.data.note || null });
    return { ...row, clinic_sms: r.data.status, clinic_sms_note: r.data.note || null };
  } catch {
    return row;
  }
}

router.get('/api/clinic/contact-info', requireInternalToken, (req, res) => {
  const h = hotline();
  res.json({
    name: process.env.CLINIC_HOTLINE_NAME || 'RHU Manila health center',
    phone: h ? h.display : null,
    tel: h ? h.tel : null,
    hours: process.env.CLINIC_HOURS || 'Mon-Fri 8 AM - 5 PM',
    reasons: Object.entries(C.REASONS).map(([key, label]) => ({ key, label })),
  });
});

router.post('/api/patients/:id/clinic-contact', requireInternalToken, async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!ID_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    if (!req.user || !FAMILY_SIDE.includes(req.user.role)) return forbid(res, 'Only family members and caregivers contact the clinic here');
    if (!req.user.patients.includes(patientId)) return forbid(res, 'You are not linked to this elder');
    const v = C.validateContact(req.body);
    if (!v.ok) return res.status(422).json({ error: 'validation_failed', details: v.errors });
    const { rows: [recent] } = await pool.query("SELECT count(*)::int AS n FROM contact_requests WHERE from_user_id = $1 AND created_at > now() - interval '1 hour'", [req.user.id]);
    if (recent.n >= PER_HOUR) return res.status(429).json({ error: 'too_many_requests', message: 'You already contacted the clinic several times this hour. For an emergency call 911.' });

    const { rows: [pc] } = await pool.query('SELECT patient_name FROM patient_care WHERE patient_id = $1', [patientId]);
    const patientName = pc ? pc.patient_name : patientId;
    const row = await withTransaction(async (client) => {
      const { rows: [r] } = await client.query(
        `WITH n AS (SELECT nextval(pg_get_serial_sequence('contact_requests', 'seq')) AS s)
         INSERT INTO contact_requests (id, seq, patient_id, patient_name, from_user_id, from_name, from_role, channel, reason, message, callback)
         SELECT 'CR-' || lpad(s::text, 6, '0'), s, $1, $2, $3, $4, $5, $6, $7, $8, $9 FROM n RETURNING *`,
        [patientId, patientName, req.user.id, req.user.name || req.user.id, req.user.role, v.value.channel, v.value.reason, v.value.message, v.value.callback],
      );
      await event(client, r.id, req, v.value.channel === 'call' ? 'call_started' : 'requested', { reason: v.value.reason, callback: v.value.callback });
      return r;
    });

    const sms = await notifyClinic(C.hotlineText({
      id: row.id, fromName: row.from_name, fromRole: row.from_role, patientName, channel: row.channel, reason: row.reason, callback: row.callback,
    }), req.get('x-request-id'));
    await pool.query('UPDATE contact_requests SET clinic_sms = $2, clinic_sms_note = $3, clinic_sms_ref = $4 WHERE id = $1', [row.id, sms.delivery, sms.note || null, sms.ref || null]);
    await event(pool, row.id, null, 'clinic_notified', { delivery: sms.delivery, note: sms.note || null });
    logger.info('clinic contact', { requestId: row.id, patientId, from: req.user.id, channel: row.channel, notice: sms.delivery });
    const { rows: [full] } = await pool.query(`${SELECT} WHERE r.id = $1`, [row.id]);
    return res.status(201).json({ request: toDto(full, (await eventsFor([row.id]))[row.id]) });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/patients/:id/clinic-contact', requireInternalToken, async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!ID_RE.test(patientId)) return res.status(404).json({ error: 'not_found' });
    if (!req.user || !(isNurse(req) || (FAMILY_SIDE.includes(req.user.role) && req.user.patients.includes(patientId)))) return forbid(res, 'You are not linked to this elder');
    const { rows } = await pool.query(`${SELECT} WHERE r.patient_id = $1 ORDER BY r.created_at DESC LIMIT 20`, [patientId]);
    const fresh = await Promise.all(rows.map((r) => followNotice(r, req.get('x-request-id'))));
    const ev = await eventsFor(fresh.map((r) => r.id));
    return res.json({ requests: fresh.map((r) => toDto(r, ev[r.id])) });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/clinic/contact-requests', requireInternalToken, async (req, res, next) => {
  try {
    if (!isNurse(req)) return forbid(res, 'Nurses only');
    const all = req.query.status === 'all';
    const { rows } = await pool.query(
      `${SELECT} ${all ? '' : "WHERE r.status IN ('sent','seen')"} ORDER BY (r.status = 'sent') DESC, r.created_at DESC LIMIT 100`,
    );
    const ev = await eventsFor(rows.map((r) => r.id));
    const { rows: [c] } = await pool.query("SELECT count(*) FILTER (WHERE status = 'sent')::int AS unseen, count(*) FILTER (WHERE status IN ('sent','seen'))::int AS open FROM contact_requests");
    return res.json({ ...c, requests: rows.map((r) => toDto(r, ev[r.id])) });
  } catch (err) {
    return next(err);
  }
});

function nurseStep(to) {
  return async (req, res, next) => {
    try {
      if (!isNurse(req)) return forbid(res, 'Nurses only');
      if (!CR_RE.test(req.params.id)) return res.status(404).json({ error: 'not_found' });
      const text = typeof (req.body || {})[to === 'answered' ? 'reply' : 'note'] === 'string' ? req.body[to === 'answered' ? 'reply' : 'note'].trim() : '';
      if (to !== 'seen' && (text.length < 3 || text.length > 1000)) {
        return res.status(422).json({ error: 'validation_failed', details: [`${to === 'answered' ? 'reply' : 'note'} is required (3-1000 characters)`] });
      }
      const out = await withTransaction(async (client) => {
        const { rows: [r] } = await client.query('SELECT * FROM contact_requests WHERE id = $1 FOR UPDATE', [req.params.id]);
        if (!r) return { status: 404, body: { error: 'not_found' } };
        if (to === 'seen' && r.status !== 'sent') return { status: 200, body: { unchanged: true } };
        if (!C.canMove(r.status, to)) return { status: 409, body: { error: 'conflict', message: `This request is already ${r.status}` } };
        const sets = ['status = $2'];
        const params = [r.id, to === 'closed' && r.status === 'answered' ? 'closed' : to];
        // Answering or closing implies it was seen: record that too.
        if (!r.seen_at) { params.push(req.user.id, req.user.name); sets.push(`seen_at = now(), seen_by = $${params.length - 1}, seen_by_name = $${params.length}`); }
        if (to === 'answered') { params.push(text, req.user.id, req.user.name); sets.push(`reply = $${params.length - 2}, replied_at = now(), replied_by = $${params.length - 1}, replied_by_name = $${params.length}`); }
        await client.query(`UPDATE contact_requests SET ${sets.join(', ')} WHERE id = $1`, params);
        if (!r.seen_at) await event(client, r.id, req, 'seen');
        if (to !== 'seen') await event(client, r.id, req, to, { [to === 'answered' ? 'reply' : 'note']: text });
        return { status: 200 };
      });
      if (out.status !== 200 || (out.body && out.body.unchanged)) return res.status(out.status).json(out.body);
      const { rows: [full] } = await pool.query(`${SELECT} WHERE r.id = $1`, [req.params.id]);
      return res.json({ request: toDto(full, (await eventsFor([full.id]))[full.id]) });
    } catch (err) {
      return next(err);
    }
  };
}
router.post('/api/clinic/contact-requests/:id/seen', requireInternalToken, nurseStep('seen'));
router.post('/api/clinic/contact-requests/:id/reply', requireInternalToken, nurseStep('answered'));
router.post('/api/clinic/contact-requests/:id/close', requireInternalToken, nurseStep('closed'));

module.exports = router;

'use strict';

const express = require('express');
const { pool } = require('./db');
const { dispatchAlert, SEVERITY_RANK } = require('./notifier');
const mashup = require('./weatherAlertMashup');
const { verifyWebhookSignature } = require('./textbeeClient');
const { sendSms, normalizePhone, mode: smsMode, allowlist } = require('./smsSender');
const logger = require('./lib/logger');
const { requireInternalToken, internalHeaders } = require('./lib/internalAuth');
const { processOnce } = require('./lib/idempotency');
const events = require('./events');
const { request } = require('./lib/resilientHttp');
const { parseSmsCheckin, HELP_TEXT: SMS_HELP_TEXT } = require('./smsCheckinParser');
const { parsePagination, pageInfo } = require('./lib/pagination');
const alertRules = require('./alertRules');

const router = express.Router();
router.use(requireInternalToken);

const SEVERITIES = Object.keys(SEVERITY_RANK);
const CHANNELS = ['sms', 'in_app'];

/* ------------------------- POST /api/alerts/dispatch ------------------------- */
// Manual / programmatic alert dispatch (clinic staff, admin). RBAC already enforced at the gateway.
router.post('/api/alerts/dispatch', async (req, res, next) => {
  try {
    if (!req.user || !['clinic_staff', 'system_admin'].includes(req.user.role)) {
      return res.status(403).json({ error: 'forbidden', message: 'Only clinic staff or administrators can dispatch alerts' });
    }
    const b = req.body || {};
    const errors = [];
    if (typeof b.patientId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.patientId)) errors.push('patientId is required');
    if (typeof b.message !== 'string' || b.message.trim().length < 5 || b.message.length > 480) errors.push('message must be 5-480 characters');
    if (b.severity !== undefined && !SEVERITIES.includes(b.severity)) errors.push(`severity must be one of: ${SEVERITIES.join(', ')}`);
    if (b.channels !== undefined && (!Array.isArray(b.channels) || !b.channels.length || b.channels.some((c) => !CHANNELS.includes(c)))) {
      errors.push(`channels must be a non-empty subset of: ${CHANNELS.join(', ')}`);
    }
    if (b.title !== undefined && (typeof b.title !== 'string' || b.title.length > 120)) errors.push('title must be at most 120 characters');
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    const result = await dispatchAlert({
      patientId: b.patientId,
      source: 'manual',
      ruleCode: 'MANUAL',
      severity: b.severity || 'moderate',
      title: b.title || 'Message from your health center',
      message: b.message.trim(),
      channels: b.channels,
      metadata: { requestedBy: req.user.id, reason: b.reason || null },
      createdBy: req.user.id,
    });
    return res.status(202).json(result);
  } catch (err) {
    return next(err);
  }
});

/* ---------------------- GET /api/alerts/notifications ------------------------ */
// Family Dashboard / Caregiver App in-app feed, limited to the caller's patients.
// ?patientId=&page=&pageSize= (limit= still accepted)
router.get('/api/alerts/notifications', async (req, res, next) => {
  try {
    const pg = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    if (pg.errors.length) return res.status(422).json({ error: 'validation_failed', details: pg.errors });
    let patients = req.user ? req.user.patients : [];
    if (req.query.patientId) {
      if (!patients.includes(req.query.patientId)) return res.status(403).json({ error: 'forbidden', message: 'Not your patient' });
      patients = [req.query.patientId];
    }
    if (!patients.length) return res.json({ notifications: [], pagination: pageInfo(pg, 0) });
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `SELECT a.id, a.patient_id, a.source, a.rule_code, a.severity, a.title, a.message, a.metadata, a.created_at,
                coalesce(json_agg(json_build_object('channel', n.channel, 'status', n.status, 'note', n.note, 'provider', n.provider)) FILTER (WHERE n.id IS NOT NULL), '[]') AS delivery
           FROM alerts a LEFT JOIN notification_log n ON n.alert_id = a.id
          WHERE a.patient_id = ANY($1)
          GROUP BY a.id ORDER BY a.created_at DESC, a.id LIMIT $2 OFFSET $3`,
        [patients, pg.pageSize, pg.offset],
      ),
      pool.query('SELECT count(*)::int AS total FROM alerts WHERE patient_id = ANY($1)', [patients]),
    ]);
    return res.json({
      pagination: pageInfo(pg, total),
      notifications: rows.map((r) => ({
        id: r.id, patientId: r.patient_id, source: r.source, rule: r.rule_code, severity: r.severity,
        title: r.title, message: r.message, metadata: r.metadata, createdAt: r.created_at, delivery: r.delivery,
      })),
    });
  } catch (err) {
    return next(err);
  }
});

/* --------------------------- Alert rules (CRUD) --------------------------- */
// Heatwave / typhoon rules the weather mashup evaluates, plus the event-driven system rules.
// Read: clinic staff + admin. Write: admin only (RBAC at the gateway, re-checked here).
const RULE_CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;
const isAdmin = (req) => req.user && req.user.role === 'system_admin';
const canReadRules = (req) => req.user && ['clinic_staff', 'system_admin'].includes(req.user.role);

/** Splits the API's action object into the action JSONB + the channels / min_severity columns. */
function ruleColumns(value) {
  const cols = { ...value };
  if (value.action) {
    const { channels, min_severity: minSeverity, ...rest } = value.action;
    cols.action = rest;
    if (channels) cols.channels = channels;
    if (minSeverity) cols.min_severity = minSeverity;
  }
  return cols;
}

router.get('/api/alerts/rules', async (req, res, next) => {
  try {
    if (!canReadRules(req)) return res.status(403).json({ error: 'forbidden' });
    const pg = parsePagination(req.query, { defaultPageSize: 50, maxPageSize: 200 });
    if (pg.errors.length) return res.status(422).json({ error: 'validation_failed', details: pg.errors });
    const where = [];
    const params = [];
    if (req.query.type === 'weather') where.push('hazard IS NOT NULL');
    else if (req.query.type === 'system') where.push('hazard IS NULL');
    if (['heat', 'storm'].includes(req.query.hazard)) { params.push(req.query.hazard); where.push(`hazard = $${params.length}`); }
    if (['true', 'false'].includes(req.query.enabled)) { params.push(req.query.enabled === 'true'); where.push(`enabled = $${params.length}`); }
    const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(`SELECT * FROM alert_rules ${clause} ORDER BY hazard NULLS LAST, code LIMIT $${params.length + 1} OFFSET $${params.length + 2}`, [...params, pg.pageSize, pg.offset]),
      pool.query(`SELECT count(*)::int AS total FROM alert_rules ${clause}`, params),
    ]);
    return res.json({ rules: rows.map(alertRules.toRuleDto), pagination: pageInfo(pg, total) });
  } catch (err) {
    return next(err);
  }
});

router.get('/api/alerts/rules/:code', async (req, res, next) => {
  try {
    if (!canReadRules(req)) return res.status(403).json({ error: 'forbidden' });
    if (!RULE_CODE_RE.test(req.params.code)) return res.status(404).json({ error: 'not_found', message: 'Rule not found' });
    const { rows } = await pool.query('SELECT * FROM alert_rules WHERE code = $1', [req.params.code]);
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'Rule not found' });
    return res.json(alertRules.toRuleDto(rows[0]));
  } catch (err) {
    return next(err);
  }
});

router.post('/api/alerts/rules', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden', message: 'Only administrators can manage alert rules' });
    const { errors, value } = alertRules.validateRule(req.body);
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
    const c = ruleColumns(value);
    const { rows } = await pool.query(
      `INSERT INTO alert_rules (code, description, enabled, hazard, trigger_condition, vulnerability_target, action, channels, min_severity, updated_by)
       VALUES ($1, $2, coalesce($3::boolean, TRUE), $4, $5, $6, $7, coalesce($8::text[], '{sms,in_app}'), coalesce($9::text, 'moderate'), $10)
       ON CONFLICT (code) DO NOTHING RETURNING *`,
      [c.code, c.description, c.enabled ?? null, c.hazard, c.trigger_condition, c.vulnerability_target, c.action, c.channels || null, c.min_severity || null, req.user.id],
    );
    if (!rows.length) return res.status(409).json({ error: 'conflict', message: `Rule ${c.code} already exists` });
    logger.info('alert rule created', { code: c.code, by: req.user.id });
    return res.status(201).location(`/api/alerts/rules/${c.code}`).json(alertRules.toRuleDto(rows[0]));
  } catch (err) {
    return next(err);
  }
});

router.patch('/api/alerts/rules/:code', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden', message: 'Only administrators can manage alert rules' });
    if (!RULE_CODE_RE.test(req.params.code)) return res.status(404).json({ error: 'not_found', message: 'Rule not found' });
    const { rows: [existing] } = await pool.query('SELECT * FROM alert_rules WHERE code = $1', [req.params.code]);
    if (!existing) return res.status(404).json({ error: 'not_found', message: 'Rule not found' });
    const { errors, value } = alertRules.validateRule(req.body, { partial: true, existing });
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
    const c = ruleColumns(value);
    const cols = ['description', 'enabled', 'hazard', 'trigger_condition', 'vulnerability_target', 'action', 'channels', 'min_severity'].filter((k) => c[k] !== undefined);
    const params = [existing.code, ...cols.map((k) => c[k]), req.user.id];
    const { rows } = await pool.query(
      `UPDATE alert_rules SET ${cols.map((k, i) => `${k} = $${i + 2}`).join(', ')}, updated_by = $${params.length}, updated_at = now()
        WHERE code = $1 RETURNING *`,
      params,
    );
    logger.info('alert rule updated', { code: existing.code, fields: cols, by: req.user.id });
    return res.json(alertRules.toRuleDto(rows[0]));
  } catch (err) {
    return next(err);
  }
});

router.delete('/api/alerts/rules/:code', async (req, res, next) => {
  try {
    if (!isAdmin(req)) return res.status(403).json({ error: 'forbidden', message: 'Only administrators can manage alert rules' });
    if (alertRules.SYSTEM_RULES.includes(req.params.code)) {
      return res.status(409).json({ error: 'conflict', message: 'System rules cannot be deleted; disable them with PATCH {"enabled": false}' });
    }
    if (!RULE_CODE_RE.test(req.params.code)) return res.status(404).json({ error: 'not_found', message: 'Rule not found' });
    // Past alerts keep their rule_code as plain text (no FK), so history stays readable.
    const { rowCount } = await pool.query('DELETE FROM alert_rules WHERE code = $1', [req.params.code]);
    if (!rowCount) return res.status(404).json({ error: 'not_found', message: 'Rule not found' });
    logger.info('alert rule deleted', { code: req.params.code, by: req.user.id });
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

/* --------------------- POST /api/alerts/weather-check ------------------------ */
// Lets clinic staff / admins run the weather mashup on demand (e.g. during a demo or typhoon).
router.post('/api/alerts/weather-check', async (req, res, next) => {
  try {
    const { zipCode, countryCode } = req.body || {};
    if (!process.env.OPENWEATHER_API_KEY) {
      return res.status(503).json({ error: 'not_configured', message: 'OPENWEATHER_API_KEY is not set in the alert service .env' });
    }
    if (zipCode !== undefined && !/^[A-Za-z0-9 -]{3,10}$/.test(String(zipCode))) {
      return res.status(422).json({ error: 'validation_failed', details: ['zipCode is invalid'] });
    }
    const results = zipCode
      ? [await mashup.runMashupForZip({ zipCode: String(zipCode), countryCode: countryCode || 'PH' })]
      : await mashup.runMashupForAllLocations();
    const ok = results.filter((r) => !r.error);
    const hottest = ok.reduce((a, r) => (typeof r.heatIndexC === 'number' && (!a || r.heatIndexC > a.heatIndexC) ? r : a), null);
    const actions = ok.flatMap((r) => r.actions || []);
    const summary = {
      areasChecked: results.length,
      areasFailed: results.length - ok.length,
      hottest: hottest ? { zipCode: hottest.zipCode, locationName: hottest.locationName, heatIndexC: hottest.heatIndexC } : null,
      heatAreas: ok.filter((r) => r.heat && r.heat.triggered).map((r) => r.zipCode),
      stormAreas: ok.filter((r) => r.storm && r.storm.triggered).map((r) => r.zipCode),
      patientsWarned: actions.filter((a) => a.sms && !a.sms.suppressed).length,
      alreadyWarned: actions.filter((a) => a.sms && a.sms.suppressed).length,
      triageItemsCreated: actions.filter((a) => a.clinic && a.clinic.created).length,
      usedCachedData: ok.some((r) => r.cache === 'stale'),
    };
    return res.json({ ranAt: new Date().toISOString(), summary, results });
  } catch (err) {
    if (err.message && err.message.includes('OPENWEATHER_API_KEY')) return res.status(503).json({ error: 'not_configured', message: err.message });
    return next(err);
  }
});

/* ------------------------- POST /internal/events ----------------------------- */
// Consumes saga events from the check-in service outbox. Idempotent on eventId.
function anomalyMessage(evt) {
  const name = evt.patient.fullName;
  const top = (evt.anomalies || []).slice(0, 2).map((a) => (a.value !== undefined ? `${a.message} (${a.value})` : a.message)).join('; ');
  if (evt.type === 'checkin.missed') return `No check-in for ${name} in over a day. Please contact the caregiver to confirm they are safe.`;
  return `ALERT for ${name}: ${top}. Logged in today's check-in; the health center has been notified.`;
}

const HANDLED_EVENTS = ['checkin.anomaly_detected', 'checkin.missed'];

/**
 * Event consumer for queue alert-service.checkin-events (and POST /internal/events in http mode).
 * processOnce() records the eventId and writes the alert + SMS outbox rows in ONE transaction, so a
 * redelivered event never alerts the family twice, and a failure rolls everything back for retry.
 * @returns {Promise<{status:number, body:object}>}
 */
async function handleCheckinEvent(evt) {
  if (!evt || !evt.eventId || !evt.type || !evt.patient || !evt.patient.id) {
    throw Object.assign(new Error('eventId, type and patient.id are required'), { permanent: true, status: 400 });
  }
  if (!HANDLED_EVENTS.includes(evt.type)) return { status: 202, body: { ignored: true } };
  const missed = evt.type === 'checkin.missed';
  const r = await processOnce(pool, evt.eventId, (client) => dispatchAlert({
    patientId: evt.patient.id,
    source: missed ? 'missed_checkin' : 'anomaly',
    ruleCode: missed ? 'MISSED_CHECKIN' : 'HEALTH_ANOMALY',
    severity: evt.severity || 'moderate',
    title: missed ? 'Missed daily check-in' : `${String(evt.severity).charAt(0).toUpperCase()}${String(evt.severity).slice(1)} health alert`,
    message: anomalyMessage(evt),
    metadata: { eventId: evt.eventId, checkinId: evt.checkin && evt.checkin.id, anomalies: evt.anomalies, severityScore: evt.severityScore },
    correlationId: evt.correlationId || evt.eventId,
  }, client));
  if (r.duplicate) return { status: 200, body: { duplicate: true } };
  events.outbox.kick(); // committed: publish the SMS requests now
  return { status: 202, body: r.result };
}

// HTTP fallback (EVENT_TRANSPORT=http) and manual testing with Postman.
router.post('/internal/events', async (req, res, next) => {
  try {
    const { status, body } = await handleCheckinEvent(req.body);
    return res.status(status).json(body);
  } catch (err) {
    if (err.status === 400) return res.status(400).json({ error: 'bad_request', message: err.message });
    return next(err);
  }
});

/* ------------------------------ SMS check-in ------------------------------ */
// SMS check-in fallback (Section 20, Risk 3): a registered caregiver texts vitals to the TextBee phone.
/**
 * SMS check-in logic for inbound TextBee messages.
 * @returns {Promise<string>} the reply text for the caregiver
 */
async function handleSmsCheckin({ from, body, messageId, requestId }) {
  const phone = normalizePhone(from);
  if (!phone) return 'This number is not registered as an ElderCare caregiver. Please contact your health center.';
  const { rows: links } = await pool.query(
    `SELECT user_id, patient_id FROM subscribers WHERE phone_e164 = $1 AND relation = 'caregiver' AND user_id IS NOT NULL`, [phone],
  );
  if (!links.length) return 'This number is not registered as an ElderCare caregiver. Please contact your health center.';

  const caregiverId = links[0].user_id;
  const allowedPatients = [...new Set(links.filter((l) => l.user_id === caregiverId).map((l) => l.patient_id))];
  const parsed = parseSmsCheckin(body, allowedPatients);
  if (parsed.help) return SMS_HELP_TEXT;
  if (!parsed.ok) return `Not saved: ${parsed.errors.join('; ')}. Reply HELP for the format.`;

  if (messageId && /^[A-Za-z0-9_-]{8,80}$/.test(messageId)) parsed.checkin.idempotencyKey = `sms-${messageId}`.slice(0, 100);
  const r = await request('checkin-service', {
    method: 'POST',
    url: `${process.env.CHECKIN_SERVICE_URL || 'http://localhost:4001'}/internal/checkins`,
    data: { caregiverId, allowedPatients, checkin: parsed.checkin },
    headers: internalHeaders(requestId),
    validateStatus: () => true,
  }, { retries: 0, timeoutMs: 5000 });

  logger.info('sms check-in', { caregiverId, patientId: parsed.checkin.patientId, status: r.status });
  if (r.status === 201 || r.status === 200) {
    const c = r.data.checkin;
    const summary = c.severity === 'none' ? 'All readings normal.' : `${c.severity.toUpperCase()}: ${c.anomalies.map((a) => a.message).join('; ')}. Family and health center notified.`;
    return `Saved check-in for ${c.patientId}. ${summary}`;
  }
  const why = (r.data && (r.data.details ? r.data.details.join('; ') : r.data.message)) || 'please try again later';
  return `Not saved: ${why}`;
}

/* ------------------- SMS actions for the Node-RED content-based router ------------------- */
// Node-RED (integration/node-red) classifies each TextBee webhook and calls exactly one of these.
// Each inbound route is idempotent on TextBee's smsId and texts its own reply to the sender.

/** false if this inbound SMS was already handled (TextBee retries webhooks). */
async function claimInboundSms(smsId) {
  if (!smsId) return true;
  const { rowCount } = await pool.query('INSERT INTO alert_dedupe (dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING', [`textbee-in:${smsId}`]);
  return rowCount === 1;
}

/** Applies a TextBee delivery receipt to notification_log. */
async function applyDeliveryStatus({ id, status, error }) {
  const { rowCount } = await pool.query(
    `UPDATE notification_log SET status = $2, updated_at = now(), error = CASE WHEN $2 = 'failed' THEN coalesce($3, 'TextBee reported failure') ELSE error END
      WHERE provider_sid = $1 AND channel = 'sms'`,
    [id, status, error || null],
  );
  return rowCount;
}

async function replySms(to, text) {
  try {
    await sendSms({ to, body: `[ElderCare] ${text}` });
    return true;
  } catch (err) {
    logger.error('sms reply failed', { error: err.message });
    return false;
  }
}

async function patientName(patientId, requestId) {
  try {
    const r = await request('checkin-service', {
      method: 'GET', url: `${process.env.CHECKIN_SERVICE_URL || 'http://localhost:4001'}/internal/patients/${encodeURIComponent(patientId)}`, headers: internalHeaders(requestId),
    }, { retries: 0, timeoutMs: 2000 });
    return (r.data && (r.data.fullName || (r.data.patient && r.data.patient.fullName))) || patientId;
  } catch {
    return patientId;
  }
}

/** SOS from a registered caregiver: critical alert to every other contact of their patients. */
async function handleSmsEmergency({ from, body, smsId, requestId }) {
  const phone = normalizePhone(from);
  const { rows: links } = phone ? await pool.query(
    `SELECT DISTINCT user_id, patient_id FROM subscribers WHERE phone_e164 = $1 AND relation = 'caregiver' AND user_id IS NOT NULL`, [phone],
  ) : { rows: [] };
  if (!links.length) return 'This number is not registered as an ElderCare caregiver. In an emergency call 911.';
  const note = body.replace(/^\s*(SOS|EMERGENCY|EMERGENCIA|SAKLOLO)\b[:\s-]*/i, '').slice(0, 200);
  const names = [];
  for (const link of links) {
    const name = await patientName(link.patient_id, requestId);
    names.push(name);
    await dispatchAlert({
      patientId: link.patient_id,
      source: 'sms_sos',
      ruleCode: 'SMS_SOS',
      severity: 'critical',
      title: 'SOS from caregiver',
      message: `SOS for ${name}: the caregiver texted ${phone}${note ? ` ("${note}")` : ''}. Call the caregiver now; if you cannot reach them, call 911.`,
      metadata: { from: phone, caregiverId: link.user_id, smsId, note },
      excludePhones: [phone],
      createdBy: link.user_id,
      dedupeKey: smsId ? `sos:${smsId}:${link.patient_id}` : undefined,
    });
  }
  logger.warn('caregiver SOS', { caregiverId: links[0].user_id, patients: links.map((l) => l.patient_id) });
  return `SOS received. The family of ${names.join(', ')} has been alerted. If life is in danger, call 911 now.`;
}

/** STOP / START: turn SMS alerts off or on for every patient this number follows. */
async function setSmsEnabled(from, enabled) {
  const phone = normalizePhone(from);
  if (!phone) return 0;
  const { rowCount } = await pool.query('UPDATE subscribers SET sms_enabled = $2 WHERE phone_e164 = $1', [phone, enabled]);
  logger.info(enabled ? 'sms opt-in' : 'sms opt-out', { subscriptions: rowCount });
  return rowCount;
}

const SMS_ROUTE_HANDLERS = {
  checkin: (sms) => handleSmsCheckin({ from: sms.from, body: sms.body, messageId: sms.smsId, requestId: sms.requestId }),
  emergency: (sms) => handleSmsEmergency(sms),
  opt_out: async (sms) => ((await setSmsEnabled(sms.from, false))
    ? 'You will no longer receive ElderCare SMS alerts. Reply START to turn them back on.'
    : 'This number is not on any ElderCare alert list.'),
  opt_in: async (sms) => ((await setSmsEnabled(sms.from, true))
    ? 'ElderCare SMS alerts are on again. Reply STOP to turn them off.'
    : 'This number is not on any ElderCare alert list. Ask your health center to add it.'),
  help: async () => `${SMS_HELP_TEXT} In an emergency text SOS.`,
  unknown: async () => `Sorry, we did not understand that message. ${SMS_HELP_TEXT}`,
};

router.post('/internal/sms/status', async (req, res, next) => {
  try {
    const b = req.body || {};
    if (typeof b.id !== 'string' || !b.id || !['sent', 'delivered', 'failed'].includes(b.status)) {
      return res.status(422).json({ error: 'validation_failed', details: ['id and status (sent|delivered|failed) are required'] });
    }
    return res.json({ matched: await applyDeliveryStatus(b) });
  } catch (err) {
    return next(err);
  }
});

router.post('/internal/sms/:route', async (req, res, next) => {
  try {
    const handler = SMS_ROUTE_HANDLERS[req.params.route];
    if (!handler) return res.status(404).json({ error: 'not_found', message: `Unknown SMS route ${req.params.route}` });
    const b = req.body || {};
    const errors = [];
    if (typeof b.from !== 'string' || !b.from.trim()) errors.push('from is required');
    if (typeof b.body !== 'string') errors.push('body is required');
    if (b.smsId !== undefined && b.smsId !== null && !/^[A-Za-z0-9_-]{4,80}$/.test(String(b.smsId))) errors.push('smsId is invalid');
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    if (!(await claimInboundSms(b.smsId))) return res.json({ route: req.params.route, duplicate: true });
    const sms = { from: b.from.trim(), body: b.body.slice(0, 1000), smsId: b.smsId || null, requestId: req.get('x-request-id') };
    const reply = await handler(sms);
    const replySent = await replySms(sms.from, reply);
    return res.json({ route: req.params.route, reply, replySent });
  } catch (err) {
    return next(err);
  }
});

/* ----------------------------- POST /webhooks/textbee ----------------------------- */
// Configure in the TextBee dashboard -> Webhooks: URL https://<your-public-gateway>/webhooks/textbee,
// events MESSAGE_RECEIVED (SMS check-ins) and MESSAGE_SENT / MESSAGE_DELIVERED / MESSAGE_FAILED (receipts).
// The signing secret goes in TEXTBEE_WEBHOOK_SECRET. TextBee expects a 2xx within 10 seconds.
const TEXTBEE_STATUS = { MESSAGE_SENT: 'sent', MESSAGE_DELIVERED: 'delivered', MESSAGE_FAILED: 'failed' };

router.post('/webhooks/textbee', async (req, res, next) => {
  try {
    if (process.env.TEXTBEE_VALIDATE_WEBHOOK !== 'false') {
      if (!verifyWebhookSignature(req.rawBody, req.get('x-signature'))) {
        return res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing X-Signature' });
      }
    }
    const evt = req.body || {};
    const event = evt.webhookEvent || evt.event;

    if (TEXTBEE_STATUS[event]) {
      const id = evt.smsBatchId || evt.smsId;
      if (id) {
        const matched = await applyDeliveryStatus({ id: String(id), status: TEXTBEE_STATUS[event], error: evt.errorMessage || evt.message });
        logger.info('textbee status update', { event, matched });
      }
      return res.status(200).json({ ok: true });
    }

    if (event === 'MESSAGE_RECEIVED') {
      // Acknowledge first (TextBee's 10-second limit), then process and text the reply back.
      res.status(200).json({ ok: true });
      if (!(await claimInboundSms(evt.idempotencyKey || evt.smsId))) return undefined;
      try {
        const reply = await handleSmsCheckin({ from: evt.sender, body: evt.message, messageId: evt.smsId, requestId: req.get('x-request-id') });
        await sendSms({ to: evt.sender, body: `[ElderCare] ${reply}` });
      } catch (err) {
        logger.error('textbee sms check-in failed', { error: err.message });
      }
      return undefined;
    }
    return res.status(200).json({ ignored: true });
  } catch (err) {
    return next(err);
  }
});

/* --------------------------- SMS contacts (subscribers) --------------------------- */
// Who receives a patient's SMS alerts. Clinic staff / admins manage them (RBAC at the gateway).
const RELATIONS = ['caregiver', 'family', 'sponsor'];
function toSubscriberDto(r) {
  return { id: r.id, patientId: r.patient_id, userId: r.user_id, name: r.name, relation: r.relation, phone: r.phone_e164, smsEnabled: r.sms_enabled, createdAt: r.created_at };
}

router.get('/api/alerts/subscribers', async (req, res, next) => {
  try {
    const patientId = String(req.query.patientId || '');
    if (!patientId) return res.status(422).json({ error: 'validation_failed', details: ['patientId is required'] });
    const { rows } = await pool.query('SELECT * FROM subscribers WHERE patient_id = $1 ORDER BY relation, name', [patientId]);
    const m = smsMode();
    return res.json({ patientId, subscribers: rows.map((r) => ({ ...toSubscriberDto(r), receivesRealSms: m.live && (!m.allowlistSize || allowlist().has(r.phone_e164)) })), sms: m });
  } catch (err) {
    return next(err);
  }
});

router.post('/api/alerts/subscribers', async (req, res, next) => {
  try {
    if (!req.user || !['clinic_staff', 'system_admin'].includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    const b = req.body || {};
    const errors = [];
    if (typeof b.patientId !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(b.patientId)) errors.push('patientId is required');
    const name = typeof b.name === 'string' ? b.name.trim() : '';
    if (name.length < 2 || name.length > 80) errors.push('name must be 2-80 characters');
    if (!RELATIONS.includes(b.relation)) errors.push(`relation must be one of: ${RELATIONS.join(', ')}`);
    const phone = normalizePhone(b.phone);
    if (!phone) errors.push('phone must be a mobile number, e.g. 09171234567 or +639171234567');
    if (b.userId !== undefined && b.userId !== null && b.userId !== '' && !/^[A-Za-z0-9._-]{1,64}$/.test(String(b.userId))) errors.push('userId is invalid');
    if (b.relation === 'caregiver' && !b.userId) errors.push('userId is required for caregivers (used to match SMS check-ins)');
    if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });

    const { rows } = await pool.query(
      `INSERT INTO subscribers (patient_id, user_id, name, relation, phone_e164, created_by) VALUES ($1,$2,$3,$4,$5,$6)
       ON CONFLICT (patient_id, phone_e164) DO UPDATE SET name = EXCLUDED.name, relation = EXCLUDED.relation, user_id = EXCLUDED.user_id, sms_enabled = TRUE
       RETURNING *`,
      [b.patientId, b.userId || null, name, b.relation, phone, req.user.id],
    );
    return res.status(201).json(toSubscriberDto(rows[0]));
  } catch (err) {
    return next(err);
  }
});

router.delete('/api/alerts/subscribers/:id', async (req, res, next) => {
  try {
    if (!req.user || !['clinic_staff', 'system_admin'].includes(req.user.role)) return res.status(403).json({ error: 'forbidden' });
    if (!/^\d+$/.test(req.params.id)) return res.status(400).json({ error: 'bad_request' });
    // Disable rather than delete: notification_log rows reference subscribers.
    const { rowCount } = await pool.query('UPDATE subscribers SET sms_enabled = FALSE WHERE id = $1', [req.params.id]);
    if (!rowCount) return res.status(404).json({ error: 'not_found' });
    return res.status(204).end();
  } catch (err) {
    return next(err);
  }
});

module.exports = router;
module.exports.handleCheckinEvent = handleCheckinEvent;

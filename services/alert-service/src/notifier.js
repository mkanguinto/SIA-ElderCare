'use strict';

/**
 * Creates an alert, records the in-app notification, and requests one SMS per subscriber.
 * Shared by: manual dispatch (POST /api/alerts/dispatch), check-in events from RabbitMQ, and the
 * weather mashup.
 *
 * Everything happens in ONE local transaction: the alert row, its notification_log rows, and one
 * notification.sms.requested event per SMS in the outbox. After COMMIT the outbox relay publishes
 * the events to RabbitMQ and the TextBee SMS worker (smsWorker.js) sends them. So an alert is never
 * saved without its SMS requests, and an SMS is never requested for an alert that rolled back.
 */
const { pool } = require('./db');
const events = require('./events');
const logger = require('./lib/logger');

const SEVERITY_RANK = { low: 1, moderate: 2, high: 3, critical: 4 };

// Rule code -> alertType carried in the SMS event (the professor's suggested event contract).
const ALERT_TYPES = {
  HEALTH_ANOMALY: 'HEALTH_ANOMALY_ALERT',
  MISSED_CHECKIN: 'MISSED_CHECKIN_ALERT',
  WEATHER_HEAT: 'HEATWAVE_DEHYDRATION_WARNING',
  WEATHER_STORM: 'TYPHOON_MOBILITY_WARNING',
  MANUAL: 'CLINIC_MESSAGE',
};
function alertTypeFor(ruleCode) {
  return ALERT_TYPES[ruleCode] || String(ruleCode || 'GENERAL_ALERT').toUpperCase().replace(/[^A-Z0-9_]/g, '_');
}

async function getRule(db, code) {
  const { rows } = await db.query('SELECT * FROM alert_rules WHERE code = $1', [code]);
  return rows[0] || null;
}

/** Returns false if this dedupe key was already used (alert suppressed). */
async function claimDedupeKey(db, key) {
  if (!key) return true;
  const { rowCount } = await db.query('INSERT INTO alert_dedupe (dedupe_key) VALUES ($1) ON CONFLICT DO NOTHING', [key]);
  return rowCount === 1;
}

async function dispatchInTransaction(client, a) {
  const rule = await getRule(client, a.ruleCode);
  if (rule && !rule.enabled) return { suppressed: true, reason: 'rule_disabled' };
  if (rule && a.source !== 'manual' && SEVERITY_RANK[a.severity] < SEVERITY_RANK[rule.min_severity]) {
    return { suppressed: true, reason: 'below_min_severity' };
  }
  if (!(await claimDedupeKey(client, a.dedupeKey))) return { suppressed: true, reason: 'duplicate' };

  const channels = a.channels || (rule ? rule.channels : ['sms', 'in_app']);
  const alertType = a.alertType || alertTypeFor(a.ruleCode);

  const { rows: [alert] } = await client.query(
    `INSERT INTO alerts (patient_id, source, rule_code, severity, title, message, metadata, created_by)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8) RETURNING id, created_at`,
    [a.patientId, a.source, a.ruleCode, a.severity, a.title, a.message, a.metadata || {}, a.createdBy || 'system'],
  );

  const notifications = [];
  // In-app notification = the alerts row itself; logged so delivery status is visible in one place.
  if (channels.includes('in_app')) {
    const { rows: [n] } = await client.query(
      `INSERT INTO notification_log (alert_id, channel, status, attempts, alert_type) VALUES ($1, 'in_app', 'delivered', 1, $2) RETURNING id`,
      [alert.id, alertType],
    );
    notifications.push({ id: n.id, channel: 'in_app', status: 'delivered' });
  }

  if (channels.includes('sms')) {
    const { rows: subs } = await client.query('SELECT * FROM subscribers WHERE patient_id = $1 AND sms_enabled = TRUE', [a.patientId]);
    for (const s of subs) {
      const { rows: [n] } = await client.query(
        `INSERT INTO notification_log (alert_id, subscriber_id, channel, status, alert_type) VALUES ($1, $2, 'sms', 'queued', $3) RETURNING id`,
        [alert.id, s.id, alertType],
      );
      await events.outbox.enqueue(client, 'notification.sms.requested', {
        notificationId: n.id,
        alertId: alert.id,
        recipientPhone: s.phone_e164,
        timestamp: new Date().toISOString(),
        alertType,
        severity: a.severity,
        message: `[ElderCare Connect] ${a.message}`.slice(0, 640),
        payload: {
          patientId: a.patientId,
          ...(a.metadata && typeof a.metadata.heatIndexC === 'number' ? { heatIndex: a.metadata.heatIndexC } : {}),
          ...(a.metadata && a.metadata.hazard ? { hazard: a.metadata.hazard } : {}),
        },
      }, { correlationId: a.correlationId });
      notifications.push({ id: n.id, channel: 'sms', subscriberId: s.id, relation: s.relation, status: 'queued' });
    }
    if (!subs.length) logger.warn('no SMS subscribers for patient', { patientId: a.patientId, alertId: alert.id });
  }

  return { suppressed: false, alertId: alert.id, createdAt: alert.created_at, alertType, notifications };
}

/**
 * @param {object} a
 * @param {string} a.patientId
 * @param {string} a.source       anomaly | weather | manual | missed_checkin
 * @param {string} a.ruleCode     key into alert_rules
 * @param {string} a.severity     low | moderate | high | critical
 * @param {string} a.title
 * @param {string} a.message      SMS / in-app text
 * @param {string[]} [a.channels] override rule channels
 * @param {object} [a.metadata]
 * @param {string} [a.createdBy]
 * @param {string} [a.dedupeKey]  suppress duplicates (e.g. same hazard same day)
 * @param {string} [a.alertType]  override the SMS event alertType
 * @param {string} [a.correlationId]
 * @param {import('pg').PoolClient} [client]  join the caller's transaction (e.g. idempotent event consumer)
 */
async function dispatchAlert(a, client) {
  let result;
  if (client) {
    result = await dispatchInTransaction(client, a);
  } else {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      result = await dispatchInTransaction(c, a);
      await c.query('COMMIT');
    } catch (err) {
      await c.query('ROLLBACK').catch(() => {});
      throw err;
    } finally {
      c.release();
    }
  }
  if (!result.suppressed) {
    logger.info('alert dispatched', { alertId: result.alertId, patientId: a.patientId, source: a.source, severity: a.severity, notifications: result.notifications.length });
    // When we own the transaction it is committed now; otherwise the caller kicks after its COMMIT.
    if (!client) events.outbox.kick();
  }
  return result;
}

module.exports = { dispatchAlert, SEVERITY_RANK, alertTypeFor };

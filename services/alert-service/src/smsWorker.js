'use strict';

/**
 * TextBee SMS worker - consumes notification.sms.requested from RabbitMQ
 * (queue alert-service.sms-dispatch, retry tiers 5 s / 30 s / 2 min, then alert-service.sms-dispatch.dlq).
 *
 * Worker idempotency (professor's evaluation, "prevent duplicate notifications during carrier timeouts"):
 * notificationId is the idempotency key and notification_log is the state machine:
 *
 *     queued --claim--> sending --TextBee 2xx--> sent | simulated   (terminal: redelivery = ACK, no resend)
 *                          |--permanent error--> failed              (terminal, DLQ; in-app alert remains)
 *                          |--transient error--> queued              (released; retried from the retry queue)
 *                          '--timeout after the request left--> unconfirmed (DLQ: an operator checks the
 *                                                                  phone's TextBee log before replaying)
 *
 * - The claim (queued -> sending) is a single conditional UPDATE, so two deliveries of the same
 *   message can never both send.
 * - A message that finds its notification still "sending" means a worker died mid-send. We cannot know
 *   whether the phone sent it, so it is parked as "unconfirmed" in the DLQ instead of risking a duplicate.
 *   Set SMS_RETRY_ON_TIMEOUT=true to prefer a possible duplicate over a possible miss.
 * - A DLQ replay (header x-replayed-at) may re-send a failed/unconfirmed notification exactly once more.
 */
const { pool } = require('./db');
const { sendSms, mode } = require('./smsSender');
const logger = require('./lib/logger');

const DAILY_LIMIT = () => Number(process.env.SMS_DAILY_LIMIT || 40);
const RETRY_DELAYS = String(process.env.SMS_RETRY_DELAYS_MS || '5000,30000,120000').split(',').map(Number).filter((n) => n > 0);
const MIN_INTERVAL_MS = () => Number(process.env.SMS_MIN_INTERVAL_MS || 1000); // one phone ~ 1 SMS/s
const TERMINAL = ['sent', 'delivered', 'simulated', 'skipped'];

/** Real (non-simulated) texts sent today, Asia/Manila calendar day. */
async function sentToday() {
  const { rows: [r] } = await pool.query(
    `SELECT count(*)::int AS n FROM notification_log
      WHERE channel = 'sms' AND status IN ('sent','delivered')
        AND updated_at >= (date_trunc('day', now() AT TIME ZONE 'Asia/Manila') AT TIME ZONE 'Asia/Manila')`,
  );
  return r.n;
}

async function updateLog(id, fields) {
  const sets = [];
  const vals = [id];
  for (const [k, v] of Object.entries(fields)) {
    vals.push(v);
    sets.push(`${k} = $${vals.length}`);
  }
  await pool.query(`UPDATE notification_log SET ${sets.join(', ')}, updated_at = now() WHERE id = $1`, vals);
}

function tagged(message, props) {
  return Object.assign(new Error(message), props);
}

/**
 * Atomically claims the notification for sending.
 * @returns {Promise<'claimed'|'done'|'in_doubt'|'missing'>}
 */
async function claim(notificationId, attempt, replay) {
  const from = replay ? ['queued', 'failed', 'unconfirmed'] : ['queued'];
  const { rowCount } = await pool.query(
    `UPDATE notification_log SET status = 'sending', sending_started_at = now(), attempts = $2, updated_at = now()
      WHERE id = $1 AND channel = 'sms' AND status = ANY($3)`,
    [notificationId, attempt, from],
  );
  if (rowCount) return 'claimed';
  const { rows: [row] } = await pool.query('SELECT status FROM notification_log WHERE id = $1', [notificationId]);
  if (!row) return 'missing';
  if (row.status === 'sending') return 'in_doubt';
  return 'done';
}

let lastSendAt = 0;
async function pace() {
  const wait = lastSendAt + MIN_INTERVAL_MS() - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  lastSendAt = Date.now();
}

/**
 * Bus handler. Resolving = ACK. Throwing = retry (transient) or DLQ (permanent / ambiguous).
 * @param {object} evt   notification.sms.requested (already validated against its JSON Schema)
 * @param {{attempts:number, headers:object}} meta
 */
async function handleSmsRequested(evt, meta = { attempts: 1, headers: {} }) {
  const attempt = meta.attempts || 1;
  const replay = Boolean(meta.headers && meta.headers['x-replayed-at']);
  const id = evt.notificationId;

  const claimed = await claim(id, attempt, replay);
  if (claimed === 'missing') throw tagged(`notification ${id} does not exist`, { permanent: true });
  if (claimed === 'done') {
    logger.info('sms already handled - duplicate delivery acknowledged', { notificationId: id, eventId: evt.eventId });
    return { duplicate: true };
  }
  if (claimed === 'in_doubt') {
    if (process.env.SMS_RETRY_ON_TIMEOUT === 'true') {
      await updateLog(id, { status: 'queued', note: 'Previous attempt interrupted; retrying (SMS_RETRY_ON_TIMEOUT=true)' });
      throw tagged('previous send attempt was interrupted', {});
    }
    await updateLog(id, { status: 'unconfirmed', note: 'A worker stopped mid-send; check the TextBee phone log before replaying from the DLQ' });
    throw tagged('previous send attempt was interrupted - delivery unknown', { reason: 'ambiguous_delivery' });
  }

  try {
    if (mode().live && (await sentToday()) >= DAILY_LIMIT()) {
      await updateLog(id, { status: 'skipped', note: `Daily SMS limit reached (${DAILY_LIMIT()}); in-app alert only` });
      logger.warn('sms skipped: daily limit reached', { notificationId: id, limit: DAILY_LIMIT() });
      return { skipped: true };
    }
    await pace();
    const result = await sendSms({ to: evt.recipientPhone, body: evt.message });
    await updateLog(id, {
      status: result.simulated ? 'simulated' : 'sent', provider_sid: result.sid, provider: result.simulated ? 'simulated' : result.provider,
      error: null, note: result.note || (result.warning ? JSON.stringify(result.warning).slice(0, 300) : null),
    });
    logger.info('sms dispatched', { notificationId: id, alertType: evt.alertType, sid: result.sid, simulated: Boolean(result.simulated), attempt });
    return { sent: true, simulated: Boolean(result.simulated) };
  } catch (err) {
    const error = String(err.message).slice(0, 500);
    if (err.ambiguous && process.env.SMS_RETRY_ON_TIMEOUT !== 'true') {
      await updateLog(id, { status: 'unconfirmed', error, note: 'TextBee did not answer in time; the SMS may or may not have been sent' });
      throw tagged(error, { reason: 'ambiguous_delivery' });
    }
    const lastAttempt = attempt > RETRY_DELAYS.length;
    if (err.permanent || lastAttempt) {
      await updateLog(id, { status: 'failed', error });
      logger.warn('sms permanently failed - in-app notification remains as fallback', { notificationId: id, attempt, error: err.message });
      throw tagged(error, { permanent: true });
    }
    await updateLog(id, { status: 'queued', error }); // release the claim so the retry can send
    throw err;
  }
}

/** Subscribes the worker to the bus. One phone = one sender, so prefetch 1. */
async function start(bus) {
  return bus.subscribe({
    queue: 'alert-service.sms-dispatch',
    bindings: ['notification.sms.requested'],
    retryDelaysMs: RETRY_DELAYS,
    prefetch: Number(process.env.SMS_CONCURRENCY || 1),
    handler: handleSmsRequested,
  });
}

module.exports = { start, handleSmsRequested, claim, RETRY_DELAYS };

'use strict';

/**
 * Sends account messages (activation code, password-reset link) through the alert service's SMS sender,
 * so the same dry-run / allow-list rules apply as for alerts. The message text is never logged.
 *
 * ACCOUNT_SMS_CAPTURE=true (local testing only, never in production) also keeps the last few messages in
 * memory for GET /internal/test/account-sms, so automated tests can complete an activation without a phone.
 */
const config = require('../config');
const { request } = require('../lib/resilientHttp');
const logger = require('../lib/logger');

const captured = [];

const internal = (requestId) => ({ 'x-internal-token': config.internalServiceToken, 'x-request-id': requestId || '' });

/**
 * What the alert service did with the message. Only 'delivered' means it reached the phone:
 *   simulated  NOT sent (SMS dry-run, or the number is not on SMS_RECIPIENT_ALLOWLIST) - nobody receives it
 *   queued     accepted by TextBee for the clinic's SMS phone; follow it with checkAccountSms(ref)
 *   failed     not sent (provider error, daily limit, alert service down); note says why
 * @returns {Promise<{delivery:'simulated'|'queued'|'failed', note:string|null, ref:string|null}>}
 */
async function sendAccountSms({ to, body, purpose, requestId }) {
  if (config.accountSmsCapture) {
    captured.unshift({ to, body, purpose, at: new Date().toISOString() });
    captured.length = Math.min(captured.length, 50);
  }
  try {
    const r = await request('alert', {
      method: 'POST',
      url: `${config.services.alert}/internal/messages/sms`,
      headers: internal(requestId),
      data: { to, body, purpose },
      validateStatus: () => true,
    }, { retries: 0, timeoutMs: config.upstreamTimeoutMs });
    if (r.status === 200 && ['simulated', 'queued'].includes(r.data.status)) return { delivery: r.data.status, note: r.data.note || null, ref: r.data.ref || null };
    logger.warn('account sms not sent', { purpose, status: r.status });
    return { delivery: 'failed', note: (r.data && r.data.message) || `SMS service answered ${r.status}`, ref: null };
  } catch (err) {
    logger.warn('account sms not sent', { purpose, error: err.message });
    return { delivery: 'failed', note: 'The SMS service could not be reached', ref: null };
  }
}

/** Latest state of a queued message from TextBee: queued | sent | delivered | failed | unknown (null if it cannot be checked). */
async function checkAccountSms(ref, requestId) {
  try {
    const r = await request('alert', {
      method: 'GET', url: `${config.services.alert}/internal/messages/sms/${encodeURIComponent(ref)}`, headers: internal(requestId), validateStatus: () => true,
    }, { retries: 0, timeoutMs: config.upstreamTimeoutMs });
    return r.status === 200 ? { delivery: r.data.status, note: r.data.note || null } : null;
  } catch {
    return null;
  }
}

/** SMS readiness (mode, allow-list, sending phone, permission, daily count) for the admin. */
async function smsHealth(requestId) {
  const r = await request('alert', {
    method: 'GET', url: `${config.services.alert}/internal/messages/sms-health`, headers: internal(requestId), validateStatus: () => true,
  }, { retries: 0, timeoutMs: Math.max(config.upstreamTimeoutMs, 10000) }); // includes a live look-up at TextBee
  if (r.status !== 200) throw new Error(`SMS service answered ${r.status}`);
  return r.data;
}

/** Test helper: the newest captured message to a number (or null). */
const lastCaptured = (to, purpose) => captured.find((m) => m.to === to && (!purpose || m.purpose === purpose)) || null;

module.exports = { sendAccountSms, checkAccountSms, smsHealth, lastCaptured };

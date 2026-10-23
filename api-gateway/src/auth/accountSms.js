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

/** @returns {Promise<'sent'|'simulated'|'failed'>} */
async function sendAccountSms({ to, body, purpose, requestId }) {
  if (config.accountSmsCapture) {
    captured.unshift({ to, body, purpose, at: new Date().toISOString() });
    captured.length = Math.min(captured.length, 50);
  }
  try {
    const r = await request('alert', {
      method: 'POST',
      url: `${config.services.alert}/internal/messages/sms`,
      headers: { 'x-internal-token': config.internalServiceToken, 'x-request-id': requestId || '' },
      data: { to, body, purpose },
      validateStatus: () => true,
    }, { retries: 1, timeoutMs: config.upstreamTimeoutMs });
    if (r.status === 200) return r.data.status;
    logger.warn('account sms not sent', { purpose, status: r.status });
    return 'failed';
  } catch (err) {
    logger.warn('account sms not sent', { purpose, error: err.message });
    return 'failed';
  }
}

/** Test helper: the newest captured message to a number (or null). */
const lastCaptured = (to, purpose) => captured.find((m) => m.to === to && (!purpose || m.purpose === purpose)) || null;

module.exports = { sendAccountSms, lastCaptured };

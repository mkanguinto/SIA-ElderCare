'use strict';

/**
 * TextBee SMS gateway client (https://textbee.dev) - sends real SMS through your own Android phone.
 *
 *   POST {TEXTBEE_BASE_URL}/gateway/send-sms
 *   Headers: x-api-key: <TEXTBEE_API_KEY>, Content-Type: application/json
 *   Body:    { deviceId, recipients: ["+639..."], message }
 *   200 ->   { data: { success, message, smsBatchId, recipientCount, successCount, failureCount, warning } }
 *
 * Webhooks (delivery receipts + incoming SMS) are signed: X-Signature = hex(HMAC-SHA256(rawBody, TEXTBEE_WEBHOOK_SECRET)).
 * All credentials come from process.env only.
 */
const crypto = require('crypto');
const axios = require('axios');

const BASE_URL = () => (process.env.TEXTBEE_BASE_URL || 'https://api.textbee.dev/api/v1').replace(/\/+$/, '');

function isConfigured() {
  return Boolean(process.env.TEXTBEE_API_KEY);
}

class SmsProviderError extends Error {
  constructor(message, { permanent = false, ambiguous = false, status, code } = {}) {
    super(message);
    this.permanent = permanent;
    this.ambiguous = ambiguous;
    this.status = status;
    this.code = code;
  }
}

/**
 * @param {{to:string, body:string}} msg  `to` must already be normalised to +E.164
 * @returns {Promise<{sid:string, status:string, provider:'textbee'}>}
 */
async function sendViaTextbee({ to, body }, http = axios) {
  if (!isConfigured()) throw new SmsProviderError('TEXTBEE_API_KEY is not set', { permanent: true });
  const payload = { recipients: [to], message: body };
  if (process.env.TEXTBEE_DEVICE_ID) payload.deviceId = process.env.TEXTBEE_DEVICE_ID;
  if (process.env.TEXTBEE_SIM_SUBSCRIPTION_ID) payload.simSubscriptionId = Number(process.env.TEXTBEE_SIM_SUBSCRIPTION_ID);

  let res;
  try {
    res = await http.post(`${BASE_URL()}/gateway/send-sms`, payload, {
      headers: { 'x-api-key': process.env.TEXTBEE_API_KEY, 'Content-Type': 'application/json' },
      timeout: Number(process.env.TEXTBEE_TIMEOUT_MS || 10000),
    });
  } catch (err) {
    const status = err.response && err.response.status;
    const detail = err.response && err.response.data ? (err.response.data.message || err.response.data.error || JSON.stringify(err.response.data)) : err.message;
    // 400 bad number/payload, 401/403 bad key, 404 unknown device: retrying will not help. 429/5xx/network: retry.
    const permanent = Boolean(status && status >= 400 && status < 500 && status !== 408 && status !== 429);
    // No HTTP answer after the request may already have reached TextBee: the SMS may or may not be sent.
    const ambiguous = !status && ['ECONNABORTED', 'ETIMEDOUT', 'ECONNRESET', 'ERR_CANCELED'].includes(err.code);
    throw new SmsProviderError(`TextBee ${status || err.code || 'error'}: ${String(detail).slice(0, 300)}`, { permanent, ambiguous, status, code: err.code });
  }

  const data = (res.data && res.data.data) || res.data || {};
  if (data.success === false || (typeof data.failureCount === 'number' && data.failureCount > 0 && !data.successCount)) {
    throw new SmsProviderError(`TextBee rejected the message: ${data.message || 'unknown reason'}`, { permanent: false });
  }
  return { sid: data.smsBatchId || data._id || `TEXTBEE_${Date.now()}`, status: 'sent', provider: 'textbee', warning: data.warning || null };
}

/** Constant-time check of TextBee's X-Signature header against the raw request body. */
function verifyWebhookSignature(rawBody, signature, secret = process.env.TEXTBEE_WEBHOOK_SECRET) {
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = String(signature).trim().toLowerCase().replace(/^sha256=/, '');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

module.exports = { sendViaTextbee, verifyWebhookSignature, isConfigured, SmsProviderError };

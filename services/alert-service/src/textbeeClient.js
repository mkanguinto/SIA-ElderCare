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

const headers = () => ({ 'x-api-key': process.env.TEXTBEE_API_KEY });
const timeout = () => Number(process.env.TEXTBEE_TIMEOUT_MS || 10000);
let cachedDevice = null;

/** The sending phone: TEXTBEE_DEVICE_ID, else the first enabled device on the account (looked up every 10 min). */
async function listDevices(http = axios) {
  const res = await http.get(`${BASE_URL()}/gateway/devices`, { headers: headers(), timeout: timeout() });
  return (res.data && res.data.data) || [];
}
async function deviceId(http = axios) {
  if (process.env.TEXTBEE_DEVICE_ID) return process.env.TEXTBEE_DEVICE_ID;
  if (cachedDevice && cachedDevice.until > Date.now()) return cachedDevice.id;
  const d = (await listDevices(http)).find((x) => x.enabled);
  if (!d) throw new SmsProviderError('No enabled TextBee phone on this account', { permanent: true });
  cachedDevice = { id: d._id, until: Date.now() + 600000 };
  return d._id;
}

/**
 * What became of a send, from TextBee's batch record (the phone reports each step):
 *   queued    accepted by TextBee, the phone has not sent it yet
 *   sent      the phone handed it to the mobile network (not proof that it arrived)
 *   delivered the network confirmed delivery to the handset
 *   failed    the phone could not send it
 *   unknown   TextBee does not know
 */
function batchOutcome(b) {
  const n = (k) => Number(b[k]) || 0;
  if (n('deliveredCount') > 0 || b.status === 'delivered') return 'delivered';
  if (n('sentCount') > 0 || b.status === 'sent' || b.status === 'completed') return 'sent';
  if (b.status === 'failed' || (n('failureCount') > 0 && !n('pendingCount') && !n('dispatchedCount'))) return 'failed';
  if (b.status === 'unknown') return 'unknown';
  return 'queued';
}

async function batchStatus(batchId, http = axios) {
  const id = await deviceId(http);
  const res = await http.get(`${BASE_URL()}/gateway/devices/${encodeURIComponent(id)}/sms-batch/${encodeURIComponent(batchId)}`, { headers: headers(), timeout: timeout() });
  const data = (res.data && res.data.data) || {};
  const batch = data.batch || {};
  const msg = (data.messages || [])[0] || {};
  return { status: batchOutcome(batch), error: batch.error || msg.errorMessage || msg.error || null, checkedAt: new Date().toISOString() };
}

/** For the admin's SMS check: is the sending phone enabled and recently online, and may it send SMS? */
async function gatewayHealth(http = axios) {
  // Both lookups at once, 3 s each, so a slow TextBee cannot stall the admin's check.
  const quick = { headers: headers(), timeout: 3000 };
  const [devRes, permRes] = await Promise.allSettled([
    http.get(`${BASE_URL()}/gateway/devices`, quick),
    http.get(`${BASE_URL()}/gateway/sms-permission-status`, quick),
  ]);
  if (devRes.status === 'rejected') throw devRes.reason;
  const devices = (devRes.value.data && devRes.value.data.data) || [];
  const wanted = process.env.TEXTBEE_DEVICE_ID;
  const d = wanted ? devices.find((x) => x._id === wanted) : devices.find((x) => x.enabled);
  const p = permRes.status === 'fulfilled' ? permRes.value.data : null;
  const needsSmsPermission = p && p.data ? p.data.needsSmsPermission : null;
  return {
    devices: devices.length,
    device: d ? { model: d.model || d.brand || null, enabled: Boolean(d.enabled), lastSeenAt: d.lastHeartbeat || d.updatedAt || null, chosen: wanted ? 'TEXTBEE_DEVICE_ID' : 'first enabled phone' } : null,
    deviceIdProblem: wanted && !d ? 'TEXTBEE_DEVICE_ID does not match a phone on this TextBee account' : null,
    needsSmsPermission,
  };
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

module.exports = { sendViaTextbee, verifyWebhookSignature, isConfigured, SmsProviderError, batchStatus, batchOutcome, gatewayHealth, deviceId };

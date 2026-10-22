'use strict';

/**
 * Provider-neutral SMS sender with safety rules. Every SMS in the system goes through sendSms().
 *
 *   SMS_PROVIDER            textbee | none   (default: textbee if TEXTBEE_API_KEY is set, else none)
 *   SMS_DRY_RUN=true        log messages instead of sending (no credit used)
 *   SMS_RECIPIENT_ALLOWLIST comma-separated numbers that may receive REAL texts, e.g. +639171234567,09181234567.
 *                           Outside production this list is REQUIRED for live sending - every other number is
 *                           only simulated. This protects strangers: the demo data uses made-up numbers that
 *                           could belong to real people, and it protects your TextBee daily quota.
 *   SMS_DAILY_LIMIT         max real texts per day (enforced in smsWorker; default 40, TextBee free plan = 50/day)
 */
const logger = require('./lib/logger');
const textbee = require('./textbeeClient');

/** Philippine-friendly normalisation to E.164: 09171234567 -> +639171234567, 639171234567 -> +639171234567. */
function normalizePhone(raw) {
  let n = String(raw || '').replace(/[\s().-]/g, '');
  if (/^09\d{9}$/.test(n)) n = `+63${n.slice(1)}`;
  else if (/^639\d{9}$/.test(n)) n = `+${n}`;
  else if (/^9\d{9}$/.test(n)) n = `+63${n}`;
  return /^\+[1-9]\d{7,14}$/.test(n) ? n : null;
}

function provider() {
  const p = String(process.env.SMS_PROVIDER || '').trim().toLowerCase();
  if (p) return p;
  return textbee.isConfigured() ? 'textbee' : 'none';
}

function allowlist() {
  return new Set(String(process.env.SMS_RECIPIENT_ALLOWLIST || '').split(',').map((x) => normalizePhone(x)).filter(Boolean));
}

/** Current sending mode, also shown on the Admin View. */
function mode() {
  const p = provider();
  const list = allowlist();
  const production = process.env.NODE_ENV === 'production';
  if (process.env.SMS_DRY_RUN === 'true') return { provider: p, live: false, reason: 'SMS_DRY_RUN=true (messages are logged, not sent)', allowlistSize: list.size };
  if (p === 'none') return { provider: p, live: false, reason: 'No SMS provider configured', allowlistSize: list.size };
  if (p === 'textbee' && !textbee.isConfigured()) return { provider: p, live: false, reason: 'TEXTBEE_API_KEY is not set', allowlistSize: list.size };
  if (p !== 'textbee') return { provider: p, live: false, reason: `Unknown SMS_PROVIDER "${p}"`, allowlistSize: list.size };
  if (!production && list.size === 0) {
    return { provider: p, live: false, reason: 'SMS_RECIPIENT_ALLOWLIST is empty: add your own number(s) to send real texts in development', allowlistSize: 0 };
  }
  return { provider: p, live: true, reason: list.size ? `Live: only ${list.size} allow-listed number(s) receive real texts` : 'Live: all numbers', allowlistSize: list.size };
}

const simulated = (note) => ({ sid: `SIMULATED_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`, status: 'simulated', simulated: true, note });

/**
 * @returns {Promise<{sid:string, status:string, simulated?:boolean, note?:string, provider?:string, to:string}>}
 * @throws Error with .permanent=true when retrying cannot help
 */
async function sendSms({ to, body }) {
  const number = normalizePhone(to);
  if (!number) {
    const err = new Error(`Invalid phone number "${to}"`);
    err.permanent = true;
    throw err;
  }
  const text = String(body).slice(0, 640); // <= 4 concatenated segments
  const m = mode();
  if (!m.live) {
    logger.info('SMS simulated (not sent)', { reason: m.reason, chars: text.length });
    return { ...simulated(m.reason), to: number };
  }
  const list = allowlist();
  if (list.size && !list.has(number)) {
    logger.info('SMS simulated: recipient not on SMS_RECIPIENT_ALLOWLIST', { chars: text.length });
    return { ...simulated('Recipient is not on SMS_RECIPIENT_ALLOWLIST'), to: number };
  }
  const result = await textbee.sendViaTextbee({ to: number, body: text });
  return { ...result, to: number };
}

module.exports = { sendSms, mode, normalizePhone, provider, allowlist };

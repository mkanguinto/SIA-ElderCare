'use strict';

/**
 * Minimal structured (JSON-lines) logger.
 * Every service emits the same shape so logs can be aggregated into the
 * central log store behind the Admin View (Section 15 - Logging/Monitoring).
 */
const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };
const SERVICE = process.env.SERVICE_NAME || 'unknown-service';
const MIN = LEVELS[(process.env.LOG_LEVEL || 'info').toLowerCase()] || LEVELS.info;

// Keys that must never be written to logs (PHI / secrets).
const REDACT = new Set(['authorization', 'password', 'token', 'access_token', 'phone', 'to', 'recipientphone', 'phone_e164', 'apikey', 'appid']);

function redact(obj, depth = 0) {
  if (!obj || typeof obj !== 'object' || depth > 4) return obj;
  if (Array.isArray(obj)) return obj.map((v) => redact(v, depth + 1));
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    out[k] = REDACT.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

function write(level, msg, meta) {
  if (LEVELS[level] < MIN) return;
  const line = {
    ts: new Date().toISOString(),
    level,
    service: SERVICE,
    msg,
    ...(meta ? redact(meta instanceof Error ? { error: meta.message, stack: meta.stack } : meta) : {}),
  };
  const stream = level === 'error' || level === 'warn' ? process.stderr : process.stdout;
  stream.write(JSON.stringify(line) + '\n');
}

module.exports = {
  debug: (m, meta) => write('debug', m, meta),
  info: (m, meta) => write('info', m, meta),
  warn: (m, meta) => write('warn', m, meta),
  error: (m, meta) => write('error', m, meta),
};

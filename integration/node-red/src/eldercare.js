'use strict';

/**
 * Logic used by the Node-RED flows (flows.json), kept in a plain module so it is unit tested
 * (test/eldercare.test.js) and the flows stay thin. Exposed to function nodes as
 * global.get('eldercare') through functionGlobalContext in settings.js.
 *
 *   classifyTextbeeEvent()  content-based router for TextBee webhooks (EAI: Content-Based Router)
 *   summarizeWeatherRun()   aggregator for the per-location weather checks (EAI: Splitter + Aggregator)
 *   summarizeMessaging()    DLQ monitor: merges every service's queue / DLQ / outbox status
 *   validateReplay()        input check for the dashboard's replay button
 *   checkInternalToken(), checkBasicAuth()  constant-time credential checks
 */
const crypto = require('crypto');

/* ------------------------------------------------------------------ */
/* TextBee content-based router                                         */
/* ------------------------------------------------------------------ */
const DELIVERY_EVENTS = { MESSAGE_SENT: 'sent', MESSAGE_DELIVERED: 'delivered', MESSAGE_FAILED: 'failed' };

// Order matters: the first matching rule wins.
const SMS_ROUTES = [
  // SOS from a caregiver: alert the family at once (English / Filipino)
  { route: 'emergency', test: /^\s*(SOS|EMERGENCY|EMERGENCIA|SAKLOLO)\b/i },
  // Carrier-style opt-out / opt-in keywords
  { route: 'opt_out', test: /^\s*(STOP|UNSUBSCRIBE|OPT[\s-]?OUT|CANCEL|TIGIL)\s*$/i },
  { route: 'opt_in', test: /^\s*(START|SUBSCRIBE|OPT[\s-]?IN|UNSTOP)\s*$/i },
  { route: 'help', test: /^\s*(HELP|TULONG|INFO|\?)\s*$/i },
  // Check-in keyword, or a bare reading such as "BP 150/90 HR 80"
  { route: 'checkin', test: /^\s*(CHECKIN|CHECK-IN|CHECK IN|CI)\b|\bBP\s*\d{2,3}\s*\/\s*\d{2,3}\b/i },
];

/**
 * @param {object} payload  TextBee webhook body
 * @returns {{route:string, reason:string, sms?:object, status?:object}}
 *   route: delivery_status | checkin | emergency | opt_out | opt_in | help | unknown | ignored
 */
function classifyTextbeeEvent(payload) {
  const p = payload && typeof payload === 'object' ? payload : {};
  const event = String(p.webhookEvent || p.event || '');

  if (DELIVERY_EVENTS[event]) {
    const id = p.smsBatchId || p.smsId;
    if (!id) return { route: 'ignored', reason: `${event} without smsId` };
    return { route: 'delivery_status', reason: event, status: { id: String(id), status: DELIVERY_EVENTS[event], error: p.errorMessage || p.message || null } };
  }
  if (event !== 'MESSAGE_RECEIVED') return { route: 'ignored', reason: event ? `unhandled event ${event}` : 'no event type' };

  const from = typeof p.sender === 'string' ? p.sender.trim() : '';
  const body = typeof p.message === 'string' ? p.message.trim().slice(0, 1000) : '';
  if (!from) return { route: 'ignored', reason: 'MESSAGE_RECEIVED without sender' };
  const sms = { from, body, smsId: p.smsId ? String(p.smsId) : null, receivedAt: p.receivedAt || null };

  const hit = SMS_ROUTES.find((r) => r.test.test(body));
  return hit ? { route: hit.route, reason: hit.test.source, sms } : { route: 'unknown', reason: 'no keyword matched', sms };
}

/* ------------------------------------------------------------------ */
/* Weather orchestration: aggregate the per-location results            */
/* ------------------------------------------------------------------ */
/**
 * @param {Array<{zipCode:string, status:number, body:object}>} parts  one per location
 */
function summarizeWeatherRun(parts, startedAt = Date.now()) {
  const ok = parts.filter((p) => p.status === 200 && p.body && p.body.summary);
  const results = ok.flatMap((p) => p.body.results || []);
  const actions = results.flatMap((r) => r.actions || []);
  const notConfigured = parts.some((p) => p.status === 503);
  return {
    ranAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    status: notConfigured ? 'not_configured' : ok.length === parts.length ? 'ok' : ok.length ? 'partial' : 'failed',
    locations: parts.length,
    failed: parts.filter((p) => p.status !== 200).map((p) => ({ zipCode: p.zipCode, status: p.status, error: (p.body && (p.body.message || p.body.error)) || null })),
    heatAreas: results.filter((r) => r.heat && r.heat.triggered).map((r) => r.zipCode),
    stormAreas: results.filter((r) => r.storm && r.storm.triggered).map((r) => r.zipCode),
    rulesFired: [...new Set(results.flatMap((r) => (r.rules || []).filter((x) => x.triggered).map((x) => x.code)))],
    patientsWarned: actions.filter((a) => a.sms && !a.sms.suppressed).length,
    alreadyWarned: actions.filter((a) => a.sms && a.sms.suppressed).length,
    triageItemsCreated: actions.filter((a) => a.clinic && a.clinic.created).length,
    hottest: results.reduce((a, r) => (typeof r.heatIndexC === 'number' && (!a || r.heatIndexC > a.heatIndexC) ? { zipCode: r.zipCode, heatIndexC: r.heatIndexC } : a), null),
  };
}

/* ------------------------------------------------------------------ */
/* DLQ monitor                                                          */
/* ------------------------------------------------------------------ */
/**
 * @param {Array<{service:string, status:number, body:object}>} parts  GET /internal/messaging per service
 */
function summarizeMessaging(parts) {
  const services = parts.map((p) => {
    if (p.status !== 200 || !p.body) return { service: p.service, reachable: false, error: (p.body && p.body.error) || `HTTP ${p.status}` };
    const queues = (p.body.queues || []).map((q) => ({ queue: q.queue, messages: q.messages, consumers: q.consumers, dlq: String(q.queue).endsWith('.dlq') }));
    const b = p.body;
    return {
      service: p.service, reachable: true, mode: b.mode || null, connected: b.connected !== false, lastError: b.lastError || null,
      counters: { published: b.published || 0, consumed: b.consumed || 0, retried: b.retried || 0, deadLettered: b.deadLettered || 0 },
      queues, outbox: b.outbox || null,
    };
  });
  const deadLetters = services.flatMap((s) => (s.queues || []).filter((q) => q.dlq && q.messages > 0).map((q) => ({ service: s.service, queue: q.queue, messages: q.messages })));
  return {
    checkedAt: new Date().toISOString(),
    healthy: services.every((s) => s.reachable && s.connected) && deadLetters.length === 0,
    totalDeadLetters: deadLetters.reduce((n, q) => n + q.messages, 0),
    deadLetters,
    services,
  };
}

const REPLAY_SERVICES = ['checkin', 'alert', 'clinic'];
function validateReplay(body) {
  const b = body && typeof body === 'object' ? body : {};
  const errors = [];
  if (!REPLAY_SERVICES.includes(b.service)) errors.push(`service must be one of: ${REPLAY_SERVICES.join(', ')}`);
  // The services replay "<queue>.dlq" back into "<queue>": accept either name, send the work queue.
  const queue = typeof b.queue === 'string' ? b.queue.replace(/\.dlq$/, '') : '';
  if (!/^[a-z0-9._-]{3,120}$/.test(queue)) errors.push('queue must be a queue name such as alert-service.sms-dispatch');
  const limit = b.limit === undefined ? 50 : Number(b.limit);
  if (!Number.isInteger(limit) || limit < 1 || limit > 500) errors.push('limit must be an integer from 1 to 500');
  return { errors, value: { service: b.service, queue, limit } };
}

/* ------------------------------------------------------------------ */
/* Credentials                                                         */
/* ------------------------------------------------------------------ */
function safeEqual(a, b) {
  const ab = Buffer.from(String(a || ''));
  const bb = Buffer.from(String(b || ''));
  return ab.length === bb.length && crypto.timingSafeEqual(ab, bb);
}

function checkInternalToken(header, expected) {
  return Boolean(expected) && safeEqual(header, expected);
}

/** HTTP Basic auth for the DLQ dashboard. An unset password disables the dashboard (fail closed). */
function checkBasicAuth(header, user, password) {
  if (!user || !password) return false;
  const m = /^Basic\s+([A-Za-z0-9+/=]+)$/.exec(String(header || ''));
  if (!m) return false;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const i = decoded.indexOf(':');
  if (i < 0) return false;
  // Evaluate both comparisons so timing does not reveal which one failed.
  const okUser = safeEqual(decoded.slice(0, i), user);
  const okPass = safeEqual(decoded.slice(i + 1), password);
  return okUser && okPass;
}

module.exports = {
  classifyTextbeeEvent, summarizeWeatherRun, summarizeMessaging, validateReplay,
  checkInternalToken, checkBasicAuth, REPLAY_SERVICES,
};

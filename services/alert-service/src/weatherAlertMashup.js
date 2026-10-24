'use strict';

/**
 * Weather Alert Mashup (Section 11 - External API and Mashup Plan)
 *
 * Cross-references live OpenWeatherMap data with internal elderly health profiles:
 *
 *   1. fetchWeatherByZip()      OpenWeatherMap current weather for a zip code (+ optional One Call alerts)
 *   2. getWeatherForZip()       cache-aware wrapper: 1 h fresh cache, up to 24 h stale fallback on outage
 *   3. loadWeatherRules()       admin-managed thresholds (alert_rules: trigger_condition x vulnerability_target -> action)
 *      exceedsHeatThreshold()   heat index > threshold ? (CLI demo)
 *   4. sendHeatWarningSms()     -> notification.sms.requested events -> RabbitMQ -> TextBee SMS worker + in-app fallback
 *   5. createClinicTriageItem() -> weather.risk_detected event -> RabbitMQ -> Clinic Risk Queue Service
 *      (4 and 5 are written in ONE transaction through the outbox, so the family warning and the clinic
 *       triage signal either both happen or neither does)
 *   6. runMashupForZip() / runMashupForAllLocations() / startScheduler()
 *
 * All credentials are read from process.env - never hard-code them:
 *   OPENWEATHER_API_KEY, TEXTBEE_API_KEY, TEXTBEE_DEVICE_ID, AMQP_URL
 *
 * Quick CLI check (no database needed):
 *   node src/weatherAlertMashup.js --zip 1012 --country PH
 *   node src/weatherAlertMashup.js --zip 1012 --country PH --send-to +639171234567   (sends a real SMS if heat > 40 deg C)
 */
const logger = require('./lib/logger');
const { request } = require('./lib/resilientHttp');
const { internalHeaders } = require('./lib/internalAuth');
const { pool } = require('./db');
const events = require('./events');
const risk = require('./weatherRisk');
const rules = require('./alertRules');

const OWM_BASE = process.env.OPENWEATHER_BASE_URL || 'https://api.openweathermap.org';
const CACHE_TTL_MIN = Number(process.env.WEATHER_CACHE_TTL_MINUTES || 60); //   Risk 5: cache 1 hour
const STALE_MAX_HOURS = Number(process.env.WEATHER_STALE_MAX_HOURS || 24); // Risk 1: keep 1 day
const CHECKIN_URL = () => process.env.CHECKIN_SERVICE_URL || 'http://localhost:4001';

function apiKey() {
  const key = process.env.OPENWEATHER_API_KEY;
  if (!key) throw new Error('OPENWEATHER_API_KEY is not set');
  return key;
}

/* ------------------------------------------------------------------ */
/* 1. Query OpenWeatherMap for a specific zip code                     */
/* ------------------------------------------------------------------ */

/**
 * @param {string} zipCode       e.g. "1012"
 * @param {string} countryCode   ISO-3166 alpha-2, default "PH"
 * @param {{lat?:number, lon?:number}} [coords]  fallback if OWM has no record for the zip
 * @returns {Promise<object>}    internal risk profile (see weatherRisk.toRiskProfile)
 */
async function fetchWeatherByZip(zipCode, countryCode = 'PH', coords = {}) {
  const common = { appid: apiKey(), units: 'metric' };
  let owm;
  try {
    const res = await request('openweathermap', {
      method: 'GET',
      url: `${OWM_BASE}/data/2.5/weather`,
      params: { ...common, zip: `${zipCode},${countryCode}` },
    }, { retries: 2, timeoutMs: 5000 });
    owm = res.data;
  } catch (err) {
    // OWM's zip database is incomplete for some countries; fall back to the patients' coordinates.
    const notFound = err.response && err.response.status === 404;
    if (!notFound || coords.lat === undefined || coords.lat === null) throw err;
    logger.info('zip not found in OpenWeatherMap, using coordinates', { zipCode });
    const res = await request('openweathermap', {
      method: 'GET', url: `${OWM_BASE}/data/2.5/weather`, params: { ...common, lat: coords.lat, lon: coords.lon },
    }, { retries: 2, timeoutMs: 5000 });
    owm = res.data;
  }

  // Optional: government weather advisories (typhoon, storm) via One Call 3.0 (separate subscription).
  let alerts = [];
  if (process.env.OPENWEATHER_ONECALL_ENABLED === 'true' && owm.coord) {
    try {
      const res = await request('openweathermap-onecall', {
        method: 'GET',
        url: `${OWM_BASE}/data/3.0/onecall`,
        params: { ...common, lat: owm.coord.lat, lon: owm.coord.lon, exclude: 'minutely,hourly,daily' },
      }, { retries: 1, timeoutMs: 5000 });
      alerts = res.data.alerts || [];
    } catch (err) {
      logger.warn('One Call alerts unavailable, continuing with current conditions only', { zipCode, error: err.message });
    }
  }

  return risk.toRiskProfile(owm, { zipCode, countryCode, alerts });
}

/**
 * Current weather at a point (the caregiver's phone location), for the check-in screen.
 * Cached in memory per ~1 km grid cell for CACHE_TTL_MIN so a busy barangay makes one OWM call.
 */
const pointCache = new Map();
async function getWeatherAtPoint(lat, lon) {
  const key = `${lat.toFixed(2)},${lon.toFixed(2)}`;
  const hit = pointCache.get(key);
  if (hit && Date.now() - hit.at < CACHE_TTL_MIN * 60000) return { ...hit.profile, cache: 'fresh' };
  const res = await request('openweathermap', {
    method: 'GET', url: `${OWM_BASE}/data/2.5/weather`, params: { appid: apiKey(), units: 'metric', lat, lon },
  }, { retries: 1, timeoutMs: 5000 });
  const profile = risk.toRiskProfile(res.data, {});
  if (pointCache.size > 500) pointCache.clear();
  pointCache.set(key, { at: Date.now(), profile });
  return { ...profile, cache: 'miss' };
}

/* ------------------------------------------------------------------ */
/* 2. Cache-aware lookup with stale fallback                           */
/* ------------------------------------------------------------------ */
async function getWeatherForZip(zipCode, countryCode = 'PH', coords = {}) {
  // eslint-disable-next-line global-require
  const { pool } = require('./db');
  const { rows: [cached] } = await pool.query(
    `SELECT payload, fetched_at, extract(epoch FROM now() - fetched_at)::int AS age_sec
       FROM weather_cache WHERE zip_code = $1 AND country_code = $2`,
    [zipCode, countryCode],
  );
  if (cached && cached.age_sec < CACHE_TTL_MIN * 60) return { ...cached.payload, cache: 'fresh', fetchedAt: cached.fetched_at };

  try {
    const profile = await fetchWeatherByZip(zipCode, countryCode, coords);
    await pool.query(
      `INSERT INTO weather_cache (zip_code, country_code, payload, fetched_at) VALUES ($1, $2, $3, now())
       ON CONFLICT (zip_code, country_code) DO UPDATE SET payload = EXCLUDED.payload, fetched_at = now()`,
      [zipCode, countryCode, profile],
    );
    return { ...profile, cache: 'miss', fetchedAt: new Date().toISOString() };
  } catch (err) {
    logger.error('OpenWeatherMap unreachable', { zipCode, error: err.message, code: err.code });
    if (cached && cached.age_sec < STALE_MAX_HOURS * 3600) {
      logger.warn('using stale cached weather data', { zipCode, ageMinutes: Math.round(cached.age_sec / 60) });
      return { ...cached.payload, cache: 'stale', fetchedAt: cached.fetched_at };
    }
    throw err;
  }
}

/* ------------------------------------------------------------------ */
/* 3. Thresholds: admin-managed alert rules                             */
/* ------------------------------------------------------------------ */
/** Enabled weather rules, most severe first (so the first match per hazard is the one that fires). */
async function loadWeatherRules() {
  const { rows } = await pool.query(
    `SELECT * FROM alert_rules WHERE enabled AND hazard IS NOT NULL AND trigger_condition IS NOT NULL ORDER BY code`,
  );
  const rank = (r) => ['low', 'moderate', 'high', 'critical'].indexOf((r.action && r.action.severity) || 'high');
  return rows.sort((a, b) => rank(b) - rank(a));
}

const ALERT_TYPE_BY_HAZARD = { heat: 'HEATWAVE_DEHYDRATION_WARNING', storm: 'TYPHOON_MOBILITY_WARNING' };

function exceedsHeatThreshold(profile, thresholdC = risk.HEAT_INDEX_THRESHOLD_C) {
  return typeof profile.heatIndexC === 'number' && profile.heatIndexC > thresholdC;
}

/* ------------------------------------------------------------------ */
/* 4. SMS warnings (TextBee via RabbitMQ)                               */
/* ------------------------------------------------------------------ */
function heatMessage(patient, profile) {
  return `HEAT WARNING for ${patient.fullName}: heat index ${profile.heatIndexC}C in ${profile.locationName || patient.zipCode}. `
    + 'Keep them indoors in a cool place, give water every hour, watch for dizziness, confusion or chest pain. '
    + 'Call your health center or 911 if symptoms appear.';
}

function stormMessage(patient, reasons) {
  return `STORM ALERT for ${patient.fullName}: ${reasons.join(', ')}. Limited mobility: prepare evacuation help, `
    + 'medicines for 3+ days, charged phone and flashlight. Follow barangay advisories; call 911 in an emergency.';
}

/**
 * Dispatches the dehydration / heat warning to the patient's caregivers and family.
 * notifier.dispatchAlert() writes the in-app alert and one notification.sms.requested outbox event per
 * subscriber; the RabbitMQ SMS worker calls smsSender.sendSms() -> TextBee (your Android phone).
 */
/** At most one warning per patient per rule per cooldown window (action.cooldown_hours). */
function dedupeKeyFor(rule, patient) {
  const hours = (rule.action && rule.action.cooldown_hours) || 24;
  return `weather:${rule.code}:${patient.id}:${Math.floor(Date.now() / (hours * 3600 * 1000))}`;
}

async function sendHeatWarningSms(patient, profile, client, rule) {
  // eslint-disable-next-line global-require
  const { dispatchAlert } = require('./notifier');
  return dispatchAlert({
    patientId: patient.id,
    source: 'weather',
    ruleCode: rule.code,
    alertType: ALERT_TYPE_BY_HAZARD.heat,
    severity: (rule.action && rule.action.severity) || 'high',
    title: `Heat index ${profile.heatIndexC}C`,
    message: heatMessage(patient, profile),
    metadata: { hazard: 'heat', rule: rule.code, heatIndexC: profile.heatIndexC, zipCode: patient.zipCode, observedAt: profile.observedAt, cache: profile.cache },
    dedupeKey: dedupeKeyFor(rule, patient),
  }, client);
}

async function sendStormWarningSms(patient, profile, reasons, client, rule) {
  // eslint-disable-next-line global-require
  const { dispatchAlert } = require('./notifier');
  return dispatchAlert({
    patientId: patient.id,
    source: 'weather',
    ruleCode: rule.code,
    alertType: ALERT_TYPE_BY_HAZARD.storm,
    severity: (rule.action && rule.action.severity) || 'high',
    title: 'Severe weather advisory',
    message: stormMessage(patient, reasons),
    metadata: { hazard: 'storm', rule: rule.code, reasons, windMs: profile.windMs, zipCode: patient.zipCode, observedAt: profile.observedAt },
    dedupeKey: dedupeKeyFor(rule, patient),
  }, client);
}

/* ------------------------------------------------------------------ */
/* 5. Preventive triage item in the Clinic Risk Queue                   */
/* ------------------------------------------------------------------ */
/** Writes weather.risk_detected to the outbox using the caller's transaction client. */
async function createClinicTriageItem(patient, hazard, profile, details, client) {
  const event = await events.outbox.enqueue(client, 'weather.risk_detected', {
    patient: { id: patient.id, fullName: patient.fullName, zipCode: patient.zipCode, conditions: patient.conditions, mobilityRestricted: patient.mobilityRestricted, assignedClinic: patient.assignedClinic },
    environment: { hazard, heatIndexC: profile.heatIndexC, windMs: profile.windMs, level: details.level || null, reasons: details.reasons || [], observedAt: profile.observedAt, ruleCode: details.ruleCode || null },
  });
  return { queued: true, created: true, eventId: event.eventId };
}

/** SMS warning + clinic triage signal in one local transaction (outbox), then publish. */
async function warnPatient(patient, rule, profile, details) {
  const hazard = rule.hazard;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sms = hazard === 'heat'
      ? await sendHeatWarningSms(patient, profile, client, rule)
      : await sendStormWarningSms(patient, profile, details.reasons, client, rule);
    const wantsClinic = !rule.action || rule.action.create_clinic_item !== false;
    const clinic = sms.suppressed || !wantsClinic
      ? { skipped: true }
      : await createClinicTriageItem(patient, hazard, profile, { ...details, ruleCode: rule.code }, client);
    await client.query('COMMIT');
    events.outbox.kick();
    return { patientId: patient.id, hazard, rule: rule.code, sms, clinic };
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

/* ------------------------------------------------------------------ */
/* 6. Orchestration                                                     */
/* ------------------------------------------------------------------ */
async function getPatientsInZip(zipCode) {
  const res = await request('checkin-service', {
    method: 'GET', url: `${CHECKIN_URL()}/internal/patients`, params: { zip: zipCode }, headers: internalHeaders(),
  }, { retries: 2, timeoutMs: 4000 });
  return res.data.patients || [];
}

/**
 * Runs the full mashup for one location.
 * @param {{zipCode:string, countryCode?:string, lat?:number, lon?:number}} location
 */
async function runMashupForZip(location, weatherRules) {
  const { zipCode, countryCode = 'PH', lat, lon } = location;
  const profile = await getWeatherForZip(zipCode, countryCode, { lat, lon });
  const ruleSet = weatherRules || await loadWeatherRules();
  const evaluated = ruleSet.map((rule) => ({ rule, ...rules.evaluateRule(rule, profile) }));
  const fired = evaluated.filter((e) => e.triggered);
  const hazardSummary = (hazard) => {
    const hit = fired.find((e) => e.rule.hazard === hazard);
    const first = evaluated.find((e) => e.rule.hazard === hazard);
    return hazard === 'heat'
      ? { triggered: Boolean(hit), heatIndexC: profile.heatIndexC, thresholdC: first ? first.rule.trigger_condition.value : null, level: profile.heatIndexC !== null ? risk.heatLevel(profile.heatIndexC) : null, rule: hit ? hit.rule.code : null }
      : { triggered: Boolean(hit), reasons: hit ? hit.reasons : [], rule: hit ? hit.rule.code : null };
  };
  const summary = {
    zipCode, locationName: profile.locationName, temperatureC: profile.temperatureC, humidity: profile.humidity, heatIndexC: profile.heatIndexC, windMs: profile.windMs, cache: profile.cache,
    heat: hazardSummary('heat'),
    storm: hazardSummary('storm'),
    rules: evaluated.map((e) => ({ code: e.rule.code, hazard: e.rule.hazard, triggered: e.triggered, value: e.value, reasons: e.reasons })),
    actions: [],
  };
  if (!fired.length) return summary;

  const patients = await getPatientsInZip(zipCode);
  for (const patient of patients) {
    // Rules are sorted most severe first: per hazard, only the most severe matching rule warns the patient.
    const warned = new Set();
    for (const e of fired) {
      if (warned.has(e.rule.hazard) || !rules.matchesTarget(e.rule, patient)) continue;
      warned.add(e.rule.hazard);
      const details = e.rule.hazard === 'heat' ? { level: summary.heat.level, reasons: e.reasons } : { reasons: e.reasons };
      summary.actions.push(await warnPatient(patient, e.rule, profile, details));
    }
  }
  logger.info('weather mashup run', { zipCode, heatIndexC: profile.heatIndexC, rulesFired: fired.map((e) => e.rule.code), actions: summary.actions.length });
  return summary;
}

async function runMashupForAllLocations() {
  const res = await request('checkin-service', { method: 'GET', url: `${CHECKIN_URL()}/internal/locations`, headers: internalHeaders() }, { retries: 2 });
  const weatherRules = await loadWeatherRules(); // one read per run, shared by every location
  const results = [];
  for (const loc of res.data.locations || []) {
    try {
      results.push(await runMashupForZip(loc, weatherRules));
    } catch (err) {
      logger.error('mashup failed for location', { zipCode: loc.zipCode, error: err.message });
      results.push({ zipCode: loc.zipCode, error: err.message });
    }
  }
  return results;
}

function startScheduler() {
  if (!process.env.OPENWEATHER_API_KEY || process.env.WEATHER_POLL_ENABLED === 'false') {
    logger.warn('weather polling disabled (no OPENWEATHER_API_KEY or WEATHER_POLL_ENABLED=false)');
    return null;
  }
  const minutes = Number(process.env.WEATHER_POLL_INTERVAL_MINUTES || 30);
  const tick = () => runMashupForAllLocations().catch((err) => logger.error('weather scheduler run failed', err));
  setTimeout(tick, 10000).unref(); // first run shortly after start-up
  const timer = setInterval(tick, minutes * 60000);
  timer.unref();
  logger.info('weather polling scheduled', { everyMinutes: minutes });
  return timer;
}

module.exports = {
  fetchWeatherByZip,
  getWeatherForZip,
  getWeatherAtPoint,
  loadWeatherRules,
  exceedsHeatThreshold,
  sendHeatWarningSms,
  sendStormWarningSms,
  createClinicTriageItem,
  warnPatient,
  runMashupForZip,
  runMashupForAllLocations,
  startScheduler,
};

/* ------------------------------ CLI demo ------------------------------ */
if (require.main === module) {
  require('dotenv').config();
  const args = process.argv.slice(2);
  const arg = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
  const zip = arg('zip');
  if (!zip) {
    console.error('Usage: node src/weatherAlertMashup.js --zip <zip> [--country PH] [--send-to +639XXXXXXXXX] [--threshold 40]');
    process.exit(1);
  }
  (async () => {
    const profile = await fetchWeatherByZip(zip, arg('country', 'PH'));
    const threshold = Number(arg('threshold', risk.HEAT_INDEX_THRESHOLD_C));
    const exceeded = exceedsHeatThreshold(profile, threshold);
    console.log(JSON.stringify({ profile, threshold, exceeded, assessment: risk.evaluateWeatherRisk(profile, { heatThresholdC: threshold }) }, null, 2));
    const to = arg('send-to');
    if (exceeded && to) {
      // eslint-disable-next-line global-require
      const { sendSms } = require('./smsSender');
      const result = await sendSms({ to, body: `[ElderCare Connect] ${heatMessage({ fullName: 'your elderly family member', zipCode: zip }, profile)}` });
      console.log('SMS result:', result);
    } else if (to) {
      console.log(`Heat index ${profile.heatIndexC}C is not above ${threshold}C - no SMS sent.`);
    }
  })().catch((err) => { console.error(err.response ? err.response.data : err.message); process.exit(1); });
}

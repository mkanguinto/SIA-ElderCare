'use strict';

/**
 * Weather Alert Mashup (Section 11 - External API and Mashup Plan)
 *
 * Cross-references live OpenWeatherMap data with internal elderly health profiles:
 *
 *   1. fetchWeatherByZip()      OpenWeatherMap current weather for a zip code (+ optional One Call alerts)
 *   2. getWeatherForZip()       cache-aware wrapper: 1 h fresh cache, up to 24 h stale fallback on outage
 *   3. exceedsHeatThreshold()   heat index > 40 deg C ?
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
/* 3. Threshold check                                                   */
/* ------------------------------------------------------------------ */
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
async function sendHeatWarningSms(patient, profile, client) {
  // eslint-disable-next-line global-require
  const { dispatchAlert } = require('./notifier');
  return dispatchAlert({
    patientId: patient.id,
    source: 'weather',
    ruleCode: 'WEATHER_HEAT',
    severity: profile.heatIndexC >= 52 ? 'critical' : 'high',
    title: `Heat index ${profile.heatIndexC}C`,
    message: heatMessage(patient, profile),
    metadata: { hazard: 'heat', heatIndexC: profile.heatIndexC, zipCode: patient.zipCode, observedAt: profile.observedAt, cache: profile.cache },
    dedupeKey: `heat:${patient.id}:${new Date().toISOString().slice(0, 10)}`, // at most once per patient per day
  }, client);
}

async function sendStormWarningSms(patient, profile, reasons, client) {
  // eslint-disable-next-line global-require
  const { dispatchAlert } = require('./notifier');
  return dispatchAlert({
    patientId: patient.id,
    source: 'weather',
    ruleCode: 'WEATHER_STORM',
    severity: 'high',
    title: 'Severe weather advisory',
    message: stormMessage(patient, reasons),
    metadata: { hazard: 'storm', reasons, windMs: profile.windMs, zipCode: patient.zipCode, observedAt: profile.observedAt },
    dedupeKey: `storm:${patient.id}:${Math.floor(Date.now() / (6 * 3600 * 1000))}`, // at most once per patient per 6-hour window
  }, client);
}

/* ------------------------------------------------------------------ */
/* 5. Preventive triage item in the Clinic Risk Queue                   */
/* ------------------------------------------------------------------ */
/** Writes weather.risk_detected to the outbox using the caller's transaction client. */
async function createClinicTriageItem(patient, hazard, profile, details, client) {
  const event = await events.outbox.enqueue(client, 'weather.risk_detected', {
    patient: { id: patient.id, fullName: patient.fullName, zipCode: patient.zipCode, conditions: patient.conditions, mobilityRestricted: patient.mobilityRestricted, assignedClinic: patient.assignedClinic },
    environment: { hazard, heatIndexC: profile.heatIndexC, windMs: profile.windMs, level: details.level || null, reasons: details.reasons || [], observedAt: profile.observedAt },
  });
  return { queued: true, created: true, eventId: event.eventId };
}

/** SMS warning + clinic triage signal in one local transaction (outbox), then publish. */
async function warnPatient(patient, hazard, profile, details) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const sms = hazard === 'heat'
      ? await sendHeatWarningSms(patient, profile, client)
      : await sendStormWarningSms(patient, profile, details.reasons, client);
    const clinic = sms.suppressed ? { skipped: true } : await createClinicTriageItem(patient, hazard, profile, details, client);
    await client.query('COMMIT');
    events.outbox.kick();
    return { patientId: patient.id, hazard, sms, clinic };
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
async function runMashupForZip(location) {
  const { zipCode, countryCode = 'PH', lat, lon } = location;
  const profile = await getWeatherForZip(zipCode, countryCode, { lat, lon });
  const assessment = risk.evaluateWeatherRisk(profile);
  const summary = { zipCode, locationName: profile.locationName, temperatureC: profile.temperatureC, humidity: profile.humidity, heatIndexC: profile.heatIndexC, windMs: profile.windMs, cache: profile.cache, heat: assessment.heat, storm: assessment.storm, actions: [] };

  if (!assessment.heat.triggered && !assessment.storm.triggered) return summary;

  const patients = await getPatientsInZip(zipCode);
  for (const patient of patients) {
    if (assessment.heat.triggered && risk.isHeatVulnerable(patient)) summary.actions.push(await warnPatient(patient, 'heat', profile, assessment.heat));
    if (assessment.storm.triggered && risk.isStormVulnerable(patient)) summary.actions.push(await warnPatient(patient, 'storm', profile, assessment.storm));
  }
  logger.info('weather mashup run', { zipCode, heatIndexC: profile.heatIndexC, heat: assessment.heat.triggered, storm: assessment.storm.triggered, actions: summary.actions.length });
  return summary;
}

async function runMashupForAllLocations() {
  const res = await request('checkin-service', { method: 'GET', url: `${CHECKIN_URL()}/internal/locations`, headers: internalHeaders() }, { retries: 2 });
  const results = [];
  for (const loc of res.data.locations || []) {
    try {
      results.push(await runMashupForZip(loc));
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

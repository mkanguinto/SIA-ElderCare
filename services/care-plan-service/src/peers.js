'use strict';

/**
 * Calls to peer services on behalf of the signed-in user. The user's identity (already validated by the
 * gateway) is passed on, so each peer applies its own permission checks as well.
 *
 *   careOf(req, patientId)         clinic service: the elder's care team, members and case nurse (nurses only)
 *   medicationsOf(req, patientId)  check-in service: the elder's prescription records
 */
const { request } = require('./lib/resilientHttp');
const { internalHeaders } = require('./lib/internalAuth');

const CLINIC_URL = () => process.env.CLINIC_SERVICE_URL || 'http://clinic-risk-service:4003';
const CHECKIN_URL = () => process.env.CHECKIN_SERVICE_URL || 'http://checkin-service:4001';

function asUser(req) {
  const u = req.user || {};
  return {
    ...internalHeaders(req.get ? req.get('x-request-id') : undefined),
    'X-User-Id': u.id || '',
    'X-User-Name': encodeURIComponent(u.name || ''),
    'X-User-Role': u.role || '',
    'X-User-Patients': (u.patients || []).join(','),
  };
}

/** @returns {Promise<object|null>} the care record, or null when the elder has no care team yet */
async function careOf(req, patientId) {
  try {
    const r = await request('clinic-risk-service', { method: 'GET', url: `${CLINIC_URL()}/api/clinic/patients/${encodeURIComponent(patientId)}/care`, headers: asUser(req) }, { retries: 1, timeoutMs: 4000 });
    return r.data;
  } catch (err) {
    if (err.response && err.response.status === 404) return null;
    throw Object.assign(new Error('The clinic service could not be reached to check the care team'), { status: 503 });
  }
}

/** @returns {Promise<object[]>} prescription records (active and ended) */
async function medicationsOf(req, patientId) {
  try {
    const r = await request('checkin-service', { method: 'GET', url: `${CHECKIN_URL()}/api/patients/${encodeURIComponent(patientId)}/medications?includeInactive=true`, headers: asUser(req) }, { retries: 1, timeoutMs: 4000 });
    return r.data.medications || [];
  } catch (err) {
    if (err.response && err.response.status === 404) return [];
    throw Object.assign(new Error('The prescription records could not be reached'), { status: 503 });
  }
}

module.exports = { careOf, medicationsOf };

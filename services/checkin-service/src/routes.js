'use strict';

const express = require('express');
const { pool, withTransaction } = require('./db');
const { validateCheckin } = require('./validation');
const { detectAnomalies } = require('./anomaly');
const outbox = require('./outbox');
const logger = require('./lib/logger');
const { requireInternalToken } = require('./lib/internalAuth');
const { validatePatient, validateMedication } = require('./patientValidation');
const { parsePagination, pageInfo } = require('./lib/pagination');

const router = express.Router();
router.use(requireInternalToken);

const PATIENT_SCOPED = ['caregiver', 'family_member'];

function toPatientDto(r) {
  return {
    id: r.id,
    fullName: r.full_name,
    birthDate: r.birth_date,
    zipCode: r.zip_code,
    countryCode: r.country_code,
    coordinates: r.latitude !== null ? { lat: Number(r.latitude), lon: Number(r.longitude) } : null,
    conditions: r.conditions,
    mobilityRestricted: r.mobility_restricted,
    baseline: r.baseline,
    assignedClinic: r.assigned_clinic,
    sex: r.sex || null,
    addressLine: r.address_line || null,
    emergencyContact: r.emergency_contact && Object.keys(r.emergency_contact).length ? r.emergency_contact : null,
    notes: r.notes || null,
    createdAt: r.created_at,
  };
}

function toMedicationDto(r) {
  return {
    id: r.id,
    patientId: r.patient_id,
    name: r.name,
    dosage: r.dosage,
    frequency: r.frequency,
    times: r.times,
    instructions: r.instructions,
    prescribedBy: r.prescribed_by,
    startDate: r.start_date,
    endDate: r.end_date,
    active: r.active,
    updatedAt: r.updated_at,
  };
}

const CLINIC_ROLES = ['clinic_staff', 'system_admin'];
function requireRole(req, res, roles) {
  if (!req.user || !roles.includes(req.user.role)) {
    res.status(403).json({ error: 'forbidden', message: 'Your role cannot perform this action' });
    return false;
  }
  return true;
}

function toCheckinDto(r) {
  return {
    id: r.id,
    patientId: r.patient_id,
    caregiverId: r.caregiver_id,
    recordedAt: r.recorded_at,
    vitals: {
      systolic: r.systolic, diastolic: r.diastolic, heartRate: r.heart_rate,
      temperatureC: r.temperature_c === null ? null : Number(r.temperature_c), spo2: r.spo2, bloodGlucose: r.blood_glucose,
    },
    medication: { taken: r.medication_taken, missed: r.missed_medications },
    mobilityStatus: r.mobility_status,
    mood: r.mood,
    environment: r.environment || null,
    measurementDevice: r.measurement_device || null,
    status: r.status || 'received',
    review: r.reviewed_at ? { byId: r.reviewed_by_nurse, byName: r.reviewed_by_name, at: r.reviewed_at, note: r.review_note } : null,
    action: r.action_at ? { text: r.action_taken, byId: r.action_by, byName: r.action_by_name, at: r.action_at } : null,
    notes: r.notes,
    anomalies: r.anomalies,
    severity: r.severity,
    severityScore: r.severity_score,
    createdAt: r.created_at,
  };
}

/** Defense in depth: re-check the gateway's patient scoping. */
function assertPatientScope(req, res, patientId) {
  if (req.user && PATIENT_SCOPED.includes(req.user.role) && !req.user.patients.includes(patientId)) {
    res.status(403).json({ error: 'forbidden', message: 'You are not assigned to this patient' });
    return false;
  }
  return true;
}

/**
 * Validates, scores and stores one check-in, and enqueues the saga event when anomalous.
 * Shared by the app/web route and the SMS check-in fallback.
 * @param {string} caregiverId
 * @param {string[]|null} allowedPatients  caregiver's assigned patients (null = already verified upstream)
 * @returns {Promise<{status:number, body:object}>}
 */
async function createCheckin(caregiverId, allowedPatients, input, requestId, { caregiverName, viaSms = false } = {}) {
  const result = validateCheckin(input);
  if (!result.ok) return { status: 422, body: { error: 'validation_failed', details: result.errors } };
  const c = result.value;
  if (allowedPatients && !allowedPatients.includes(c.patientId)) {
    return { status: 403, body: { error: 'forbidden', message: 'You are not assigned to this patient' } };
  }

  // Offline-sync replay: return the already-stored check-in instead of duplicating it.
  if (c.idempotencyKey) {
    const dup = await pool.query('SELECT * FROM checkins WHERE caregiver_id = $1 AND idempotency_key = $2', [caregiverId, c.idempotencyKey]);
    if (dup.rows.length) return { status: 200, body: { checkin: toCheckinDto(dup.rows[0]), duplicate: true } };
  }

  const { rows: pr } = await pool.query('SELECT * FROM patients WHERE id = $1', [c.patientId]);
  if (!pr.length) return { status: 404, body: { error: 'not_found', message: 'Patient not found' } };
  const patient = toPatientDto(pr[0]);

  const detection = detectAnomalies(c, patient.baseline);

  const saved = await withTransaction(async (client) => {
    const { rows } = await client.query(
      `INSERT INTO checkins (patient_id, caregiver_id, idempotency_key, recorded_at, systolic, diastolic, heart_rate,
                             temperature_c, spo2, blood_glucose, medication_taken, missed_medications, mobility_status,
                             mood, notes, anomalies, severity, severity_score, environment, measurement_device)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16,$17,$18,$19,$20) RETURNING *`,
      [c.patientId, caregiverId, c.idempotencyKey, c.recordedAt, c.vitals.systolic, c.vitals.diastolic, c.vitals.heartRate,
        c.vitals.temperatureC, c.vitals.spo2, c.vitals.bloodGlucose, c.medication.taken, c.medication.missed, c.mobilityStatus,
        c.mood, c.notes, JSON.stringify(detection.anomalies), detection.severity, detection.severityScore,
        c.environment ? JSON.stringify(c.environment) : null, c.measurementDevice ? JSON.stringify(c.measurementDevice) : null],
    );
    await client.query(`INSERT INTO checkin_status_log (checkin_id, status, changed_by, changed_by_name, note) VALUES ($1, 'received', $2, $3, $4)`,
      [rows[0].id, caregiverId, caregiverName || null, viaSms ? 'received by SMS' : null]);
    const checkin = toCheckinDto(rows[0]);
    let event = null;
    const patientRef = { id: patient.id, fullName: patient.fullName, zipCode: patient.zipCode, conditions: patient.conditions, mobilityRestricted: patient.mobilityRestricted, assignedClinic: patient.assignedClinic };
    if (!detection.anomalies.length) {
      // Normal reading: notify only the Clinic Risk Queue so an open case is de-escalated
      // (e.g. Urgent -> Routine). Families are not alerted for normal readings.
      event = await outbox.enqueueEvent(client, 'checkin.normal', {
        patient: patientRef,
        checkin: { id: checkin.id, recordedAt: checkin.recordedAt, vitals: checkin.vitals, caregiverId: checkin.caregiverId },
        anomalies: [],
        severity: 'none',
        severityScore: 0,
      }, ['clinic']);
    } else {
      event = await outbox.enqueueEvent(client, 'checkin.anomaly_detected', {
        patient: patientRef,
        checkin: { id: checkin.id, recordedAt: checkin.recordedAt, vitals: checkin.vitals, caregiverId: checkin.caregiverId },
        anomalies: detection.anomalies,
        severity: detection.severity,
        severityScore: detection.severityScore,
      });
    }
    return { checkin, event, anomalous: detection.anomalies.length > 0 };
  });

  // Kick the dispatcher now instead of waiting for the next poll (keeps end-to-end < 2 s).
  if (saved.event) setImmediate(() => outbox.flush().catch((e) => logger.error('outbox flush', e)));

  logger.info('checkin stored', { requestId, checkinId: saved.checkin.id, patientId: c.patientId, severity: detection.severity });
  return { status: 201, body: { checkin: saved.checkin, eventId: saved.anomalous ? saved.event.eventId : null } };
}

/* ---------------------------- POST /api/checkins ---------------------------- */
router.post('/api/checkins', async (req, res, next) => {
  try {
    if (!req.user || req.user.role !== 'caregiver') {
      return res.status(403).json({ error: 'forbidden', message: 'Only caregivers can submit check-ins' });
    }
    const r = await createCheckin(req.user.id, req.user.patients, req.body, req.get('x-request-id'), { caregiverName: req.user.name });
    return res.status(r.status).json(r.body);
  } catch (err) {
    return next(err);
  }
});

/* ------------------------- POST /internal/checkins -------------------------- */
// SMS check-in fallback (Risk 3): the alert service has already matched the sender's phone
// number to a registered caregiver and the patients they care for.
router.post('/internal/checkins', async (req, res, next) => {
  try {
    const { caregiverId, allowedPatients, checkin } = req.body || {};
    if (!caregiverId || !Array.isArray(allowedPatients) || !allowedPatients.length || !checkin) {
      return res.status(400).json({ error: 'bad_request', message: 'caregiverId, allowedPatients[] and checkin are required' });
    }
    const r = await createCheckin(String(caregiverId), allowedPatients.map(String), checkin, req.get('x-request-id'), { viaSms: true });
    return res.status(r.status).json(r.body);
  } catch (err) {
    return next(err);
  }
});

/* ------------------------- Patients: list + onboarding ------------------------- */

// GET /api/patients?search=&page=&pageSize=   (clinic staff / admin; RBAC at the gateway, re-checked here)
router.get('/api/patients', async (req, res, next) => {
  try {
    if (!requireRole(req, res, CLINIC_ROLES)) return undefined;
    const pg = parsePagination(req.query, { defaultPageSize: 100, maxPageSize: 500 });
    if (pg.errors.length) return res.status(422).json({ error: 'validation_failed', details: pg.errors });
    const search = String(req.query.search || '').trim().slice(0, 60);
    const params = [];
    let where = '';
    if (search) {
      params.push(`%${search.toLowerCase()}%`);
      where = `WHERE lower(p.full_name) LIKE $1 OR lower(p.id) LIKE $1 OR p.zip_code LIKE $1`;
    }
    const [{ rows }, { rows: [{ total }] }] = await Promise.all([
      pool.query(
        `SELECT p.*, c.last_checkin_at, c.last_severity
           FROM patients p
           LEFT JOIN LATERAL (SELECT recorded_at AS last_checkin_at, severity AS last_severity
                                FROM checkins WHERE patient_id = p.id ORDER BY recorded_at DESC LIMIT 1) c ON TRUE
           ${where}
          ORDER BY p.created_at DESC, p.id LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
        [...params, pg.pageSize, pg.offset],
      ),
      pool.query(`SELECT count(*)::int AS total FROM patients p ${where}`, params),
    ]);
    return res.json({
      patients: rows.map((r) => ({ ...toPatientDto(r), lastCheckinAt: r.last_checkin_at, lastSeverity: r.last_severity })),
      pagination: pageInfo(pg, total),
    });
  } catch (err) {
    return next(err);
  }
});

// POST /api/patients   (clinic staff / admin) - onboard a new patient, optionally with prescriptions
router.post('/api/patients', async (req, res, next) => {
  try {
    if (!requireRole(req, res, CLINIC_ROLES)) return undefined;
    const result = validatePatient(req.body);
    if (!result.ok) return res.status(422).json({ error: 'validation_failed', details: result.errors });
    const p = result.value;

    const created = await withTransaction(async (client) => {
      // Duplicate guard: same name + birth date already registered
      const { rows: dup } = await client.query('SELECT id FROM patients WHERE lower(full_name) = lower($1) AND birth_date = $2', [p.fullName, p.birthDate]);
      if (dup.length) return { duplicateOf: dup[0].id };

      let row;
      for (let attempt = 0; attempt < 5 && !row; attempt += 1) {
        const { rows: [{ n }] } = await client.query(`SELECT nextval('patient_id_seq')::int AS n`);
        const { rows } = await client.query(
          `INSERT INTO patients (id, full_name, birth_date, sex, address_line, zip_code, country_code, latitude, longitude,
                                 conditions, mobility_restricted, baseline, assigned_clinic, emergency_contact, notes, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)
           ON CONFLICT (id) DO NOTHING RETURNING *`,
          [`P-${n}`, p.fullName, p.birthDate, p.sex || null, p.addressLine, p.zipCode, p.countryCode, p.latitude ?? null, p.longitude ?? null,
            p.conditions, p.mobilityRestricted, p.baseline, p.assignedClinic || null, p.emergencyContact, p.notes || null, req.user.id],
        );
        [row] = rows;
      }
      if (!row) throw new Error('Could not allocate a patient ID');

      const meds = [];
      for (const m of p.medications) {
        const { rows: [mr] } = await client.query(
          `INSERT INTO patient_medications (patient_id, name, dosage, frequency, times, instructions, prescribed_by, start_date, end_date, created_by)
           VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, current_date),$9,$10) RETURNING *`,
          [row.id, m.name, m.dosage, m.frequency, m.times || [], m.instructions || null, m.prescribedBy || null, m.startDate || null, m.endDate || null, req.user.id],
        );
        meds.push(toMedicationDto(mr));
      }
      return { patient: toPatientDto(row), medications: meds };
    });

    if (created.duplicateOf) {
      return res.status(409).json({ error: 'duplicate_patient', message: `A patient with this name and birth date already exists (${created.duplicateOf})`, patientId: created.duplicateOf });
    }
    logger.info('patient onboarded', { requestId: req.get('x-request-id'), patientId: created.patient.id, by: req.user.id });
    return res.status(201).json(created);
  } catch (err) {
    return next(err);
  }
});

/* ----------------------------- Prescribed medications ----------------------------- */

// GET /api/patients/:id/medications?includeInactive=true
// Caregivers and family members see only their own patients (checked at the gateway and here).
router.get('/api/patients/:id/medications', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!assertPatientScope(req, res, patientId)) return undefined;
    const { rows: pr } = await pool.query('SELECT id, full_name FROM patients WHERE id = $1', [patientId]);
    if (!pr.length) return res.status(404).json({ error: 'not_found', message: 'Patient not found' });
    const includeInactive = req.query.includeInactive === 'true';
    const { rows } = await pool.query(
      `SELECT * FROM patient_medications WHERE patient_id = $1 ${includeInactive ? '' : 'AND active = TRUE AND (end_date IS NULL OR end_date >= current_date)'}
        ORDER BY active DESC, name`,
      [patientId],
    );
    const meds = rows.map(toMedicationDto);
    // Today's schedule (Asia/Manila is assumed by the times entered by the clinic)
    const schedule = meds.filter((m) => m.active).flatMap((m) => (m.times.length ? m.times.map((t) => ({ time: t, medicationId: m.id, name: m.name, dosage: m.dosage })) : []))
      .sort((a, b) => a.time.localeCompare(b.time));
    return res.json({ patientId, patientName: pr[0].full_name, medications: meds, todaySchedule: schedule });
  } catch (err) {
    return next(err);
  }
});

// POST /api/patients/:id/medications   (clinic staff) - add a prescription
router.post('/api/patients/:id/medications', async (req, res, next) => {
  try {
    if (!requireRole(req, res, ['clinic_staff'])) return undefined;
    const r = validateMedication(req.body);
    if (!r.ok) return res.status(422).json({ error: 'validation_failed', details: r.errors });
    const m = r.value;
    const { rows: pr } = await pool.query('SELECT id FROM patients WHERE id = $1', [req.params.id]);
    if (!pr.length) return res.status(404).json({ error: 'not_found', message: 'Patient not found' });
    const { rows: [row] } = await pool.query(
      `INSERT INTO patient_medications (patient_id, name, dosage, frequency, times, instructions, prescribed_by, start_date, end_date, created_by)
       VALUES ($1,$2,$3,$4,$5,$6,$7,coalesce($8::date, current_date),$9,$10) RETURNING *`,
      [req.params.id, m.name, m.dosage, m.frequency, m.times || [], m.instructions || null, m.prescribedBy || req.user.id, m.startDate || null, m.endDate || null, req.user.id],
    );
    return res.status(201).json(toMedicationDto(row));
  } catch (err) {
    return next(err);
  }
});

// PATCH /api/patients/:id/medications/:medId   (clinic staff) - change dose/times or stop (active=false)
router.patch('/api/patients/:id/medications/:medId', async (req, res, next) => {
  try {
    if (!requireRole(req, res, ['clinic_staff'])) return undefined;
    if (!/^\d+$/.test(req.params.medId)) return res.status(400).json({ error: 'bad_request', message: 'Invalid medication id' });
    const r = validateMedication(req.body, '', { partial: true });
    if (!r.ok) return res.status(422).json({ error: 'validation_failed', details: r.errors });
    const cols = { name: 'name', dosage: 'dosage', frequency: 'frequency', times: 'times', instructions: 'instructions', prescribedBy: 'prescribed_by', startDate: 'start_date', endDate: 'end_date', active: 'active' };
    const sets = [];
    const vals = [req.params.medId, req.params.id];
    for (const [k, v] of Object.entries(r.value)) {
      vals.push(v);
      sets.push(`${cols[k]} = $${vals.length}`);
    }
    const { rows } = await pool.query(
      `UPDATE patient_medications SET ${sets.join(', ')}, updated_at = now() WHERE id = $1 AND patient_id = $2 RETURNING *`, vals,
    );
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'Medication not found for this patient' });
    return res.json(toMedicationDto(rows[0]));
  } catch (err) {
    return next(err);
  }
});

/* ---------------------- GET /api/patients/:id/history ----------------------- */
router.get('/api/patients/:id/history', async (req, res, next) => {
  try {
    const patientId = req.params.id;
    if (!assertPatientScope(req, res, patientId)) return undefined;
    const days = Math.min(Math.max(parseInt(req.query.days, 10) || 30, 1), 365);
    // Trends cover the whole period; only the check-in list is paged (?page=&pageSize=, limit= still accepted).
    const pg = parsePagination(req.query, { defaultPageSize: 100, maxPageSize: 500 });
    if (pg.errors.length) return res.status(422).json({ error: 'validation_failed', details: pg.errors });

    const { rows: pr } = await pool.query('SELECT * FROM patients WHERE id = $1', [patientId]);
    if (!pr.length) return res.status(404).json({ error: 'not_found', message: 'Patient not found' });

    const [{ rows: checkins }, { rows: [trend] }] = await Promise.all([
      pool.query(
        `SELECT * FROM checkins WHERE patient_id = $1 AND recorded_at >= now() - ($2 || ' days')::interval
          ORDER BY recorded_at DESC, id LIMIT $3 OFFSET $4`,
        [patientId, String(days), pg.pageSize, pg.offset],
      ),
      pool.query(
        `SELECT count(*)::int AS total,
                round(avg(systolic))::int AS avg_systolic, max(systolic) AS max_systolic, min(systolic) AS min_systolic,
                round(avg(diastolic))::int AS avg_diastolic,
                round(avg(heart_rate))::int AS avg_heart_rate,
                round(avg(temperature_c), 1)::float AS avg_temperature_c, max(temperature_c)::float AS max_temperature_c,
                round(avg(spo2))::int AS avg_spo2, min(spo2) AS min_spo2,
                count(DISTINCT (recorded_at AT TIME ZONE 'Asia/Manila')::date) FILTER (WHERE medication_taken = false)::int AS missed_medication_days,
                count(*) FILTER (WHERE severity IN ('high','critical'))::int AS high_severity_checkins
           FROM checkins WHERE patient_id = $1 AND recorded_at >= now() - ($2 || ' days')::interval`,
        [patientId, String(days)],
      ),
    ]);

    const patient = toPatientDto(pr[0]);
    return res.json({
      patient,
      period: { days, from: new Date(Date.now() - days * 86400000).toISOString(), to: new Date().toISOString() },
      trends: {
        totalCheckins: trend.total,
        bloodPressure: { avgSystolic: trend.avg_systolic, avgDiastolic: trend.avg_diastolic, maxSystolic: trend.max_systolic, minSystolic: trend.min_systolic },
        heartRate: { avg: trend.avg_heart_rate },
        temperatureC: { avg: trend.avg_temperature_c, max: trend.max_temperature_c },
        spo2: { avg: trend.avg_spo2, min: trend.min_spo2 },
        missedMedicationDays: trend.missed_medication_days,
        highSeverityCheckins: trend.high_severity_checkins,
      },
      baseline: patient.baseline,
      checkins: checkins.map(toCheckinDto),
      pagination: pageInfo(pg, trend.total),
    });
  } catch (err) {
    return next(err);
  }
});

/* --------------------------- GET /api/patients/:id -------------------------- */
router.get('/api/patients/:id', async (req, res, next) => {
  try {
    if (!assertPatientScope(req, res, req.params.id)) return undefined;
    const { rows } = await pool.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found', message: 'Patient not found' });
    return res.json(toPatientDto(rows[0]));
  } catch (err) {
    return next(err);
  }
});

/* ---------------- Internal (service-to-service) read endpoints --------------- */

// Used by the weather mashup: list patient profiles, optionally filtered by zip code.
router.get('/internal/patients', async (req, res, next) => {
  try {
    const zips = String(req.query.zip || '').split(',').map((z) => z.trim()).filter(Boolean);
    const { rows } = zips.length
      ? await pool.query('SELECT * FROM patients WHERE zip_code = ANY($1) ORDER BY id', [zips])
      : await pool.query('SELECT * FROM patients ORDER BY id');
    res.json({ patients: rows.map(toPatientDto) });
  } catch (err) {
    next(err);
  }
});

router.get('/internal/patients/:id', async (req, res, next) => {
  try {
    const { rows } = await pool.query('SELECT * FROM patients WHERE id = $1', [req.params.id]);
    if (!rows.length) return res.status(404).json({ error: 'not_found' });
    return res.json(toPatientDto(rows[0]));
  } catch (err) {
    return next(err);
  }
});

// Distinct monitored locations - the weather poller queries OpenWeatherMap once per zip.
router.get('/internal/locations', async (req, res, next) => {
  try {
    const { rows } = await pool.query(
      `SELECT zip_code, country_code, avg(latitude)::float AS lat, avg(longitude)::float AS lon, count(*)::int AS patients
         FROM patients GROUP BY zip_code, country_code ORDER BY zip_code`,
    );
    res.json({ locations: rows.map((r) => ({ zipCode: r.zip_code, countryCode: r.country_code, lat: r.lat, lon: r.lon, patients: r.patients })) });
  } catch (err) {
    next(err);
  }
});

// Check-in review status (Received -> Awaiting review -> Reviewed -> Action recorded); behind the same internal-token check.
router.use(require('./reviewRoutes'));

module.exports = router;
module.exports.toCheckinDto = toCheckinDto;

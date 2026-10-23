'use strict';

/**
 * API routing contracts (Section 10 - "Major System APIs").
 *
 * Every route: authenticate (JWT) -> authorize (RBAC) -> [patient scope] -> forward.
 *
 * | Method | Public path                         | Roles                               | Upstream service       |
 * |--------|-------------------------------------|-------------------------------------|------------------------|
 * | POST   | /api/checkins                       | caregiver                           | Daily Check-In Logger  |
 * | GET    | /api/patients/:id/history           | caregiver, family, clinic, admin    | Daily Check-In Logger  |
 * | GET    | /api/checkins/review-queue          | clinic, admin                       | Daily Check-In Logger  |
 * | GET    | /api/checkins/:id                   | caregiver, family (own), clinic, admin | Daily Check-In Logger |
 * | POST   | /api/checkins/:id/review|action     | clinic                              | Daily Check-In Logger  |
 * | POST   | /api/checkins/archive-demo          | clinic                              | Daily Check-In Logger  |
 * | POST   | /api/alerts/dispatch                | clinic, admin                       | Family Alert & Notif.  |
 * | GET    | /api/clinic/queue                   | clinic, admin                       | Clinic Risk Queue      |
 * Supporting routes used by the dashboards:
 * | GET    | /api/patients/:id                   | caregiver, family, clinic, admin    | Daily Check-In Logger  |
 * | GET    | /api/alerts/notifications           | family, caregiver                   | Family Alert & Notif.  |
 * | POST   | /api/alerts/weather-check           | clinic, admin                       | Family Alert & Notif.  |
 * | PATCH  | /api/clinic/queue/:itemId           | clinic                              | Clinic Risk Queue      |
 * | GET    | /api/clinic/patients/:id/emr-history| clinic, admin                       | Clinic Risk Queue      |
 * v1.1 additions:
 * | GET/POST | /api/patients                     | clinic, admin                       | Daily Check-In Logger  |
 * | GET    | /api/patients/:id/medications       | caregiver, family (own), clinic, admin | Daily Check-In Logger |
 * | POST/PATCH | /api/patients/:id/medications[/:medId] | clinic                     | Daily Check-In Logger  |
 * | GET    | /api/patients/:id/visits            | caregiver, family (own), clinic, admin | Clinic Risk Queue   |
 * | GET    | /api/clinic/queue/history           | clinic, admin                       | Clinic Risk Queue      |
 * | POST   | /api/clinic/queue/:itemId/visits    | clinic                              | Clinic Risk Queue      |
 * | GET    | /api/clinic/visits                  | clinic, admin                       | Clinic Risk Queue      |
 * | PATCH  | /api/clinic/visits/:visitId         | clinic                              | Clinic Risk Queue      |
 * | POST   | /api/clinic/handover[/:id/accept|decline|cancel] | clinic                 | Clinic Risk Queue      |
 * | GET    | /api/clinic/my-cases, /queue/pending-handovers, /patients/:id/care | clinic | Clinic Risk Queue   |
 * | GET/PUT| /api/clinic/duty[/me]               | clinic (admin may read)             | Clinic Risk Queue      |
 * | GET    | /api/clinic/care-teams              | clinic, admin                       | Clinic Risk Queue      |
 * | POST/DELETE | /api/clinic/care-teams[/:id/members[/:nurseId]] | admin              | Clinic Risk Queue      |
 * | PUT    | /api/clinic/patients/:id/care       | admin                               | Clinic Risk Queue      |
 * | GET    | /api/clinic/care-log                | admin                               | Clinic Risk Queue      |
 * | GET/POST/DELETE | /api/alerts/subscribers    | clinic, admin                       | Family Alert & Notif.  |
 * v2 Batch 2:
 * | GET    | /api/alerts/rules[/:code]           | clinic, admin                       | Family Alert & Notif.  |
 * | POST/PATCH/DELETE | /api/alerts/rules[/:code] | admin                              | Family Alert & Notif.  |
 * List endpoints accept ?page=&pageSize= and return a `pagination` envelope (limit= still works).
 * v2 Batch 4 (Care Plan Service - caregiver duties):
 * | GET    | /api/care/categories                | all roles                           | Care Plan              |
 * | GET    | /api/patients/:id/care-plan[/checklist|/history] | caregiver, family (own), clinic, admin | Care Plan |
 * | PUT    | /api/patients/:id/care-plan         | clinic                              | Care Plan              |
 * | POST   | /api/patients/:id/care-plan/tasks   | clinic                              | Care Plan              |
 * | PATCH/DELETE | /api/care/tasks/:taskId       | clinic                              | Care Plan              |
 * | POST   | /api/care/tasks/:taskId/completions | caregiver (service checks the task's patient) | Care Plan    |
 */
const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { authorize, requirePatientAccess, requireBodyPatientAccess } = require('../middleware/roleMiddleware');
const { ROLES } = require('../config/roles');
const { forwardTo } = require('../lib/proxy');

const router = express.Router();

// Everything under /api requires a valid access token.
router.use(authenticate);

// Who may read patient records: the elder's caregiver and family (own elders only) and nurses. The system admin
// is technical, not clinical: accounts, care-team links, system health and audit logs, but no vital signs,
// histories, medicines, visits, care plans or clinic cases, and no clinical actions (dispatching alerts,
// triage, reviews). An admin who also works as a nurse uses a separate nurse account.
const PATIENT_DATA = [ROLES.CAREGIVER, ROLES.FAMILY, ROLES.CLINIC];

/* ----------------------------- Daily Check-In Logger ----------------------------- */

router.post(
  '/checkins',
  authorize(ROLES.CAREGIVER),
  requireBodyPatientAccess('patientId'),
  forwardTo('checkin'),
);

// Check-in monitoring status: Received -> Awaiting review -> Reviewed -> Action recorded
router.get('/checkins/review-queue', authorize(ROLES.CLINIC), forwardTo('checkin'));
// The check-in id does not name the patient: the check-in service checks it against X-User-Patients.
router.get('/checkins/:id', authorize(...PATIENT_DATA), forwardTo('checkin'));
router.post('/checkins/archive-demo', authorize(ROLES.CLINIC), forwardTo('checkin'));
router.post('/checkins/:id/review', authorize(ROLES.CLINIC), forwardTo('checkin'));
router.post('/checkins/:id/action', authorize(ROLES.CLINIC), forwardTo('checkin'));

router.get(
  '/patients/:id/history',
  authorize(...PATIENT_DATA),
  requirePatientAccess('id'),
  forwardTo('checkin'),
);

// Patient onboarding + list (nurses: the records carry conditions and baselines)
router.get('/patients', authorize(ROLES.CLINIC), forwardTo('checkin'));
router.post('/patients', authorize(ROLES.CLINIC), forwardTo('checkin'));

// Prescribed medications: caregivers / family see their own patients; clinic staff prescribe
router.get(
  '/patients/:id/medications',
  authorize(...PATIENT_DATA),
  requirePatientAccess('id'),
  forwardTo('checkin'),
);
router.post('/patients/:id/medications', authorize(ROLES.CLINIC), forwardTo('checkin'));
router.patch('/patients/:id/medications/:medId', authorize(ROLES.CLINIC), forwardTo('checkin'));

// A patient's scheduled / recent visits, readable by their caregiver and family too
router.get(
  '/patients/:id/visits',
  authorize(...PATIENT_DATA),
  requirePatientAccess('id'),
  forwardTo('clinic', (req) => {
    const view = ['upcoming', 'recent', 'all'].includes(req.query.view) ? req.query.view : 'upcoming';
    return `/api/clinic/visits?patientId=${encodeURIComponent(req.params.id)}&view=${view}`;
  }),
);

/* ---------------------------- Care Plan (caregiver duties) ---------------------------- */
const ANY_ROLE = [ROLES.CAREGIVER, ROLES.FAMILY, ROLES.CLINIC, ROLES.ADMIN];
router.get('/care/categories', authorize(...ANY_ROLE), forwardTo('care'));
router.get('/patients/:id/care-plan', authorize(...PATIENT_DATA), requirePatientAccess('id'), forwardTo('care'));
router.get('/patients/:id/care-plan/checklist', authorize(...PATIENT_DATA), requirePatientAccess('id'), forwardTo('care'));
router.get('/patients/:id/care-plan/history', authorize(...PATIENT_DATA), requirePatientAccess('id'), forwardTo('care'));
router.put('/patients/:id/care-plan', authorize(ROLES.CLINIC), forwardTo('care'));
router.post('/patients/:id/care-plan/tasks', authorize(ROLES.CLINIC), forwardTo('care'));
router.patch('/care/tasks/:taskId', authorize(ROLES.CLINIC), forwardTo('care'));
router.delete('/care/tasks/:taskId', authorize(ROLES.CLINIC), forwardTo('care'));
// The task id does not name the patient: the care service checks the task's patient against X-User-Patients.
router.post('/care/tasks/:taskId/completions', authorize(ROLES.CAREGIVER), forwardTo('care'));

router.get(
  '/patients/:id',
  authorize(...PATIENT_DATA),
  requirePatientAccess('id'),
  forwardTo('checkin'),
);

/* -------------------------- Family Alert & Notification -------------------------- */

router.post(
  '/alerts/dispatch',
  authorize(ROLES.CLINIC), // a clinical decision
  forwardTo('alert'),
);

// Outdoor weather where the caregiver is (lat/lon) or at a ZIP code, for the check-in screen.
router.get('/alerts/weather/current', authorize(...ANY_ROLE), forwardTo('alert'));

router.post(
  '/alerts/weather-check',
  authorize(ROLES.CLINIC),
  forwardTo('alert'), // runs the OpenWeatherMap x patient-profile mashup on demand
);

// SMS contacts per patient (who receives alerts)
router.get('/alerts/subscribers', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('alert'));
router.post('/alerts/subscribers', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('alert'));
router.delete('/alerts/subscribers/:id', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('alert'));

// Heatwave / typhoon alert rules read by the weather mashup (admin CRUD; clinic staff may read)
router.get('/alerts/rules', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('alert'));
router.get('/alerts/rules/:code', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('alert'));
router.post('/alerts/rules', authorize(ROLES.ADMIN), forwardTo('alert'));
router.patch('/alerts/rules/:code', authorize(ROLES.ADMIN), forwardTo('alert'));
router.delete('/alerts/rules/:code', authorize(ROLES.ADMIN), forwardTo('alert'));

router.get(
  '/alerts/notifications',
  authorize(ROLES.FAMILY, ROLES.CAREGIVER),
  forwardTo('alert'), // the service filters by the forwarded X-User-Patients header
);

/* -------------------------------- Clinic Risk Queue ------------------------------- */

router.get(
  '/clinic/queue',
  authorize(ROLES.CLINIC),
  forwardTo('clinic'),
);
// Counts only (no names, reasons or scores per patient): the admin's operational digest
router.get('/clinic/queue/summary', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('clinic'));

// Resolved / dismissed case history
router.get('/clinic/queue/history', authorize(ROLES.CLINIC), forwardTo('clinic'));

// Visits: schedule for a case, list upcoming / recent, complete / cancel
router.post('/clinic/queue/:itemId/visits', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.get('/clinic/visits', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.patch('/clinic/visits/:visitId', authorize(ROLES.CLINIC), forwardTo('clinic'));

// Care teams, case ownership and nurse handover (a case moves only when the incoming nurse accepts).
// Duty coverage is set by the nurse and is independent of login sessions.
router.post('/clinic/handover', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.post('/clinic/handover/:id/:op(accept|decline|cancel)', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.get('/clinic/my-cases', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.get('/clinic/queue/pending-handovers', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.get('/clinic/patients/:id/care', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.put('/clinic/patients/:id/care', authorize(ROLES.ADMIN), forwardTo('clinic'));
router.get('/clinic/duty', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('clinic'));
router.put('/clinic/duty/me', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.get('/clinic/care-teams', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('clinic'));
router.post('/clinic/care-teams', authorize(ROLES.ADMIN), forwardTo('clinic'));
router.post('/clinic/care-teams/:id/members', authorize(ROLES.ADMIN), forwardTo('clinic'));
router.delete('/clinic/care-teams/:id/members/:nurseId', authorize(ROLES.ADMIN), forwardTo('clinic'));
router.get('/clinic/care-log', authorize(ROLES.ADMIN), forwardTo('clinic'));

router.patch(
  '/clinic/queue/:itemId',
  authorize(ROLES.CLINIC),
  forwardTo('clinic'),
);

router.get(
  '/clinic/patients/:id/emr-history',
  authorize(ROLES.CLINIC),
  forwardTo('clinic'),
);

module.exports = router;

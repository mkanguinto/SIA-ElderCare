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
 * | GET/POST/DELETE | /api/alerts/subscribers    | clinic, admin                       | Family Alert & Notif.  |
 * v2 Batch 2:
 * | GET    | /api/alerts/rules[/:code]           | clinic, admin                       | Family Alert & Notif.  |
 * | POST/PATCH/DELETE | /api/alerts/rules[/:code] | admin                              | Family Alert & Notif.  |
 * List endpoints accept ?page=&pageSize= and return a `pagination` envelope (limit= still works).
 */
const express = require('express');
const { authenticate } = require('../middleware/authMiddleware');
const { authorize, requirePatientAccess, requireBodyPatientAccess } = require('../middleware/roleMiddleware');
const { ROLES } = require('../config/roles');
const { forwardTo } = require('../lib/proxy');

const router = express.Router();

// Everything under /api requires a valid access token.
router.use(authenticate);

/* ----------------------------- Daily Check-In Logger ----------------------------- */

router.post(
  '/checkins',
  authorize(ROLES.CAREGIVER),
  requireBodyPatientAccess('patientId'),
  forwardTo('checkin'),
);

router.get(
  '/patients/:id/history',
  authorize(ROLES.CAREGIVER, ROLES.FAMILY, ROLES.CLINIC, ROLES.ADMIN),
  requirePatientAccess('id'),
  forwardTo('checkin'),
);

// Patient onboarding + list (clinic staff / admin)
router.get('/patients', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('checkin'));
router.post('/patients', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('checkin'));

// Prescribed medications: caregivers / family see their own patients; clinic staff prescribe
router.get(
  '/patients/:id/medications',
  authorize(ROLES.CAREGIVER, ROLES.FAMILY, ROLES.CLINIC, ROLES.ADMIN),
  requirePatientAccess('id'),
  forwardTo('checkin'),
);
router.post('/patients/:id/medications', authorize(ROLES.CLINIC), forwardTo('checkin'));
router.patch('/patients/:id/medications/:medId', authorize(ROLES.CLINIC), forwardTo('checkin'));

// A patient's scheduled / recent visits, readable by their caregiver and family too
router.get(
  '/patients/:id/visits',
  authorize(ROLES.CAREGIVER, ROLES.FAMILY, ROLES.CLINIC, ROLES.ADMIN),
  requirePatientAccess('id'),
  forwardTo('clinic', (req) => {
    const view = ['upcoming', 'recent', 'all'].includes(req.query.view) ? req.query.view : 'upcoming';
    return `/api/clinic/visits?patientId=${encodeURIComponent(req.params.id)}&view=${view}`;
  }),
);

router.get(
  '/patients/:id',
  authorize(ROLES.CAREGIVER, ROLES.FAMILY, ROLES.CLINIC, ROLES.ADMIN),
  requirePatientAccess('id'),
  forwardTo('checkin'),
);

/* -------------------------- Family Alert & Notification -------------------------- */

router.post(
  '/alerts/dispatch',
  authorize(ROLES.CLINIC, ROLES.ADMIN),
  forwardTo('alert'),
);

router.post(
  '/alerts/weather-check',
  authorize(ROLES.CLINIC, ROLES.ADMIN),
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
  authorize(ROLES.CLINIC, ROLES.ADMIN),
  forwardTo('clinic'),
);

// Resolved / dismissed case history
router.get('/clinic/queue/history', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('clinic'));

// Visits: schedule for a case, list upcoming / recent, complete / cancel
router.post('/clinic/queue/:itemId/visits', authorize(ROLES.CLINIC), forwardTo('clinic'));
router.get('/clinic/visits', authorize(ROLES.CLINIC, ROLES.ADMIN), forwardTo('clinic'));
router.patch('/clinic/visits/:visitId', authorize(ROLES.CLINIC), forwardTo('clinic'));

router.patch(
  '/clinic/queue/:itemId',
  authorize(ROLES.CLINIC),
  forwardTo('clinic'),
);

router.get(
  '/clinic/patients/:id/emr-history',
  authorize(ROLES.CLINIC, ROLES.ADMIN),
  forwardTo('clinic'),
);

module.exports = router;

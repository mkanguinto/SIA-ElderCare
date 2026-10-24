'use strict';

/**
 * Staff directory for the Clinic Portal (gateway-local; users live in data/users.json).
 *
 *   GET /api/directory/users?role=caregiver,family_member      clinic staff, admin
 *   PUT /api/directory/users/:userId/patients { add:[], remove:[] }  clinic staff, admin
 *       Links a caregiver / family member to patients so they can see them (after signing in again).
 */
const express = require('express');
const config = require('../config');
const { authenticate } = require('../middleware/authMiddleware');
const { authorize } = require('../middleware/roleMiddleware');
const { ROLES, ALL_ROLES, PATIENT_SCOPED_ROLES } = require('../config/roles');
const { listUsers, updateUserPatients, audit } = require('../auth/userStore');
const { request } = require('../lib/resilientHttp');
const logger = require('../lib/logger');

const router = express.Router();
router.use(authenticate, authorize(ROLES.CLINIC, ROLES.ADMIN));

router.get('/users', async (req, res, next) => {
  try {
    const roles = String(req.query.role || '').split(',').filter((r) => ALL_ROLES.includes(r));
    const users = (await listUsers())
      .filter((u) => u.status === 'active' && (!roles.length || roles.includes(u.role)))
      .map(({ id, name, username, role, patients }) => ({ id, name, username, role, patients }));
    res.json({ users });
  } catch (err) {
    next(err);
  }
});

const PID = /^[A-Za-z0-9_-]{1,64}$/;

router.put('/users/:userId/patients', async (req, res, next) => {
  try {
    const add = Array.isArray(req.body && req.body.add) ? req.body.add.map(String) : [];
    const remove = Array.isArray(req.body && req.body.remove) ? req.body.remove.map(String) : [];
    if (!add.length && !remove.length) return res.status(422).json({ error: 'validation_failed', details: ['Provide add and/or remove patient ID lists'] });
    if ([...add, ...remove].some((p) => !PID.test(p)) || add.length + remove.length > 50) {
      return res.status(422).json({ error: 'validation_failed', details: ['Patient IDs must look like P-1004 (max 50)'] });
    }
    const target = (await listUsers()).find((u) => u.id === req.params.userId);
    if (!target) return res.status(404).json({ error: 'not_found', message: 'User not found' });
    if (!PATIENT_SCOPED_ROLES.includes(target.role)) {
      return res.status(422).json({ error: 'validation_failed', details: ['Only caregivers and family members are linked to specific patients'] });
    }
    // Every added patient must exist in the Daily Check-In Logger.
    for (const pid of add) {
      const r = await request('checkin', {
        method: 'GET', url: `${config.services.checkin}/internal/patients/${encodeURIComponent(pid)}`,
        headers: { 'x-internal-token': config.internalServiceToken, 'x-request-id': req.id }, validateStatus: () => true,
      }, { retries: 1, timeoutMs: config.upstreamTimeoutMs });
      if (r.status === 404) return res.status(422).json({ error: 'validation_failed', details: [`Patient ${pid} does not exist`] });
      if (r.status !== 200) return res.status(502).json({ error: 'bad_gateway', message: 'Could not verify the patient' });
    }
    if (target.role === 'family_member' && add.length) {
      return res.status(422).json({ error: 'validation_failed', details: ['Family members are linked to an elder through family verification'] });
    }
    const updated = await updateUserPatients(target.id, { add, remove });
    logger.info('user patients updated', { requestId: req.id, userId: target.id, add, remove, by: req.user.id });
    await audit(req, 'patients_linked', target.id, { add, remove });
    return res.json({ user: updated, note: 'The user must sign out and sign in again to see the change.' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

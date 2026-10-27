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
const FAMILY_VERIFY_METHODS = ['elder_in_person', 'elder_by_phone', 'id_and_document', 'other'];
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
    // Family verification: a family member sees an elder only after a nurse (or the admin) records how the relationship was
    // confirmed (by the elder in person or by phone, an ID and a document, or another way described in words).
    let familyVerification;
    if (target.role === 'family_member' && add.length) {
      const v = (req.body && req.body.familyVerification) || {};
      const other = typeof v.methodOther === 'string' ? v.methodOther.trim() : '';
      const note = typeof v.note === 'string' ? v.note.trim() : '';
      const errors = [];
      // A nurse, or the Health Center Admin (the nurse supervisor) in Care teams, records how it was confirmed.
      if (![ROLES.CLINIC, ROLES.ADMIN].includes(req.user.role)) errors.push('Only a nurse or the health center administrator can verify a family member');
      if (!FAMILY_VERIFY_METHODS.includes(v.method)) errors.push(`Family members are linked to an elder through family verification: familyVerification.method must be one of ${FAMILY_VERIFY_METHODS.join(', ')}`);
      if (v.method === 'other' && (other.length < 2 || other.length > 80)) errors.push('familyVerification.methodOther is required when "other" is chosen (2-80 characters)');
      if (note.length > 300) errors.push('familyVerification.note must be at most 300 characters');
      if (errors.length) return res.status(422).json({ error: 'validation_failed', details: errors });
      familyVerification = { method: v.method, ...(v.method === 'other' ? { methodOther: other } : {}), ...(note ? { note } : {}), verifiedBy: req.user.id, verifiedAt: new Date().toISOString() };
    }
    const updated = await updateUserPatients(target.id, { add, remove });
    logger.info('user patients updated', { requestId: req.id, userId: target.id, add, remove, by: req.user.id });
    await audit(req, 'patients_linked', target.id, { add, remove, ...(familyVerification ? { familyVerification } : {}) });
    return res.json({ user: updated, note: 'The user must sign out and sign in again to see the change.' });
  } catch (err) {
    return next(err);
  }
});

module.exports = router;

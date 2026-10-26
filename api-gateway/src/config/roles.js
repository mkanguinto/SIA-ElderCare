'use strict';

/**
 * The four platform roles from Section 12 ("Expected User Roles").
 * The string values are what appears in the JWT `role` claim.
 */
const ROLES = Object.freeze({
  CAREGIVER: 'caregiver', //        Primary Caregiver
  FAMILY: 'family_member', //       Family Member / Sponsor
  CLINIC: 'clinic_staff', //        Clinic Staff / Nurse
  ADMIN: 'system_admin', //         Health Center Administrator (accounts, care teams, operations)
});

const ALL_ROLES = Object.freeze(Object.values(ROLES));

/**
 * Roles whose data access is limited to the patients listed in their token's
 * `patients` claim (assigned patients / relatives). Clinic staff and admins are
 * not patient-scoped.
 */
const PATIENT_SCOPED_ROLES = Object.freeze([ROLES.CAREGIVER, ROLES.FAMILY]);

module.exports = { ROLES, ALL_ROLES, PATIENT_SCOPED_ROLES };

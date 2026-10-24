'use strict';

const test = require('node:test');
const assert = require('node:assert');
const plan = require('../src/planContent');

const order = { type: 'physician_order', clinician: 'Dr. L. Reyes', facility: 'RHU-MNL-01', date: '2026-10-01' };
const ready = () => ({
  status: 'draft',
  content: {
    goals: 'Stay at home safely; keep walking daily.',
    preferences: 'Prefers a bath in the morning; likes rice porridge.',
    allergies: { status: 'none_known', items: [] },
    caregiver: { responsibilities: 'Daily check-in, help with bathing, report concerns.' },
    contact: {
      phone: '09171887757', monitoringHours: 'Mon-Sat 8 AM-5 PM',
      emergency: { text: 'Call 911 for chest pain or a fall with injury.', source: { type: 'clinic_protocol', reference: 'RHU-EM-01' }, partnerApproval: 'required' },
    },
  },
  responsibleNurseId: 'U-CS-001', elderInvolved: true, caregiverInvolved: true, involvementNote: null,
  effectiveDate: '2026-10-25', reviewDate: '2027-01-25',
  verification: { clinicianName: 'Dr. L. Reyes' },
});

test('specialised instructions need a clinical source and always need partner-clinic approval', () => {
  const nurseOnly = plan.validateContent({ clinicalInstructions: [{ kind: 'diet', text: 'Low-salt meals', source: { type: 'nurse_assessment' }, partnerApproval: 'not_required' }] });
  assert.match(nurseOnly.errors.join(), /clinicalInstructions\[0\]\.source\.type must be one of: physician_order/);
  const noSource = plan.validateContent({ clinicalInstructions: [{ kind: 'fluids', text: 'Offer water' }] });
  assert.match(noSource.errors.join(), /source is required/);
  const ok = plan.validateContent({ clinicalInstructions: [{ kind: 'swallowing', text: 'Soft food, sit upright', source: order, partnerApproval: 'not_required' }] });
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.value.clinicalInstructions[0].partnerApproval, 'required', 'a nurse cannot waive approval for a specialised instruction');
  // A non-specialised restriction may come from the nurse's own assessment and need no approval.
  const r = plan.validateContent({ clinicalInstructions: [{ kind: 'restriction', text: 'No climbing stairs alone', source: { type: 'nurse_assessment' }, partnerApproval: 'not_required' }] });
  assert.deepStrictEqual(r.errors, []);
  assert.strictEqual(r.value.clinicalInstructions[0].partnerApproval, 'not_required');
});

test('after-hours and emergency instructions are approved instructions with a clinical source', () => {
  const bad = plan.validateContent({ contact: { phone: '09171887757', emergency: { text: 'Call me', source: { type: 'nurse_assessment' } } } });
  assert.match(bad.errors.join(), /contact\.emergency\.source\.type/);
  const ok = plan.validateContent({ contact: { phone: '09171887757', afterHours: { text: 'Call the RHU hotline', source: { type: 'clinic_protocol', reference: 'RHU-AH-02' } } } });
  assert.deepStrictEqual(ok.errors, []);
  assert.strictEqual(ok.value.contact.afterHours.partnerApproval, 'required');
  assert.match(plan.validateContent({ contact: { phone: 'call me' } }).errors.join(), /phone number/);
  assert.match(plan.validateContent({ clinicalInstructions: [{ kind: 'other', text: 'x', source: { type: 'clinic_protocol' } }] }).errors.join(), /name the protocol/);
});

test('allergies must be recorded explicitly; an empty list is not "none known"', () => {
  assert.match(plan.validateContent({ allergies: { status: 'listed', items: [] } }).errors.join(), /at least one allergy/);
  assert.match(plan.validateContent({ allergies: { status: 'none_known', items: [{ substance: 'Penicillin' }] } }).errors.join(), /only for status listed/);
  assert.match(plan.validateContent({ allergies: {} }).errors.join(), /allergies\.status/);
  assert.deepStrictEqual(plan.validateContent({ allergies: { status: 'listed', items: [{ substance: 'Penicillin', reaction: 'rash', source: 'RHU record' }] } }).errors, []);
});

test('verification records the clinician, method and date; written orders need a reference', () => {
  const today = '2026-10-25';
  assert.match(plan.validateVerification({}, today).errors.join(), /clinicianName is required.*clinicianRole is required.*method must be.*verifiedOn/);
  assert.match(plan.validateVerification({ clinicianName: 'Dr. Reyes', clinicianRole: 'physician', method: 'written_order', verifiedOn: today }, today).errors.join(), /reference is required/);
  assert.match(plan.validateVerification({ clinicianName: 'Dr. Reyes', clinicianRole: 'physician', method: 'phone', verifiedOn: '2026-10-26' }, today).errors.join(), /future/);
  assert.deepStrictEqual(plan.validateVerification({ clinicianName: 'Dr. Reyes', clinicianRole: 'physician', method: 'phone', verifiedOn: today }, today).errors, []);
});

test('a complete, verified draft is ready; each missing part is named', () => {
  assert.deepStrictEqual(plan.activationProblems(ready(), [], '2026-10-25'), []);
  const p = (mut) => { const v = ready(); mut(v); return plan.activationProblems(v, [], '2026-10-25').join(' | '); };
  assert.match(p((v) => { delete v.content.goals; }), /care goals/);
  assert.match(p((v) => { delete v.content.allergies; }), /allergies are not recorded/);
  assert.match(p((v) => { v.content.contact.emergency = null; }), /emergency instructions/);
  assert.match(p((v) => { v.verification = null; }), /not been verified/);
  assert.match(p((v) => { v.effectiveDate = '2026-10-26'; }), /in the future/);
  assert.match(p((v) => { v.reviewDate = '2026-10-25'; }), /review date must be after/);
  assert.match(p((v) => { v.reviewDate = '2028-01-01'; }), /within 366 days/);
  assert.match(p((v) => { v.caregiverInvolved = false; }), /explain why/);
  assert.strictEqual(p((v) => { v.caregiverInvolved = false; v.involvementNote = 'Caregiver was at work; plan explained by phone.'; }), '');
  assert.match(p((v) => { v.status = 'active'; }), /only a draft/);
  const tasks = [{ title: 'Wound care', active: true, specialised: true, source: { type: 'nurse_assessment' } }];
  assert.match(plan.activationProblems(ready(), tasks, '2026-10-25').join(), /Wound care.*clinical source/);
});

test('changing an instruction that needs approval changes the approval list (so the verification is cleared)', () => {
  const a = ready().content;
  const b = { ...a, contact: { ...a.contact, emergency: { ...a.contact.emergency, text: 'Call 911 for any fall.' } } };
  assert.notDeepStrictEqual(plan.approvalItems(a), plan.approvalItems(b));
  assert.deepStrictEqual(plan.approvalItems({ ...a, goals: 'New goals' }), plan.approvalItems(a));
});

test('family summary: goals, preferences, nurse and contact; no sources, verification or drafts', () => {
  const v = { ...ready(), status: 'active', version: 2, responsibleNurseName: 'Ana Cruz, RN',
    content: { ...ready().content, clinicalInstructions: [{ kind: 'diet', text: 'Low-salt', source: order, partnerApproval: 'required' }] } };
  const s = plan.familySummary(v);
  assert.strictEqual(s.version, 2);
  assert.strictEqual(s.responsibleNurse, 'Ana Cruz, RN');
  assert.strictEqual(s.contact.emergency, 'Call 911 for chest pain or a fall with injury.');
  const json = JSON.stringify(s);
  assert.ok(!json.includes('Dr. L. Reyes') && !json.includes('verification') && !json.includes('Low-salt'), json);
});

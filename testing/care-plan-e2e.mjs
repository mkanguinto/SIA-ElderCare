// Care plan and caregiver checklist - end-to-end test against a running stack (docker compose up), no dependencies.
//   npm run test:care-plan            (GATEWAY_URL=http://host:8080 to point elsewhere)
// Uses its own elder ("Care Plan Test Elder") on care team CT-MNL-A, so the demo elders' plans are not changed.
// Covers: role permissions, plan versioning, prescription records and the medicine schedule, missing data,
// review versus concern resolution, and handover continuity.
const B = process.env.GATEWAY_URL || 'http://localhost:8080';
let pass = 0; let fail = 0;
const ok = (c, m) => { if (c) pass += 1; else fail += 1; console.log(`${c ? 'PASS' : 'FAIL'} ${m}`); };
const call = async (method, path, token, body) => {
  const r = await fetch(B + path, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null; try { j = await r.json(); } catch { /* empty */ }
  return { s: r.status, j };
};
const login = async (u, device = 'desktop') => (await call('POST', '/oauth/token', null, { grant_type: 'password', username: u, password: process.env.DEMO_PASSWORD || 'ElderCare@2026', device })).j.access_token;
const manila = (d = 0) => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date(Date.now() + d * 86400000));
const today = manila();
const order = { type: 'physician_order', prescriber: 'Dr. L. Reyes', facility: 'RHU-MNL-01', date: today };
const clinical = { type: 'clinic_protocol', reference: 'RHU-EM-01' };

const admin = await login('admin.harold');
let ana = await login('nurse.ana');
const ben = await login('nurse.ben');
const carla = await login('nurse.carla');
ok(admin && ana && ben && carla, 'nurse and admin sign-ins');

// ---------------------------------------------------------------- test elder on team A, linked to the caregiver
let pid = ((await call('GET', '/api/patients?pageSize=200', ana)).j.patients || []).find((p) => p.fullName === 'Care Plan Test Elder')?.id;
if (!pid) {
  const r = await call('POST', '/api/patients', ana, { fullName: 'Care Plan Test Elder', birthDate: '1944-04-04', sex: 'F', addressLine: 'Brgy 3, Manila', zipCode: '1000', conditions: [] });
  pid = r.j && r.j.patient && r.j.patient.id;
}
ok(Boolean(pid), `test elder ${pid}`);
let care = await call('PUT', `/api/clinic/patients/${pid}/care`, admin, { patientName: 'Care Plan Test Elder', careTeamId: 'CT-MNL-A', monitoringPlanId: 'MP-DAILY', ...(((await call('GET', `/api/clinic/patients/${pid}/care`, ana)).j || {}).caseNurse ? {} : { caseNurseId: 'U-CS-001' }) });
ok([200, 201].includes(care.s), `test elder linked to care team A (${care.s})`);
const cgUser = (await call('GET', '/api/directory/users?role=caregiver', ana)).j.users.find((u) => u.username === 'caregiver.maria');
await call('PUT', `/api/directory/users/${cgUser.id}/patients`, ana, { add: [pid] });
const cg = await login('caregiver.maria', 'phone');
const fam = await login('family.jose', 'phone');

// ---------------------------------------------------------------- 1. permissions (checked by the services, not only the UI)
ok((await call('POST', `/api/patients/${pid}/care-plan/drafts`, admin, {})).s === 403, 'admin cannot start or change a care plan (403)');
ok((await call('GET', `/api/patients/${pid}/care-plan`, admin)).s === 403, 'admin cannot read the clinical care plan (403)');
ok((await call('POST', `/api/patients/${pid}/care-plan/drafts`, cg, {})).s === 403, 'caregiver cannot change the care plan (403)');
ok((await call('GET', `/api/patients/${pid}/care-plan/versions`, cg)).s === 403, 'caregiver cannot see drafts and plan history (403)');
let r = await call('POST', `/api/patients/${pid}/care-plan/drafts`, carla, {});
ok(r.s === 403 && r.j.error === 'not_on_care_team', `a nurse who is not on the elder's care team cannot change the plan (${r.s} ${r.j && r.j.error})`);
ok((await call('GET', `/api/patients/${pid}/care-plan`, fam)).s === 403, "family cannot read an elder they are not linked to (403)");
ok((await call('POST', `/api/patients/${pid}/medications`, cg, { name: 'X', strength: '1 mg', frequency: 'daily', source: order })).s === 403, 'caregiver cannot prescribe (403)');

// ---------------------------------------------------------------- 2. plan versioning
const before = (await call('GET', `/api/patients/${pid}/care-plan`, ana)).j;
if (before.draft) await call('POST', `/api/care-plan/versions/${before.draft.id}/discard`, ana, { reason: 'Test reset' });
r = await call('POST', `/api/patients/${pid}/care-plan/drafts`, ana, { changeSummary: 'Test plan' });
const draft = r.j;
ok(r.s === 201 && draft.status === 'draft', `nurse on the team starts a draft (version ${draft.version})`);
r = await call('POST', `/api/patients/${pid}/care-plan/drafts`, ben, {});
ok(r.s === 200 && r.j.id === draft.id, 'only one draft at a time: a second request returns the same draft');
r = await call('POST', `/api/care-plan/versions/${draft.id}/activate`, ana, {});
// (A first draft is empty; later drafts copy the active plan but not its verification or dates.)
ok(r.s === 422 && r.j.details.length > 0 && (draft.version > 1 || (r.j.details.some((d) => /care goals/.test(d)) && r.j.details.some((d) => /emergency/.test(d)))),
  `an incomplete draft cannot be activated (${r.j && r.j.details.length} problems listed)`);
r = await call('PATCH', `/api/care-plan/versions/${draft.id}`, ana, { content: { clinicalInstructions: [{ kind: 'diet', text: 'Low-salt meals', source: { type: 'nurse_assessment' } }] } });
ok(r.s === 422 && /source\.type/.test(r.j.details.join()), 'a diet instruction from the nurse alone is refused: it needs a clinical source (422)');
const content = {
  goals: 'Stay safely at home; walk every day.', preferences: 'Bath in the morning; likes rice porridge; Tagalog.',
  assistanceNeeds: [{ area: 'hygiene', level: 'some_help' }, { area: 'mobility', level: 'supervision', details: 'Cane outdoors' }],
  allergies: { status: 'listed', items: [{ substance: 'Penicillin', reaction: 'rash', source: 'RHU record' }] },
  clinicalInstructions: [{ kind: 'diet', text: 'Low-salt meals as ordered', source: order }],
  caregiver: { responsibilities: 'Daily check-in, help with bathing, report concerns.', trainingAndCapacity: 'BP monitor training done', notForCaregiver: 'No wound dressing' },
  monitoring: { followUp: 'Nurse visit every 2 weeks' },
  contact: { clinicName: 'RHU Manila', phone: '09171887757', monitoringHours: 'Mon-Sat 8 AM-5 PM',
    afterHours: { text: 'After 5 PM call the RHU hotline.', source: clinical }, emergency: { text: 'Call 911 for chest pain, trouble breathing or a fall with injury.', source: clinical } },
};
r = await call('PATCH', `/api/care-plan/versions/${draft.id}`, ana, { content, responsibleNurseId: 'U-CS-001', elderInvolved: true, caregiverInvolved: true, effectiveDate: today, reviewDate: manila(90) });
ok(r.s === 200 && r.j.content.clinicalInstructions[0].partnerApproval === 'required', 'plan content saved; the diet instruction is marked as needing partner-clinic approval');
r = await call('POST', `/api/patients/${pid}/care-plan/tasks`, ana, { category: 'physical_medical', title: 'Wound dressing', frequency: 'daily', times: ['10:00'], specialised: true });
ok(r.s === 422, 'a specialised task without a clinical source is refused (422)');
r = await call('POST', `/api/patients/${pid}/care-plan/tasks`, ana, { category: 'physical_medical', title: 'Measure blood pressure', frequency: 'daily', times: ['09:00'], kind: 'measurement', measurement: 'bp' });
const bpTaskDraft = r.j;
ok(r.s === 201 && r.j.draft === true, 'measurement task added to the draft');
r = await call('POST', `/api/patients/${pid}/care-plan/tasks`, ana, { category: 'personal_care', title: 'Help with bathing', frequency: 'daily', times: ['08:00'] });
ok(r.s === 201, 'personal care task added to the draft');
r = await call('POST', `/api/care-plan/versions/${draft.id}/activate`, ana, {});
ok(r.s === 422 && r.j.details.some((d) => /verified/.test(d)), 'not activated until a clinician verifies the instructions that need approval');
const verification = { clinicianName: 'Dr. L. Reyes', clinicianRole: 'physician', method: 'phone', verifiedOn: today };
ok((await call('POST', `/api/care-plan/versions/${draft.id}/verification`, ana, verification)).s === 200, 'verification recorded');
r = await call('PATCH', `/api/care-plan/versions/${draft.id}`, ana, { content: { contact: { ...content.contact, emergency: { text: 'Call 911 for any fall.', source: clinical } } } });
ok(r.s === 200 && r.j.verificationCleared === true && !r.j.verification, 'changing a verified instruction clears the verification');
await call('PATCH', `/api/care-plan/versions/${draft.id}`, ana, { content: { contact: content.contact } });
await call('POST', `/api/care-plan/versions/${draft.id}/verification`, ana, verification);
const prevActive = (await call('GET', `/api/patients/${pid}/care-plan`, ana)).j.active;
r = await call('POST', `/api/care-plan/versions/${draft.id}/activate`, ana, {});
ok(r.s === 200 && r.j.status === 'active', `version ${draft.version} activated`);
const versions = (await call('GET', `/api/patients/${pid}/care-plan/versions`, ana)).j;
if (prevActive) ok(versions.versions.find((v) => v.id === prevActive.id).status === 'superseded', `version ${prevActive.version} superseded, kept in the history`);
ok(['draft_created', 'verified', 'activated'].every((a) => versions.history.some((h) => h.action === a && h.versionId === draft.id)), 'change history records draft, verification and activation');
ok((await call('PATCH', `/api/care-plan/versions/${draft.id}`, ana, { content: { goals: 'changed' } })).s === 409, 'an active version cannot be edited in place (409)');
const plan = (await call('GET', `/api/patients/${pid}/care-plan`, cg)).j;
const bpTask = plan.tasks.find((t) => t.title === 'Measure blood pressure');
ok(plan.active.version === draft.version && bpTask, `caregiver sees the active version ${plan.active.version} and its tasks`);
ok((await call('PATCH', `/api/care/tasks/${bpTask.id}`, ana, { times: ['11:00'] })).s === 409, "a task of the plan in use cannot be changed in place (409)");

// ---------------------------------------------------------------- 3. prescriptions and the medicine schedule
ok((await call('POST', `/api/patients/${pid}/medications`, ana, { name: 'Losartan', strength: '50 mg tablet', frequency: 'twice a day', times: ['08:00', '20:00'] })).s === 422, 'a prescription without its source is refused (422)');
r = await call('POST', `/api/patients/${pid}/medications`, ana, { name: 'Losartan', strength: '50 mg tablet', dose: '1 tablet', route: 'oral', frequency: 'twice a day', times: ['08:00', '20:00'], foodInstructions: 'after meals', source: order,
  missedDoseInstructions: 'If more than 4 hours late, skip that dose and tell the nurse.', missedDoseSource: order });
const med = r.j;
ok(r.s === 201 && med.source.prescriber === 'Dr. L. Reyes', 'prescription recorded from its source');
ok((await call('PATCH', `/api/patients/${pid}/medications/${med.id}`, ana, { times: ['09:00'] })).s === 409, 'a prescription cannot be changed in place (409)');
ok((await call('PATCH', `/api/patients/${pid}/medications/${med.id}`, ana, { verification: { method: 'written_order', verifiedOn: today } })).s === 200, 'a missing verification can be recorded once');
let cl = (await call('GET', `/api/patients/${pid}/care-plan/checklist`, cg)).j;
const doses = cl.medicines.doses.filter((d) => d.medication.id === med.id);
ok(doses.map((d) => d.slot).join() === '08:00,20:00' && doses.every((d) => d.status === 'not_reported'), 'checklist shows a dose for each prescribed time, not reported (never assumed taken)');
ok(doses[0].medication.missedDoseInstructions && doses[0].medication.verified, 'verified missed-dose instructions are shown with the dose');
ok(cl.planVersion && cl.planVersion.version === draft.version, `checklist shows plan version ${cl.planVersion && cl.planVersion.version}`);
ok((await call('POST', `/api/patients/${pid}/medication-reports`, cg, { medicationId: med.id, slot: '09:00', status: 'taken' })).s === 422, 'a dose at a time that is not prescribed is refused (422)');
ok((await call('POST', `/api/patients/${pid}/medication-reports`, cg, { medicationId: med.id, slot: '08:00', status: 'not_taken', actualTime: new Date().toISOString() })).s === 422, 'an actual time only goes with a dose reported taken (422)');
ok((await call('POST', `/api/patients/${pid}/medication-reports`, fam, { medicationId: med.id, slot: '08:00', status: 'taken' })).s === 403, 'family cannot report doses (403)');
r = await call('POST', `/api/patients/${pid}/medication-reports`, cg, { medicationId: med.id, slot: '08:00', status: 'taken', actualTime: new Date().toISOString(), planVersion: draft.version });
const firstReport = r.j;
ok(r.s === 201 && r.j.status === 'taken' && !r.j.versionMismatch, 'caregiver reports the 08:00 dose as taken');
r = await call('POST', `/api/patients/${pid}/medication-reports`, cg, { medicationId: med.id, slot: '08:00', status: 'unknown', reason: 'Not sure she swallowed it' });
ok(r.s === 200 && r.j.id === firstReport.id && r.j.status === 'unknown', 'a correction updates the report (the earlier one is kept in report_revisions)');
r = await call('POST', `/api/patients/${pid}/medications/${med.id}/revisions`, ana, { name: 'Losartan', strength: '50 mg tablet', dose: '1 tablet', route: 'oral', frequency: 'twice a day', times: ['08:00', '21:00'], source: order });
ok(r.s === 422 && /changeReason/.test(r.j.details.join()), 'a revision needs the reason for the change (422)');
r = await call('POST', `/api/patients/${pid}/medications/${med.id}/revisions`, ana, { name: 'Losartan', strength: '50 mg tablet', dose: '1 tablet', route: 'oral', frequency: 'twice a day', times: ['08:00', '21:00'], source: order, changeReason: 'Evening dose moved to 9 PM by Dr. Reyes' });
const med2 = r.j;
ok(r.s === 201 && med2.supersedesId === med.id, 'a changed prescription is a new record that supersedes the old one');
const allMeds = (await call('GET', `/api/patients/${pid}/medications?includeInactive=true`, ana)).j.medications;
const old = allMeds.find((m) => m.id === med.id);
ok(old && !old.active && old.supersededById === med2.id && old.times.join() === '08:00,20:00', 'the old prescription is kept as it was, marked superseded');
cl = (await call('GET', `/api/patients/${pid}/care-plan/checklist`, cg)).j;
const d8 = cl.medicines.doses.find((d) => d.medication.id === med2.id && d.slot === '08:00');
ok(d8 && d8.status === 'unknown' && d8.report.reportedForPrevious, "today's 08:00 dose reported under the old record stays reported (not asked again)");
ok(cl.medicines.doses.some((d) => d.medication.id === med2.id && d.slot === '21:00') && !cl.medicines.doses.some((d) => d.slot === '20:00' && d.medication.id === med.id), 'the schedule follows the new record (21:00, not 20:00)');
ok((await call('POST', `/api/patients/${pid}/medications/${med2.id}/stop`, ana, { reason: 'x' })).s === 422, 'stopping needs the reason and who ordered it (422)');

// ---------------------------------------------------------------- 4. missing data
let item = cl.items.find((i) => i.taskId === bpTask.id);
// (On a repeat run the same day, the report made under the version it replaces is carried over and labelled.)
ok(item && (item.completion ? item.completion.reportedUnderVersion === true : ['pending', 'overdue'].includes(item.status)), `an unreported measurement is ${item && item.status}, not done`);
ok((await call('POST', `/api/care/tasks/${bpTask.id}/completions`, cg, { measurementStatus: 'recorded' })).s === 422, 'recorded without a reading is refused (422)');
ok((await call('POST', `/api/care/tasks/${bpTask.id}/completions`, cg, { measurementStatus: 'recorded', reading: { systolic: 80, diastolic: 120 } })).s === 422, 'an impossible reading is refused (422)');
r = await call('POST', `/api/care/tasks/${bpTask.id}/completions`, cg, { measurementStatus: 'no_device', reason: 'BP monitor battery flat', planVersion: draft.version });
const noDevice = r.j;
ok(r.s === 201 && r.j.status === 'not_done' && r.j.measurementStatus === 'no_device', 'no device is recorded as not done, with the reason');
let att = (await call('GET', `/api/patients/${pid}/care-reports`, ana)).j;
ok(att.items.some((i) => i.id === noDevice.id && i.flags.includes('no_device')) && att.items.some((i) => i.type === 'medication' && i.flags.includes('unknown')),
  'missing reading and unknown dose wait for a nurse in the review list');
const bathTask = plan.tasks.find((t) => t.title === 'Help with bathing');
// Offline: the phone still showed another version when the caregiver recorded this.
r = await call('POST', `/api/care/tasks/${bathTask.id}/completions`, cg, { status: 'done', planVersion: draft.version + 1, recordedAt: new Date(Date.now() - 3600000).toISOString() });
ok(r.s === 201 && r.j.versionMismatch === true && r.j.seenPlanVersion === draft.version + 1, 'a report made on a different plan version (offline) is kept as reported and flagged');

// ---------------------------------------------------------------- 5. review is not resolution
r = await call('POST', `/api/patients/${pid}/concerns`, cg, { category: 'medicine', description: 'She may not have swallowed the morning tablet.', related: { medicationReportId: firstReport.id } });
const concern = r.j;
ok(r.s === 201 && concern.status === 'open', `caregiver reports a concern (${concern.id})`);
ok((await call('POST', `/api/patients/${pid}/concerns`, fam, { category: 'other', description: 'test' })).s === 403, 'family cannot report or read concerns (403)');
ok((await call('POST', `/api/care-reports/medication/${firstReport.id}/review`, ana, { note: '' })).s === 422, 'a review needs what was assessed and done (422)');
r = await call('POST', `/api/care-reports/medication/${firstReport.id}/review`, ana, { note: 'Called caregiver; observe and recheck tomorrow.' });
ok(r.s === 200, 'nurse reviews the dose report');
ok((await call('POST', `/api/care-reports/medication/${firstReport.id}/review`, ana, { note: 'again' })).s === 409, 'a report is reviewed once (409)');
await call('POST', '/api/checkins', cg, { patientId: pid, dataOrigin: 'demo', vitals: { systolic: 122, diastolic: 78, heartRate: 70, temperatureC: 36.6, spo2: 98 }, medication: { taken: true } });
await call('POST', `/api/care/tasks/${bathTask.id}/completions`, cg, { status: 'done' });
let cc = (await call('GET', `/api/patients/${pid}/concerns`, ana)).j.concerns.find((x) => x.id === concern.id);
ok(cc.status === 'open', 'the concern stays open after the review, a normal check-in and a completed task');
ok((await call('POST', `/api/clinic/concerns/${concern.id}/resolve`, ana, { assessment: 'ok' })).s === 422, 'resolving needs an assessment and the action taken (422)');
ok((await call('POST', `/api/clinic/concerns/${concern.id}/acknowledge`, carla, {})).s === 403, "a nurse who is not on the elder's team cannot act on the concern (403)");
ok((await call('POST', `/api/clinic/concerns/${concern.id}/acknowledge`, ana, { note: 'Seen' })).s === 200, 'nurse acknowledges the concern');

// ---------------------------------------------------------------- 6. handover continuity
const second = (await call('POST', `/api/patients/${pid}/concerns`, cg, { category: 'fall', description: 'Near fall in the bathroom this morning.' })).j;
care = (await call('GET', `/api/clinic/patients/${pid}/care`, ana)).j;
const holder = care.caseNurse.id;
const [fromTok, toId, toTok] = holder === 'U-CS-001' ? [ana, 'U-CS-002', ben] : [ben, 'U-CS-001', ana];
const due = new Date(Date.now() + 3600000).toISOString();
r = await call('POST', '/api/clinic/handover', fromTok, { patientId: pid, toNurseId: toId, concern: 'Possible missed dose; near fall', actionTaken: 'Called caregiver', pendingAction: 'Recheck tomorrow morning', dueTime: due });
const h = r.j && r.j.handover;
ok(r.s === 201 && h.openItems.length >= 2, `handover carries the open concerns (${h && h.openItems.length})`);
r = await call('POST', `/api/clinic/handover/${h.id}/accept`, toTok, {});
ok(r.s === 422 && r.j.error === 'acknowledge_open_items', 'the incoming nurse must acknowledge the open concerns to accept (422)');
r = await call('POST', `/api/clinic/handover/${h.id}/accept`, toTok, { acknowledgeOpenItems: true });
ok(r.s === 200 && r.j.handover.openItemsAcknowledged === true && r.j.caseNurse.id === toId, 'accepted with acknowledgement; the case moved');
cc = (await call('GET', `/api/patients/${pid}/concerns`, toTok)).j.concerns.find((x) => x.id === second.id);
ok(cc.status === 'open' && cc.events.some((e) => e.event === 'handed_over'), 'the concerns stay open and their history shows the handover');
ok((await call('GET', `/api/patients/${pid}/care-plan/checklist`, cg)).s === 200, "changing the nurse does not remove the caregiver's access");
ok((await call('GET', `/api/patients/${pid}/care-reports?view=all`, toTok)).j.items.some((i) => i.id === firstReport.id && i.review), 'care history and reviews are still there for the incoming nurse');
ok((await call('POST', `/api/clinic/concerns/${second.id}/resolve`, toTok, { assessment: 'No injury; bathroom mat added', actionTaken: 'Home visit booked; caregiver shown safe transfer' })).j.status === 'resolved', 'the incoming nurse resolves a concern with assessment and action');
ok((await call('POST', `/api/clinic/concerns/${second.id}/resolve`, toTok, { assessment: 'again', actionTaken: 'again' })).s === 409, 'a resolved concern cannot be resolved again (409)');
// hand the case back so repeated runs start the same way
const back = (await call('POST', '/api/clinic/handover', toTok, { patientId: pid, toNurseId: holder, concern: 'Test hand-back', actionTaken: 'None', pendingAction: 'None', dueTime: due })).j.handover;
await call('POST', `/api/clinic/handover/${back.id}/accept`, fromTok, { acknowledgeOpenItems: true });
await call('POST', `/api/clinic/concerns/${concern.id}/resolve`, holder === 'U-CS-001' ? ana : ben, { assessment: 'Test concern', actionTaken: 'Closed by the test' });
await call('POST', `/api/patients/${pid}/medications/${med2.id}/stop`, ana, { reason: 'End of test', source: order });

// ---------------------------------------------------------------- family summary
// Family accounts are linked to an elder only through family verification, so this uses the demo family's elder.
const fs = (await call('GET', '/api/patients/P-1001/care-plan', fam)).j;
ok(fs.summary && !fs.active && !fs.draft && !JSON.stringify(fs).includes('verification') && fs.tasks.every((t) => t.instructions === undefined),
  `family sees a summary of the active plan (no drafts, sources, verification or instructions)${fs.summary ? '' : ` - got ${JSON.stringify(fs).slice(0, 200)}`}`);
ok((await call('POST', `/api/care/tasks/${fs.tasks[0].id}/completions`, fam, { status: 'done' })).s === 403, 'family cannot submit or edit caregiver reports (403)');
ok((await call('GET', '/api/patients/P-1001/care-plan/versions', fam)).s === 403, 'family cannot see plan versions (403)');

console.log(`\nCare plan tests: ${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);

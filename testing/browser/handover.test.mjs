// Browser test: nurse handover end to end in the phone UI.
// Ana sends the P-1001 case to Ben from the patient screen -> Ben sees it under Pending handover -> taps
// Accept case -> it moves to Ben's My cases and leaves Ana's. Clean-up hands the case back through the API.
import { launch, harness, api, token, sleep } from './cdp.mjs';

const PATIENT = 'P-1001';
const NAME = 'Lola Remedios Dela Cruz';

/** Make sure Ana holds the case and no handover is pending (the test can be re-run). */
async function reset(ana, ben) {
  for (const [t] of [[ana], [ben]]) {
    for (const h of (await api('GET', '/api/clinic/queue/pending-handovers', t)).j.outgoing) await api('POST', `/api/clinic/handover/${h.id}/cancel`, t, {});
  }
  const care = (await api('GET', `/api/clinic/patients/${PATIENT}/care`, ana)).j;
  if (care.caseNurse.id !== 'U-CS-001') {
    const holder = care.caseNurse.id === 'U-CS-002' ? ben : null;
    if (!holder) throw new Error(`unexpected case holder ${care.caseNurse.id}`);
    const h = (await api('POST', '/api/clinic/handover', holder, { patientId: PATIENT, toNurseId: 'U-CS-001', concern: 'Test reset', actionTaken: 'Test reset', pendingAction: 'Test reset', dueTime: new Date(Date.now() + 3600000).toISOString() })).j.handover;
    await api('POST', `/api/clinic/handover/${h.id}/accept`, ana, {});
  }
}

export default async function run({ shots } = {}) {
  const { check, result } = harness('nurse handover');
  const ana = await token('nurse.ana');
  const ben = await token('nurse.ben');
  await reset(ana, ben);
  const page = await launch();
  try {
    // Outgoing nurse fills in the handover form
    await page.login('nurse.ana');
    await page.goto(`/m/nurse/patients/${PATIENT}`);
    check(await page.waitFor('Hand over this case'), 'Ana (case nurse) sees "Hand over this case" on the patient screen');
    await page.click('Hand over this case');
    check(await page.waitFor('Hand over to'), 'handover form opens');
    await page.click('Ben Lim, RN');
    await page.type('textarea', 'BP 172/104 this afternoon, mild headache', 0);
    await page.type('textarea', 'Called the caregiver, advised rest and fluids', 1);
    await page.type('textarea', 'Recheck BP at 6 PM and call the caregiver back', 2);
    await page.click('In 2 hours');
    await page.click('Send handover');
    check(await page.waitFor('Sent by you, not accepted yet'), 'after sending, Ana sees it under "Sent by you, not accepted yet"');
    const pending = (await api('GET', '/api/clinic/my-cases', ana)).j.cases.some((c) => c.patient.id === PATIENT);
    check(pending, 'while pending, the case still belongs to Ana');

    // Incoming nurse: pending handovers list, accept button, case moves to My cases
    await page.login('nurse.ben');
    await page.goto('/m/nurse');
    check(await page.waitFor({ expr: "!!document.querySelector('.m-badge')" }), 'Ben sees a badge on the Handover tab');
    await page.click('Handover');
    check(await page.waitFor('Waiting for you') && await page.waitFor(NAME), 'Ben\'s Pending handover list shows the case');
    check((await page.text()).includes('Recheck BP at 6 PM'), 'the card shows what is still to do');
    if (shots) await page.screenshot(`${shots}/handover-pending.png`);
    await page.click('Accept case');
    check(await page.waitFor('Case accepted'), 'accepting shows a confirmation');
    await page.click('My cases');
    check(await page.waitFor(NAME), 'the case is now in Ben\'s My cases');
    if (shots) await page.screenshot(`${shots}/handover-my-cases.png`);

    await page.login('nurse.ana');
    await page.goto('/m/nurse?tab=mine');
    await page.waitFor('Cases you hold');
    await sleep(800);
    check(!(await page.text()).includes(NAME), 'and no longer in Ana\'s My cases');
  } finally {
    await page.close();
    await reset(ana, ben);
  }
  return result();
}

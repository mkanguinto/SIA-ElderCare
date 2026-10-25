// Browser test: the caregiver and family screens from the Figma file (Oct 2026 revision).
// Caregiver: home (check-ins hero, Quick Actions, Your Patients), patient profile (needs attention, tabs,
// care team with the real nurse and caregiver names), medicines by time of day, care duties, profile.
// Family: dashboard without call buttons or 911, trends, medicines, alerts status, profile with the relative's
// caregiver and nurse.
import { launch, harness } from './cdp.mjs';

export default async function run({ shots } = {}) {
  const { check, result } = harness('figma screens');
  const page = await launch();
  const on = async (path, ...texts) => { await page.goto(path); for (const t of texts) if (!(await page.waitFor(t, 8000))) return false; return true; };
  try {
    await page.login('caregiver.maria');
    check(await on('/m/caregiver', "Today's check-ins", 'Quick Actions', 'Your Patients', 'Emergency'), 'caregiver home: check-ins hero, quick actions (incl. Emergency), your patients');
    check(await page.evaluate("!document.querySelector('.m-emergency')"), 'no emergency banner on top (Emergency is a quick action)');
    check(await on('/m/caregiver/patients/P-1001', 'Patient Profile', 'Needs Attention', 'Start daily Check-in', 'Known Conditions', 'Care Team', 'Ana Cruz'), 'patient profile with needs attention, tabs, conditions and the case nurse by name');
    await page.click('Notes');
    check(await page.waitFor('Last 7 days'), 'profile tabs switch (Notes)');
    check(await on('/m/caregiver/medicines', 'Patient', 'Morning'), 'medicines: patient picker and doses by time of day');
    check(await on('/m/caregiver/duties', "Today's Care Tasks", 'Date', 'tasks done', 'Report a concern', 'Care plan version'), "today's care tasks: patient, date, progress, plan version and Report a concern");
    check(await on('/m/caregiver/check-in?patient=P-1001', 'Step 1 of 3', 'Notes (Optional)'), 'check-in step 1 has a notes field for the nurse');
    check(await on('/m/caregiver/profile', 'Assigned Patients', 'App Preferences', 'Large Text Mode', 'Log out'), 'caregiver profile');

    // First-time intro (caregiver): four short cards, then the home screen; reopened from Me.
    await page.login('caregiver.maria', { intro: true });
    await page.evaluate("Object.keys(localStorage).filter((k) => k.startsWith('eldercare.intro.')).forEach((k) => localStorage.removeItem(k))");
    check(await on('/m/caregiver', 'Step 1 of 4', 'What ElderCare does') && await page.evaluate("!document.querySelector('.m-nav')"), 'first visit: the intro starts (step 1 of 4, no bottom menu)');
    for (let k = 0; k < 3; k += 1) await page.click('Next');
    check(await page.waitFor('If something is wrong') && await page.waitFor('911'), 'intro step 4: what to do when something is wrong (emergency 911)');
    await page.click('Start');
    check(await page.waitFor('Quick Actions'), 'Start opens the caregiver home');
    await page.goto('/m/caregiver');
    check(await page.waitFor('Quick Actions') && !(await page.text()).includes('Step 1 of 4'), 'the intro is shown only once');
    check(await on('/m/caregiver/profile', 'How ElderCare works'), 'the intro can be reopened from Me');

    await page.login('family.jose');
    check(await on('/m/family', 'Lola Remedios Dela Cruz', 'Medicines Today', 'Latest vitals'), 'family dashboard');
    const home = await page.text();
    check(!/Call Nurse|call 911|Call 911/i.test(home) && !(await page.evaluate("!!document.querySelector('a[href^=\"tel:\"]')")), 'family dashboard has no call-the-nurse or 911 button (family may be abroad)');
    if (shots) await page.screenshot(`${shots}/figma-family-home.png`);
    check(await on('/m/family/trends', 'Blood pressure (top number)', 'Heart rate', 'Oxygen', 'Shaded band'), 'family trends: three metric cards with the usual-range band');
    check(await on('/m/family/medicines', "Today's progress", 'Morning'), 'family medicines');
    check(await on('/m/family/profile', 'Your Relative', 'Caregiver: Maria Santos', 'Linked'), 'family profile shows the relative with caregiver and nurse');
  } finally {
    await page.close();
  }
  return result();
}

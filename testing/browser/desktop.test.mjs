// Browser test: the nurse desktop console (/clinic) and the admin console use the phone design in a web layout.
// Every nurse page loads in the sidebar layout, links stay inside /clinic, and the patient page shows the phone
// patient screen beside the clinic records; the admin's alert rules are inside the admin console.
import { launch, harness, sleep } from './cdp.mjs';

const PAGES = [
  ['/clinic', 'Needs action now', 'risk queue (phone queue with My cases / Handover tabs)'],
  ['/clinic/reviews', 'Check-ins to review', 'check-in reviews'],
  ['/clinic/messages', 'Messages from families', 'family messages'],
  ['/clinic/patients', 'Patients', 'patient list'],
  ['/clinic/visits', 'Scheduled visits', 'visits'],
  ['/clinic/history', 'Case history', 'case history'],
  ['/clinic/digest', 'Daily digest', 'daily digest'],
  ['/clinic/alert-rules', 'Alert rules', 'alert rules'],
];

export default async function run({ shots } = {}) {
  const { check, result } = harness('desktop consoles');
  const page = await launch({ width: 1440, height: 1000 });
  try {
    await page.login('nurse.ana');
    for (const [p, text, label] of PAGES) {
      await page.goto(p);
      const ok = await page.waitFor(text) && await page.evaluate("!!document.querySelector('.ad-app.ad-clinic .ad-side') && !document.querySelector('.m-bottomnav, .m-nav')");
      check(ok, `nurse desktop: ${label} in the sidebar layout`);
    }
    await page.goto('/clinic');
    await page.waitFor('Needs action now');
    const href = await page.evaluate("[...document.querySelectorAll('.ad-main a.m-list-row')].map((a) => a.getAttribute('href')).find((h) => h && h.includes('/patients/'))");
    check(href && href.startsWith('/clinic/patients/'), `queue rows open the desktop patient page (${href})`);
    await page.goto('/clinic/patients/P-1001');
    check(await page.waitFor('Overview & Clinical Data') && await page.waitFor('Blood pressure, last 30 days') && await page.waitFor('Recent check-ins'), 'patient case: overview tab (why this priority, blood pressure, recent check-ins)');
    await page.click('Care Plan & Medications', '.ad-tabs');
    check(await page.waitFor('Prescribed medicines') && await page.waitFor("Today's tasks") && await page.waitFor('Versions and change history'), 'patient case: care plan & medications tab (medicines, plan versions, today)');
    if (shots) await page.screenshot(`${shots}/desktop-patient.png`);
    const radius = await page.evaluate("getComputedStyle(document.querySelector('.panel')).borderRadius");
    check(parseFloat(radius) >= 16, `desktop-only panels take the phone look (radius ${radius})`);
    await page.click('Care Team & System Settings', '.ad-tabs');
    check(await page.waitFor('SMS alert contacts') && await page.waitFor('Legacy clinic records'), 'patient case: care team & system settings tab');
    check(await page.evaluate("document.querySelector('.ad-profile').innerText.includes('nurse.ana')"), 'sidebar profile card shows the username');
    // Ana leads Team A: the team-lead tools appear in her console.
    check(await page.waitFor('Team lead') && await page.evaluate("[...document.querySelectorAll('.ad-sep')].some((e) => e.textContent === 'Operations')"), 'team-lead nurse: Team lead and Operations sections in the sidebar');
    await page.goto('/clinic/elders');
    check(await page.waitFor('Add a new elder') && await page.waitFor('Elders'), 'team-lead nurse: registers and links elders');
    await page.goto('/clinic/accounts');
    check(await page.waitFor('New account') && !(await page.evaluate("[...document.querySelectorAll('select option')].some((o) => o.value === 'clinic_staff')")), 'team-lead nurse: creates caregiver and family accounts only');

    await page.login('admin.harold');
    await page.goto('/admin/alert-rules');
    check(await page.waitFor('Alert rules') && await page.evaluate("!!document.querySelector('.ad-app .ad-side')"), 'admin: alert rules inside the admin console');
    await page.goto('/admin/care-teams');
    check(await page.waitFor('Team Roster & Elders') && await page.waitFor('Add Nurse'), 'admin: care teams roster tab');
    await page.click('Link & Assignments', '.ad-tabs');
    check(await page.waitFor('Add a new elder') && await page.waitFor('Register elder') && await page.waitFor('Elder missing from the list above'), 'admin: link & assignments tab registers a new elder (patient number only as a fallback)');
    check(await page.evaluate("[...document.querySelectorAll('.ad-elders th')].some((th) => th.textContent === 'Caregiver') && !!document.querySelector('select[aria-label^=\"Link a caregiver\"]')"), 'admin: each elder row links a caregiver');
    check(await page.evaluate("[...document.querySelectorAll('.ad-elders th')].some((th) => th.textContent === 'Family') && !!document.querySelector('select[aria-label^=\"Link a family member\"]')"), 'admin: each elder row links a family member (with family verification)');
    await page.click('Create New Team');
    check(await page.waitFor({ expr: "!!document.querySelector('.ad-drawer [role=dialog], .ad-drawer')" }) && await page.waitFor('New care team'), 'admin: Create New Team opens the drawer');
    await page.goto('/admin/users');
    check(await page.waitFor('New account') && !(await page.text()).includes('Elder IDs'), 'admin: new accounts do not ask for elder IDs');
    check(!(await page.text()).includes('Digest export'), 'admin: no digest export page in the menu');
    await page.goto('/clinic');
    await sleep(800);
    check(await page.evaluate("location.pathname.startsWith('/admin')"), 'admin cannot open the nurse console (patient data)');
  } finally {
    await page.close();
  }
  return result();
}

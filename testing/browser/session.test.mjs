// Browser test: inactivity warning, lock screen and unsent drafts (Batch 3a review).
// A caregiver starts a check-in -> the timeout warning counts down with "Stay signed in" -> the app locks ->
// the password unlocks it and the entry is still in the form -> signing in on another device ends this
// session, the sign-in page says the entry was kept -> signing in again brings it back -> another user
// signing in on the same tab never sees it.
// The idle limit is shortened for the test by editing the stored session before the page loads (the server
// still uses the real 30-minute limit).
import { launch, harness, api, PASSWORD, sleep } from './cdp.mjs';

const USER = 'caregiver.maria';
const value = (page) => page.evaluate("(document.querySelector('#vital-heartRate') || {}).value");

/** Signs in like page.login (intro marked as seen), but keeps the rest of sessionStorage (drafts) and sets a short idle limit. */
async function signIn(page, username, idleLockMinutes) {
  const ok = await page.evaluate(`fetch('/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'password',username:${JSON.stringify(username)},password:${JSON.stringify(PASSWORD)},device:'phone'})})
    .then(r=>r.json()).then(d=>{sessionStorage.setItem('eldercare.session',JSON.stringify({accessToken:d.access_token,refreshToken:d.refresh_token,idleLockMinutes:${idleLockMinutes}}));
      try{localStorage.setItem('eldercare.intro.'+JSON.parse(atob(d.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sub,'done')}catch(e){}
      return !!d.access_token})`);
  if (!ok) throw new Error(`login failed for ${username}`);
}

export default async function run({ shots } = {}) {
  const { check, result } = harness('session lock and drafts');
  const page = await launch();
  try {
    await page.goto('/');
    await page.evaluate('sessionStorage.clear()');
    await signIn(page, USER, 0.12); // ~7 seconds: the warning shows at once, the lock follows
    await page.goto('/m/caregiver/check-in');
    check(await page.waitFor({ expr: "!!document.querySelector('#vital-heartRate')" }), 'check-in form opens');
    await page.type('#vital-heartRate', '88');
    await sleep(300);
    check(await page.evaluate("JSON.parse(sessionStorage.getItem('eldercare.drafts') || '{}').owner === 'U-CG-001'"), 'the unsent entry is kept as a draft for this user only');

    // Timeout warning with a countdown and "Stay signed in"
    check(await page.waitFor('Still there?', 4000), 'a warning appears before the lock');
    check((await page.text()).includes('Anything you have not sent is kept'), 'the warning says unsent entries are kept');
    if (shots) await page.screenshot(`${shots}/session-warning.png`);
    await page.click('Stay signed in');
    const after = await page.evaluate("(document.querySelector('.m-idle-warn strong') || {}).innerText || 'gone'");
    check(after === 'gone' || after >= '0:06', `"Stay signed in" restarts the countdown (${after})`);

    // Lock, then unlock with the password: the entry is still there
    check(await page.waitFor({ expr: "!!document.querySelector('.m-lock')" }, 12000), 'with no activity the app locks');
    check((await page.text()).includes('unsent entry is kept'), 'the lock screen says the unsent entry is kept');
    if (shots) await page.screenshot(`${shots}/session-locked.png`);
    await page.type('.m-lock input[type=password]', PASSWORD);
    await page.click('Unlock', '.m-lock');
    check(await page.waitFor({ expr: "!document.querySelector('.m-lock')" }), 'the password unlocks the same session');
    check(await value(page) === '88', 'the typed heart rate is still in the form after unlocking');

    // Signing in on another device ends this session; the entry survives and comes back after signing in again
    await api('POST', '/oauth/token', null, { grant_type: 'password', username: USER, password: PASSWORD, device: 'phone' });
    await page.goto('/m/caregiver');
    check(await page.waitFor('signed in on another device'), 'this phone is signed out with "You signed in on another device"');
    check((await page.text()).includes('unsent entries are kept'), 'the sign-in page says the unsent entry was kept');
    await signIn(page, USER, 30);
    await page.goto('/m/caregiver');
    check(await page.waitFor('not sent yet'), 'after signing in again, Home offers to continue the unsent check-in');
    await page.click('Continue it');
    check(await page.waitFor('was kept. It has not been sent yet'), 'the check-in shows the restored entry, clearly not sent');
    check(await value(page) === '88', 'the restored entry has the typed heart rate');
    if (shots) await page.screenshot(`${shots}/session-draft-restored.png`);

    // Another user signing in on this tab never sees it
    await page.evaluate("import('/src/api.js').then((m) => m.login('nurse.ana', " + JSON.stringify(PASSWORD) + '))');
    check(await page.evaluate("sessionStorage.getItem('eldercare.drafts') === null"), "another user's sign-in drops the first user's drafts");
  } finally {
    await page.close();
  }
  return result();
}

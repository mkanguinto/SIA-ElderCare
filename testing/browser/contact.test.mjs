// Browser test: family contacts the clinic, the nurse answers, and the family sees the proof.
// Jose (family of P-1001) opens Contact the clinic from Today, picks a reason, asks for a call back and sends a
// message -> gets a CR- reference -> Ana sees it in Messages, marks it seen and replies -> Jose sees
// "Seen by Ana" and her reply with times.
import { launch, harness } from './cdp.mjs';

export default async function run({ shots } = {}) {
  const { check, result } = harness('contact the clinic');
  const page = await launch();
  const note = `Browser test ${Date.now().toString(36)}: Lola felt dizzy after lunch`;
  try {
    await page.login('family.jose');
    await page.goto('/m/family');
    check(await page.waitFor('Contact the clinic'), 'family Today has "Contact the clinic"');
    await page.click('Contact the clinic');
    check(await page.waitFor('What is it about?'), 'opens the contact screen (no pop-up)');
    check((await page.text()).includes('For an emergency call 911'), 'shows the clinic number or says it is not set up, and the emergency number');
    await page.click('Worried about their condition');
    await page.type('textarea', note);
    await page.click('Send message');
    check(await page.waitFor('Recorded as CR-'), 'sending gives a reference number and time');
    const text = await page.text();
    check(/SMS notice (delivered|sent|waiting|NOT sent)/.test(text), 'says honestly what happened to the SMS notice to the clinic phone');
    if (shots) await page.screenshot(`${shots}/contact-family-sent.png`);
    const id = text.match(/Recorded as (CR-\d+)/)[1];

    await page.login('nurse.ana');
    await page.goto('/m/nurse');
    check(await page.waitFor('from families'), 'the nurse queue shows a "messages from families" banner');
    await page.goto('/m/nurse/messages');
    check(await page.waitFor(note), 'the message is in the nurse\'s Messages');
    await page.evaluate(`(() => { const card = [...document.querySelectorAll('article')].find((a) => a.innerText.includes(${JSON.stringify(id)})); card.setAttribute('data-test', 'it'); })()`);
    await page.click('Mark seen', '[data-test=it]');
    check(await page.waitFor({ expr: `[...document.querySelectorAll('article')].some((a) => a.innerText.includes(${JSON.stringify(id)}) && a.innerText.includes('Seen by You'))` }), 'marked seen, with the nurse and time');
    await page.evaluate(`(() => { const card = [...document.querySelectorAll('article')].find((a) => a.innerText.includes(${JSON.stringify(id)})); card.setAttribute('data-test', 'it'); })()`);
    await page.click('Reply', '[data-test=it]');
    await page.type('[data-test=it] textarea', 'I will call you at 3 PM. Let her rest and recheck BP in 30 minutes.');
    await page.click('Send reply', '[data-test=it]');
    await page.goto('/m/nurse/messages');
    if (shots) await page.screenshot(`${shots}/contact-nurse-inbox.png`);

    await page.login('family.jose');
    await page.goto('/m/family/contact');
    check(await page.waitFor('I will call you at 3 PM'), 'the family sees the nurse\'s reply');
    check((await page.text()).includes('Seen by Ana Cruz, RN'), 'and who saw it, with the time');
    if (shots) await page.screenshot(`${shots}/contact-family-answered.png`);
  } finally {
    await page.close();
  }
  return result();
}

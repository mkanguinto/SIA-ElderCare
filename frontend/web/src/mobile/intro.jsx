// First-time intro for caregivers and family: four short cards on what ElderCare does and what the person does
// in it. Shown once per account on this phone (a per-device convenience, so it is kept in localStorage), and
// again any time from Me -> "How ElderCare works".
import React, { useState } from 'react';
import Icon from './icons';
import { useT, EMERGENCY_PHONE } from './kit';

const key = (userId) => `eldercare.intro.${userId}`;
export function introSeen(userId) {
  try { return localStorage.getItem(key(userId)) === 'done'; } catch { return true; }
}
function markSeen(userId) {
  try { localStorage.setItem(key(userId), 'done'); } catch { /* shown again next time: harmless */ }
}

const STEPS = {
  caregiver: [
    ['heart', ['What ElderCare does', 'Ano ang ElderCare'],
      ['You record how your elder is each day. A nurse at the health center watches the readings and follows up when something looks wrong.',
        'Itinatala mo ang kalagayan ng iyong inaalagaan araw-araw. Binabantayan ito ng nars sa health center at kumikilos kapag may mali.']],
    ['clipboard', ['Do the daily check-in', 'Gawin ang araw-araw na check-in'],
      ['Once a day: blood pressure, pulse and temperature, which medicines were given, and how they feel. No device? Say so; never guess a number.',
        'Isang beses araw-araw: presyon, pulso, temperatura, mga gamot na naibigay at ang pakiramdam. Walang gamit? Sabihin; huwag manghula ng numero.']],
    ['checkCircle', ["Follow today's tasks", 'Sundin ang mga gawain ngayon'],
      ['The nurse writes a care plan. Under Duties, tick each task when done, or say why it was skipped.',
        'Gumagawa ang nars ng care plan. Sa Duties, i-tsek ang bawat gawain kapag tapos, o sabihin kung bakit hindi nagawa.']],
    ['alert', ['If something is wrong', 'Kung may mali'],
      [`High readings alert the nurse and the family by themselves. Use Call clinic for questions. In an emergency, call ${EMERGENCY_PHONE} first.`,
        `Kusang naaabisuhan ang nars at pamilya kapag mataas ang sukat. Gamitin ang Call clinic sa mga tanong. Sa emergency, tumawag muna sa ${EMERGENCY_PHONE}.`]],
  ],
  family_member: [
    ['heart', ['What ElderCare does', 'Ano ang ElderCare'],
      ['See how your loved one is doing from anywhere: the caregiver checks in every day and a nurse at the health center follows up.',
        'Makita ang kalagayan ng mahal mo saan ka man: araw-araw nagche-check-in ang tagapag-alaga at sinusubaybayan ng nars sa health center.']],
    ['pulse', ['Today at a glance', 'Ngayong araw'],
      ["Home shows today's check-in, the medicines given and the care tasks done. Trends shows the last weeks.",
        'Makikita sa Home ang check-in ngayon, mga gamot na naibigay at mga gawaing natapos. Nasa Trends ang mga nakaraang linggo.']],
    ['bell', ['Alerts that explain themselves', 'Mga alertong may paliwanag'],
      ['When a reading is risky you get an alert (and an SMS if your number is listed), with why you are seeing it.',
        'Kapag delikado ang sukat, makakatanggap ka ng alerto (at SMS kung nakalista ang numero mo), kasama kung bakit.']],
    ['phone', ['Talk to the clinic', 'Kausapin ang klinika'],
      ['Contact the clinic sends a message or starts a call, and you see when a nurse read it and replied. The caregiver with your elder handles emergencies on the spot.',
        'Sa Contact the clinic, magpadala ng mensahe o tumawag, at makikita mo kung nabasa at sinagot ng nars. Ang tagapag-alaga na kasama ng iyong mahal sa buhay ang kikilos sa emergency.']],
  ],
};

/** The intro cards. onDone runs after "Start" or "Skip"; the cards are then marked as seen for this account. */
export function Intro({ user, onDone }) {
  const tr = useT();
  const steps = STEPS[user.role] || STEPS.caregiver;
  const [i, setI] = useState(0);
  const finish = () => { markSeen(user.id); onDone(); };
  const [icon, title, body] = steps[i];
  const last = i === steps.length - 1;
  return (
    <section className="m-intro" aria-labelledby="intro-title">
      <div className="m-between">
        <span className="m-caption">{tr(`Step ${i + 1} of ${steps.length}`, `Hakbang ${i + 1} sa ${steps.length}`)}</span>
        {!last && <button type="button" className="m-link" onClick={finish}>{tr('Skip', 'Laktawan')}</button>}
      </div>
      <span className="m-intro-icon" aria-hidden="true"><Icon name={icon} size={40} /></span>
      <h1 id="intro-title">{tr(...title)}</h1>
      <p>{tr(...body)}</p>
      <div className="m-intro-dots" aria-hidden="true">{steps.map((s, j) => <span key={s[1][0]} className={j === i ? 'is-on' : ''} />)}</div>
      <div className="m-intro-actions">
        {i > 0 && <button type="button" className="m-btn is-soft" onClick={() => setI(i - 1)}>{tr('Back', 'Bumalik')}</button>}
        <button type="button" className="m-cta is-green" onClick={() => (last ? finish() : setI(i + 1))}>{last ? tr('Start', 'Magsimula') : tr('Next', 'Susunod')}</button>
      </div>
    </section>
  );
}

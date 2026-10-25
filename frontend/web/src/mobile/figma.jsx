// Building blocks of the caregiver and family screens from the Figma file "ElderCare Connect – Phone-First UI"
// (page "All": Caregiver and Family frames): white page, grey cards for people, a patient picker with a
// dropdown, green status badges, week dots, round quick actions and the preference rows of the profile.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { initials } from '../format';
import Icon from './icons';
import { weekDays } from './plan';
import { useT, usePrefs } from './kit';
import dropdownIcon from '../assets/figma/dropdown.svg';
import sirenIcon from '../assets/figma/emergency-siren.svg';
import exclamationIcon from '../assets/figma/exclamation.svg';

export { sirenIcon, exclamationIcon };

const nameInitials = (name = '') => initials(name.replace(/^(Lola|Lolo) /, ''));

export function Avatar({ name, size }) {
  return <span className="m-avatar" aria-hidden="true" style={size ? { width: size, height: size } : undefined}>{nameInitials(name)}</span>;
}

/**
 * Grey patient card with a dropdown: the elder the screen is about. With more than one elder the whole card
 * is a native select (screen readers and big text work as usual).
 */
export function PatientPicker({ patients, value, onChange, label }) {
  const tr = useT();
  const current = patients.find((p) => p.id === value) || patients[0];
  if (!current) return null;
  const many = patients.length > 1;
  return (
    <div className={`m-picker ${many ? 'is-select' : ''}`}>
      <Avatar name={current.name} />
      <span className="m-grow"><strong>{current.name}</strong>{current.sub && <span className="m-sub">{current.sub}</span>}</span>
      {many && (
        <>
          <img src={dropdownIcon} width="33" height="33" alt="" aria-hidden="true" />
          <select className="m-picker-select" value={current.id} onChange={(e) => onChange(e.target.value)} aria-label={label || tr('Choose the elder', 'Pumili ng pasyente')}>
            {patients.map((p) => <option key={p.id} value={p.id}>{p.name}</option>)}
          </select>
        </>
      )}
    </div>
  );
}

/** Small solid badge: "All Normal", "Active", "Linked" (green), "Needs attention" (red), "Due now" (amber). */
export function Badge({ tone = 'ok', children }) {
  return <span className={`m-badge-solid tone-${tone}`}>{children}</span>;
}

/** Seven dots for the last seven days (filled = a check-in that day) and "N of 7 days this week". */
export function WeekDots({ checkins }) {
  const tr = useT();
  const days = weekDays(checkins);
  const n = days.filter((d) => d.done).length;
  return (
    <span className="m-weekdots" title={tr(`${n} of the last 7 days have a check-in`, `${n} sa huling 7 araw ay may check-in`)}>
      <span aria-hidden="true">{days.map((d) => <i key={d.day} className={d.done ? 'is-done' : ''} />)}</span>
      <span>{tr(`${n} of 7 days this week`, `${n} sa 7 araw ngayong linggo`)}</span>
    </span>
  );
}

/** Round light quick action with the label underneath. Pass `to` (in-app), `href` (tel:) or `onClick`. */
export function QuickAction({ icon, img, label, href, onClick, LinkComponent, to, danger }) {
  const inner = (
    <>
      <span className={`m-qa-icon ${danger ? 'is-danger' : ''}`}>{img ? <img src={img} width="19" height="23" alt="" aria-hidden="true" /> : <Icon name={icon} />}</span>
      {label}
    </>
  );
  if (to) return <LinkComponent to={to}>{inner}</LinkComponent>;
  if (href) return <a href={href}>{inner}</a>;
  return <button type="button" onClick={onClick}>{inner}</button>;
}

/** One preference row: icon, label, control on the right, line under it. */
export function PrefRow({ icon, label, children, last }) {
  return (
    <div className={`m-pref ${last ? 'is-last' : ''}`}>
      <Icon name={icon} size={22} />
      <span className="m-grow">{label}</span>
      {children}
    </div>
  );
}

/** EN | FIL toggle. */
export function LangToggle() {
  const { lang, setPrefs } = usePrefs();
  return (
    <span className="m-lang" role="group" aria-label="Language / Wika">
      <button type="button" aria-pressed={lang !== 'fil'} onClick={() => setPrefs({ lang: 'en' })}>EN</button>
      <button type="button" aria-pressed={lang === 'fil'} onClick={() => setPrefs({ lang: 'fil' })}>FIL</button>
    </span>
  );
}

/** "Switch" pill used for on/off preferences; shows On when on. */
export function SwitchPill({ on, onClick, label, disabled }) {
  const tr = useT();
  return (
    <button type="button" className={`m-switch ${on ? 'is-on' : ''}`} role="switch" aria-checked={Boolean(on)} aria-label={label} onClick={onClick} disabled={disabled}>
      {on ? tr('On', 'Bukas') : tr('Switch', 'Buksan')}
    </button>
  );
}

/** Who looks after an elder: {caregivers, family, caseNurse, careTeam} (names only). null while loading. */
export function usePeople(patientId) {
  const [people, setPeople] = useState(null);
  useEffect(() => {
    if (!patientId) return undefined;
    let live = true;
    api(`/api/patients/${encodeURIComponent(patientId)}/people`)
      .then((r) => live && setPeople(r))
      .catch(() => live && setPeople({ caregivers: [], family: [], caseNurse: null, careTeam: null }));
    return () => { live = false; };
  }, [patientId]);
  return people;
}

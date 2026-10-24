// Screens shared by the caregiver and family apps: alerts list, alert detail (F2), profile.
import React, { useEffect, useState } from 'react';
import { api, requestSignOut } from '../api';
import { Link, navigate } from '../router';
import { ROLE_LABEL, relTime } from '../format';
import Icon from './icons';
import { alertHeadline, explainAlert } from './data';
import { TopBar, Chip, Cta, Loader, usePrefs, useT, clock, isToday, TONE, shortName } from './kit';
import { Avatar, Badge, PrefRow, LangToggle, SwitchPill, usePeople } from './figma';

const SMS_WORD = {
  delivered: ['delivered', 'naihatid'], sent: ['sent', 'naipadala'], simulated: ['test mode, not really sent', 'test mode, hindi talaga naipadala'],
  failed: ['failed', 'hindi naipadala'], skipped: ['held back (daily limit)', 'pinigil (daily limit)'],
};
function smsText(sms, tr) {
  const counts = sms.reduce((acc, d) => ({ ...acc, [d.status]: (acc[d.status] || 0) + 1 }), {});
  return Object.entries(counts).map(([k, n]) => `${n} ${tr(...(SMS_WORD[k] || [k, k]))}`).join(' · ');
}

export function useNotifications(patientId, pageSize = 30) {
  const [state, setState] = useState(null);
  useEffect(() => {
    let live = true;
    const load = () => api(`/api/alerts/notifications?pageSize=${pageSize}${patientId ? `&patientId=${encodeURIComponent(patientId)}` : ''}`)
      .then((r) => live && setState(r.notifications))
      .catch(() => live && setState((s) => s || []));
    load();
    const t = setInterval(load, 30000);
    return () => { live = false; clearInterval(t); };
  }, [patientId, pageSize]);
  return state;
}

export function AlertsList({ base, patientNames = {}, back }) {
  const tr = useT();
  const { lang } = usePrefs();
  const list = useNotifications(null, 40);
  return (
    <>
      <TopBar title={tr('Alerts', 'Mga alerto')} back={back} />
      {!list && <Loader />}
      {list && list.length === 0 && <div className="m-note"><strong>{tr('No alerts', 'Walang alerto')}</strong>{tr('You will see an alert here and get a text if a reading needs attention.', 'Makikita mo rito ang alerto at makakatanggap ka ng text kung may sukat na dapat bantayan.')}</div>}
      <div className="m-stack">
        {(list || []).map((n) => {
          const h = alertHeadline(n);
          const tone = TONE[n.severity] || 'info';
          return (
            <Link key={n.id} to={`${base}/${n.id}`} className="m-list-row">
              <span className={`m-thumb tone-${tone === 'high' ? 'critical' : tone}`} aria-hidden="true"><Icon name={n.source === 'weather' ? 'zap' : 'alert'} /></span>
              <span className="m-grow">
                <strong>{lang === 'fil' && h.fil ? h.fil : h.title}{h.value ? ` · ${h.value}` : ''}</strong>
                <span className="m-sub">{patientNames[n.patientId] || n.patientId} · {isToday(n.createdAt) ? clock(n.createdAt) : relTime(n.createdAt)}</span>
              </span>
              <Icon name="chevron" />
            </Link>
          );
        })}
      </div>
    </>
  );
}

export function AlertDetail({ id, back }) {
  const tr = useT();
  const { lang } = usePrefs();
  const list = useNotifications(null, 60);
  const n = list && list.find((x) => x.id === id);
  const [patient, setPatient] = useState(null);
  const [visit, setVisit] = useState(undefined);
  useEffect(() => {
    if (!n) return;
    api(`/api/patients/${n.patientId}`).then(setPatient).catch(() => setPatient(null));
    api(`/api/patients/${n.patientId}/visits?view=upcoming`).then((r) => setVisit(r.visits[0] || null)).catch(() => setVisit(null));
  }, [n && n.patientId]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!list) return <><TopBar title={tr('Alert', 'Alerto')} back={back} /><Loader /></>;
  if (!n) return <><TopBar title={tr('Alert', 'Alerto')} back={back} /><div className="m-note">{tr('This alert is no longer available.', 'Wala na ang alertong ito.')}</div></>;

  const h = alertHeadline(n);
  const tone = TONE[n.severity] === 'ok' ? 'info' : TONE[n.severity];
  const name = patient ? shortName(patient.fullName) : n.patientId;
  const sms = (n.delivery || []).filter((d) => d.channel === 'sms');
  return (
    <>
      <TopBar title={tr('Alert', 'Alerto')} back={back} />
      <section className={`m-bp-hero tone-${tone}`} style={{ paddingBottom: '1.25rem' }}>
        <div className="m-row">
          <span className="m-icon-btn" aria-hidden="true" style={{ color: 'inherit' }}><Icon name="alert" /></span>
          <div>
            <h2 style={{ fontSize: '1.375rem' }}>{lang === 'fil' && h.fil ? h.fil : h.title}</h2>
            <p style={{ fontSize: '.875rem', fontWeight: 700 }}>{name} · {isToday(n.createdAt) ? `${tr('today', 'ngayon')} ${clock(n.createdAt)}` : relTime(n.createdAt)}</p>
          </div>
        </div>
        {h.value && <p className="m-bp-value" style={{ fontSize: '2.25rem' }}>{h.value}<small>{h.unit}</small></p>}
      </section>

      <section className="m-card" style={{ marginTop: '.75rem' }}>
        <h3 className="m-card-title m-row" style={{ gap: '.5rem' }}><Icon name="eye" size={20} />{tr('Why am I seeing this?', 'Bakit ko ito nakikita?')}</h3>
        <p className="m-muted" style={{ lineHeight: 1.55 }}>{explainAlert(n, patient)}</p>
      </section>

      <section className="m-card">
        <h3 className="m-card-title">{tr("What's being done", 'Ano ang ginagawa')}</h3>
        <ul className="m-steps-list">
          <li>
            <span style={{ color: 'var(--accent-ok)' }}><Icon name="checkCircle" /></span>
            <div><strong>{n.source === 'anomaly' || n.source === 'weather' ? tr('Clinic notified', 'Naabisuhan ang klinika') : tr('Alert recorded', 'Naitala ang alerto')}</strong>
              <span className="m-sub">{n.source === 'weather' ? tr('Weather risk added to the clinic queue', 'Idinagdag sa clinic queue ang panganib sa panahon') : tr(`${name} is in the clinic risk queue`, `Nasa clinic risk queue si ${name}`)}</span></div>
          </li>
          <li>
            <Icon name="message" />
            <div><strong>{sms.length ? tr(`Text sent to ${sms.length} contact${sms.length === 1 ? '' : 's'}`, `Na-text ang ${sms.length} contact`) : tr('Shown in the app', 'Ipinakita sa app')}</strong>
              <span className="m-sub">{sms.length ? smsText(sms, tr) : tr('In-app alert', 'Alerto sa app')}</span></div>
          </li>
          {visit !== undefined && (
            <li>
              <Icon name="calendar" />
              <div>{visit
                ? <><strong>{tr('Visit scheduled', 'May nakatakdang pagbisita')}</strong><span className="m-sub">{visit.destination} · {visit.visitDate} {visit.visitTime}</span></>
                : <><strong>{tr('Nurse reviewing', 'Sinusuri ng nars')}</strong><span className="m-sub">{tr('No visit booked yet', 'Wala pang nakatakdang pagbisita')}</span></>}</div>
            </li>
          )}
        </ul>
      </section>

      <div className="m-footer-actions">
        <CallClinic label={window.location.pathname.startsWith('/m/family') ? tr('Message the clinic', 'Magmensahe sa klinika') : undefined} />
      </div>
    </>
  );
}

/** Opens "Contact the clinic" (call or message, both recorded) in the current phone app (/m/family or /m/caregiver). */
export function CallClinic({ label }) {
  const tr = useT();
  const base = window.location.pathname.split('/').slice(0, 3).join('/');
  return <Cta onClick={() => navigate(`${base}/contact`)}>{label || tr('Contact the clinic', 'Makipag-ugnayan sa klinika')}</Cta>;
}

/** Names of the elders on an account (Profile: assigned patients / your relative). */
function useElderNames(ids) {
  const [list, setList] = useState(null);
  useEffect(() => {
    Promise.all(ids.map((id) => api(`/api/patients/${encodeURIComponent(id)}`).then((p) => ({ id, name: p.fullName })).catch(() => ({ id, name: id })))).then(setList);
  }, [ids.join(',')]); // eslint-disable-line react-hooks/exhaustive-deps
  return list;
}

/** The family member's relative: who cares for them (caregiver, case nurse). */
function RelativeCard({ elder }) {
  const tr = useT();
  const people = usePeople(elder.id);
  return (
    <div className="m-info-box m-row" style={{ alignItems: 'flex-start' }}>
      <Avatar name={elder.name} />
      <div className="m-grow">
        <strong style={{ display: 'block' }}>{elder.name}</strong>
        {people && people.caregivers.length > 0 && <span className="m-caption" style={{ display: 'block' }}>{tr('Caregiver', 'Tagapag-alaga')}: {people.caregivers.map((c) => c.name).join(', ')}</span>}
        {people && people.caseNurse && <span className="m-caption" style={{ display: 'block' }}>{tr('Nurse', 'Nars')}: {people.caseNurse.name.replace(/,.*$/, '')}{people.careTeam ? `, ${people.careTeam.name}` : ''}</span>}
      </div>
      <Badge>{tr('Linked', 'Naka-link')}</Badge>
    </div>
  );
}

/** Profile (Figma "Profile"): who you are, your elders, app preferences, log out. */
export function Profile({ user, back, desktopTo, notifications }) {
  const tr = useT();
  const { big, setPrefs } = usePrefs();
  const elders = useElderNames(user.role === 'clinic_staff' ? [] : user.patients);
  return (
    <>
      <TopBar title={tr('Profile', 'Profile')} back={back} />
      <section className="m-soft m-row">
        <Avatar name={user.name} />
        <div><strong style={{ fontSize: '1.125rem', display: 'block' }}>{user.name}</strong><span className="m-muted">{ROLE_LABEL[user.role]}</span></div>
      </section>
      {user.role === 'caregiver' && (
        <>
          <h2 className="m-label">{tr('Assigned Patients', 'Mga nakatalagang pasyente')}</h2>
          {!elders ? <Loader /> : elders.map((e) => (
            <div key={e.id} className="m-info-box m-row"><Avatar name={e.name} /><strong className="m-grow" style={{ fontSize: '.9375rem' }}>{e.name}</strong><Badge>{tr('Active', 'Aktibo')}</Badge></div>
          ))}
        </>
      )}
      {user.role === 'family_member' && (
        <>
          <h2 className="m-label">{tr('Your Relative', 'Iyong kamag-anak')}</h2>
          {!elders ? <Loader /> : elders.map((e) => <RelativeCard key={e.id} elder={e} />)}
          {elders && !elders.length && <div className="m-note">{tr('Not linked to an elder yet. The health center links you after verifying you.', 'Hindi pa naka-link.')}</div>}
        </>
      )}
      <h2 className="m-label">{tr('App Preferences', 'Mga setting')}</h2>
      <PrefRow icon="globe" label={tr('Language', 'Wika')}><LangToggle /></PrefRow>
      <PrefRow icon="textSize" label={tr('Large Text Mode', 'Malaking letra')} last={!notifications}><SwitchPill on={big} onClick={() => setPrefs({ big: !big })} label={tr('Large Text Mode', 'Malaking letra')} /></PrefRow>
      {notifications && <PrefRow icon="bell" label={tr('Notifications & Reminders', 'Abiso at paalala')} last>{notifications}</PrefRow>}
      {desktopTo && <button type="button" className="m-btn is-block" style={{ marginTop: '1rem' }} onClick={() => navigate(desktopTo)}><Icon name="monitor" />{tr('Open the desktop view', 'Buksan ang desktop view')}</button>}
      <button type="button" className="m-logout" onClick={requestSignOut}><Icon name="logout" size={18} />{tr('Log out', 'Mag-log out')}</button>
    </>
  );
}

// Screens shared by the caregiver and family apps: alerts list, alert detail (F2), profile.
import React, { useEffect, useState } from 'react';
import { api, requestSignOut } from '../api';
import { Link, navigate } from '../router';
import { ROLE_LABEL, relTime } from '../format';
import Icon from './icons';
import { alertHeadline, explainAlert } from './data';
import { TopBar, Chip, Cta, Loader, usePrefs, useT, clock, isToday, TONE, CLINIC_PHONE, shortName } from './kit';

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

export function AlertDetail({ id, back, callCaregiverLabel }) {
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
        {callCaregiverLabel && <button type="button" className="m-btn is-block" disabled title={tr('Caregiver phone numbers are not in the system yet', 'Wala pang numero ng tagapag-alaga')}>{callCaregiverLabel}</button>}
        <CallClinic />
      </div>
    </>
  );
}

export function CallClinic({ label }) {
  const tr = useT();
  const call = () => {
    if (CLINIC_PHONE) window.location.href = `tel:${CLINIC_PHONE}`;
    else window.alert(tr('The clinic hotline is not set yet (VITE_CLINIC_PHONE).', 'Wala pang numero ng klinika (VITE_CLINIC_PHONE).'));
  };
  return <Cta onClick={call}>{label || tr('Call the clinic', 'Tawagan ang klinika')}</Cta>;
}

export function Profile({ user, back, desktopTo, extra }) {
  const tr = useT();
  const { big, lang, setPrefs } = usePrefs();
  return (
    <>
      <TopBar title={tr('Profile', 'Profile')} back={back} />
      <section className="m-card m-row">
        <span className="m-avatar" aria-hidden="true">{user.name.split(/\s+/).slice(0, 2).map((w) => w[0]).join('')}</span>
        <div><strong style={{ fontSize: '1.125rem' }}>{user.name}</strong><p className="m-muted">{ROLE_LABEL[user.role]}</p></div>
      </section>
      <h2 className="m-section-title">{tr('Display', 'Display')}</h2>
      <div className="m-pills">
        <button type="button" className="m-pill" aria-pressed={big} onClick={() => setPrefs({ big: !big })}><Icon name="textSize" size={18} />{tr('Big text', 'Malaking letra')}</button>
        <button type="button" className="m-pill" aria-pressed={lang === 'fil'} onClick={() => setPrefs({ lang: lang === 'fil' ? 'en' : 'fil' })}><Icon name="globe" size={18} />Filipino</button>
      </div>
      {extra}
      <div className="m-stack" style={{ marginTop: '1.5rem' }}>
        {desktopTo && <button type="button" className="m-btn is-block" onClick={() => navigate(desktopTo)}><Icon name="monitor" />{tr('Open the desktop view', 'Buksan ang desktop view')}</button>}
        <button type="button" className="m-btn is-block" onClick={requestSignOut}><Icon name="logout" />{tr('Log out', 'Mag-log out')}</button>
      </div>
    </>
  );
}

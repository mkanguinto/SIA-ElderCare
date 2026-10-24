// Family phone app (Figma F1-F4 + "Family care dashboard"): today, trends, medicines, alerts, alert detail, profile.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Link, navigate } from '../router';
import Icon from './icons';
import { ContactClinic } from './contact';
import { todaysDoses, SLOTS, slotOf, alertHeadline } from './data';
import { AlertDetail, Profile, useNotifications } from './common';
import { DutiesScreen } from './duties';
import { Avatar, usePeople, exclamationIcon } from './figma';
import { StatusChip, statusLine } from './status';
import { visitWhen, VISIT_TYPE_LABEL } from '../format';
import {
  MobileFrame, BottomNav, Greeting, TopBar, Chip, Loader, useT, usePrefs,
  isToday, clock, hhmm, manilaDay, manilaHour, shortName, TONE,
} from './kit';

const BASE = '/m/family';
const NAV = (tr) => [
  { to: BASE, icon: 'home', label: tr('Today', 'Ngayon') },
  { to: `${BASE}/trends`, icon: 'pulse', label: tr('Trends', 'Trends') },
  { to: `${BASE}/medicines`, icon: 'pill', label: tr('Meds', 'Gamot') },
  { to: `${BASE}/alerts`, icon: 'bell', label: tr('Alerts', 'Alerto'), exact: false },
  { to: `${BASE}/profile`, icon: 'user', label: tr('Me', 'Ako') },
];

function usePatientData(patientId, days) {
  const [data, setData] = useState(null);
  useEffect(() => {
    if (!patientId) return undefined;
    let live = true;
    const load = () => Promise.all([
      api(`/api/patients/${patientId}/history?days=${days}&limit=200`),
      api(`/api/patients/${patientId}/medications`).catch(() => ({ medications: [] })),
      api(`/api/patients/${patientId}/visits?view=upcoming`).catch(() => ({ visits: [] })),
    ]).then(([h, m, v]) => live && setData({ patient: h.patient, checkins: h.checkins, trends: h.trends, meds: m.medications, visits: v.visits }))
      .catch((e) => live && setData({ error: e.message }));
    load();
    const t = setInterval(load, 30000);
    return () => { live = false; clearInterval(t); };
  }, [patientId, days]);
  return data;
}

export default function FamilyApp({ user, path }) {
  const tr = useT();
  const sub = path.slice(BASE.length) || '/';
  const patientId = user.patients[0];
  let screen;
  if (!patientId) screen = <div className="m-note"><strong>{tr('No family member linked yet', 'Wala pang naka-link')}</strong>{tr('Ask the health center to link your account to your relative.', 'Hilingin sa health center na i-link ang iyong account.')}</div>;
  else if (sub === '/trends') screen = <Trends patientId={patientId} />;
  else if (sub === '/medicines') screen = <Medicines patientId={patientId} />;
  else if (sub.startsWith('/alerts/')) screen = <AlertDetail id={sub.split('/')[2]} back={`${BASE}/alerts`} />;
  else if (sub === '/alerts') screen = <FamilyAlerts user={user} patientId={patientId} />;
  else if (sub === '/profile') screen = <Profile user={user} back={BASE} />;
  else if (sub === '/duties') screen = <FamilyDuties patientId={patientId} />;
  else if (sub === '/contact') screen = <ContactClinic user={user} patients={[{ id: patientId, name: '' }]} back={BASE} />;
  else screen = <Today user={user} patientId={patientId} />;
  return (
    <MobileFrame light>
      {screen}
      <BottomNav items={NAV(tr)} />
    </MobileFrame>
  );
}

/* ------------------------------ F1 today ------------------------------ */
// The family sees what the caregiver reported, not a diagnosis: "Blood pressure was reported severely high".
const REPORTED = {
  'Blood pressure very high': ['Blood pressure was reported severely high', 'Naiulat na napakataas ng presyon'],
  'Blood pressure high': ['Blood pressure was reported high', 'Naiulat na mataas ang presyon'],
  'Blood pressure low': ['Blood pressure was reported low', 'Naiulat na mababa ang presyon'],
  'Oxygen level low': ['Oxygen was reported low', 'Naiulat na mababa ang oxygen'],
  Fever: ['A fever was reported', 'May naiulat na lagnat'],
  'Body temperature low': ['A low temperature was reported', 'Naiulat na mababa ang temperatura'],
  'Heart rate unusual': ['An unusual heart rate was reported', 'Naiulat na kakaiba ang tibok ng puso'],
  'Fall reported': ['A fall was reported', 'May naiulat na pagkahulog'],
  'Medicine missed': ['A missed medicine was reported', 'Naiulat na hindi nainom ang gamot'],
};
const reported = (h, lang) => (REPORTED[h.title] ? REPORTED[h.title][lang === 'fil' ? 1 : 0] : (lang === 'fil' && h.fil) || h.title);
const firstName = (n = '') => n.replace(/,.*$/, '').split(' ')[0];
/** Big number for a measurement (186/118 mmHg); a word value (a medicine name) stays normal size. */
const Value = ({ h }) => (!h.value ? null : h.unit ? <p className="m-big">{h.value}<small>{h.unit}</small></p> : <p style={{ fontWeight: 700, fontSize: '1.125rem', margin: '.25rem 0' }}>{h.value}</p>);

/** Headline, value and unit for a flagged check-in (from its alert when there is one). */
function flagOf(checkin, alert) {
  if (alert) return alertHeadline(alert);
  const a = checkin.anomalies[0];
  return a ? { title: a.message, value: a.value, unit: '' } : { title: 'Needs attention', value: null };
}

/** Reported -> nurse told -> nurse review, each with its time. */
function Progress3({ checkin, alert, tr }) {
  const reviewed = checkin.review || checkin.action;
  return (
    <div className="m-progress3" aria-label={tr('Progress', 'Progreso')}>
      <div>{tr('Reported', 'Naiulat')}<br />{clock(checkin.recordedAt)}</div>
      <div className={alert ? '' : 'is-waiting'}>{tr('Nurse told', 'Alam ng nars')}<br />{alert ? clock(alert.createdAt) : tr('Sending', 'Ipinapadala')}</div>
      <div className={reviewed ? '' : 'is-waiting'}>{tr('Nurse review', 'Sinuri ng nars')}<br />{reviewed ? clock(reviewed.at) : tr('Waiting', 'Hinihintay')}</div>
    </div>
  );
}

function Today({ user, patientId }) {
  const tr = useT();
  const { lang } = usePrefs();
  const data = usePatientData(patientId, 7);
  const alerts = useNotifications(patientId, 10);
  const people = usePeople(patientId);
  if (!data) return <><Greeting user={user} alertsTo={`${BASE}/alerts`} /><Loader /></>;
  if (data.error) return <div className="m-error">{data.error}</div>;

  const p = data.patient;
  const her = /^lolo/i.test(shortName(p.fullName)) ? ['his', 'His'] : ['her', 'Her'];
  const latest = data.checkins[0];
  const today = latest && isToday(latest.recordedAt) ? latest : null;
  const flagged = today && !['none', 'low'].includes(today.severity) ? today : null;
  const alert = flagged && (alerts || []).find((a) => a.metadata && a.metadata.checkinId === flagged.id);
  const h = flagged ? flagOf(flagged, alert) : null;
  const base = p.baseline || {};
  const newAlerts = (alerts || []).filter((a) => isToday(a.createdAt)).length;
  const sender = latest && people && (people.caregivers.find((c) => c.id === latest.caregiverId) || {}).name;
  const doses = todaysDoses(data.meds, data.checkins);
  const missed = doses.filter((d) => d.status === 'missed');
  const latestWith = (k) => data.checkins.find((c) => c.vitals[k] != null);
  const bad = (c, prefix) => c && c.anomalies.some((a) => a.code.startsWith(prefix));
  const hr = latestWith('heartRate');
  const temp = latestWith('temperatureC');
  const spo2 = latestWith('spo2');
  const bp = data.checkins.find((c) => c.vitals.systolic);

  return (
    <>
      <Greeting user={user} alerts={newAlerts} alertsTo={`${BASE}/alerts`} />
      <section className="m-soft m-row">
        <Avatar name={p.fullName} />
        <div className="m-grow"><strong style={{ display: 'block' }}>{p.fullName}</strong>
          <span className="m-caption">{latest
            ? `${tr('Updated', 'Na-update')} ${isToday(latest.recordedAt) ? clock(latest.recordedAt) : `${manilaDay(latest.recordedAt)} ${clock(latest.recordedAt)}`}${sender ? ` · ${tr('Sent by', 'Ipinadala ni')} ${sender}` : ''}`
            : tr('No check-ins yet', 'Wala pang check-in')}</span></div>
      </section>

      {flagged && (
        <section className="m-attention" style={{ marginTop: '.75rem' }}>
          <div className="m-between"><span>{tr('NEEDS ATTENTION', 'KAILANGANG BANTAYAN')}</span><span className="m-pill-white">{tr('Reported', 'Naiulat')} {clock(flagged.recordedAt)}</span></div>
          <h2>{reported(h, lang)}</h2>
          <Value h={h} />
          {base.systolic && String(h.unit) === 'mmHg' && <p style={{ fontWeight: 700 }}>{tr(`${her[1]} usual is about ${base.systolic}/${base.diastolic}.`, `Karaniwan: mga ${base.systolic}/${base.diastolic}.`)} {tr('This needs assessment by a nurse.', 'Kailangan itong suriin ng nars.')}</p>}
          {!(base.systolic && String(h.unit) === 'mmHg') && <p style={{ fontWeight: 700 }}>{tr('This needs assessment by a nurse.', 'Kailangan itong suriin ng nars.')}</p>}
          <Progress3 checkin={flagged} alert={alert} tr={tr} />
          <p className="m-caption" style={{ color: 'inherit', marginTop: '.9rem' }}>
            {tr(`The caregiver is with ${her[0]} and the clinic will contact the caregiver. You will get a text when the nurse has reviewed it.`, 'Kasama ng tagapag-alaga at kokontakin siya ng klinika. Makakatanggap ka ng text kapag nasuri na ng nars.')}{' '}
            <Link to={`${BASE}/contact`} style={{ fontWeight: 700 }}>{tr('Message the clinic', 'Magmensahe sa klinika')}</Link>
          </p>
        </section>
      )}
      {!flagged && bp && (
        <section className="m-bp-hero tone-ok" style={{ marginTop: '.75rem', paddingBottom: '1.25rem' }}>
          <div className="m-between"><span style={{ fontSize: '.8125rem', fontWeight: 800, letterSpacing: '.06em' }}>{today ? tr('ALL GOOD TODAY', 'MAAYOS NGAYON') : tr('LAST READING', 'HULING SUKAT')}</span><span className="m-caption" style={{ color: 'inherit' }}>{clock(bp.recordedAt)}{isToday(bp.recordedAt) ? '' : `, ${manilaDay(bp.recordedAt)}`}</span></div>
          <p className="m-bp-value">{bp.vitals.systolic}/{bp.vitals.diastolic}<small>mmHg</small></p>
          <p style={{ fontSize: '.9375rem' }}>{base.systolic ? tr(`Close to ${her[0]} usual ${base.systolic}/${base.diastolic}.`, `Malapit sa karaniwang ${base.systolic}/${base.diastolic}.`) : tr('Blood pressure', 'Presyon ng dugo')}</p>
        </section>
      )}
      {latest && <div className="m-row" style={{ gap: '.5rem', marginTop: '.6rem', alignItems: 'center' }}><StatusChip status={latest.status} /><span className="m-caption" style={{ flex: 1 }}>{statusLine(latest, tr)}</span></div>}

      <h2 className="m-label" style={{ marginTop: '1.25rem' }}>{tr('Medicines Today', 'Gamot ngayon')}</h2>
      {missed.length > 0 ? missed.map((d) => (
        <Link key={d.id} to={`${BASE}/medicines`} className="m-missed">
          <span className="m-missed-icon"><Icon name="pill" size={20} /></span>
          <strong className="m-grow">{tr(`${d.med.name} was missed`, `Hindi nainom ang ${d.med.name}`)}</strong>
          <span className="m-missed-chip">● {tr('Missed', 'Hindi nainom')}</span>
        </Link>
      )) : <div className="m-note">{doses.length ? tr('No missed medicines so far today.', 'Walang hindi nainom ngayon.') : tr('No medicines prescribed.', 'Walang nakatakdang gamot.')}</div>}

      <div className="m-between"><h2 className="m-label" style={{ marginTop: '1.25rem' }}>{tr('Latest vitals', 'Pinakabagong vital signs')}</h2>{latest && <span className="m-caption" style={{ marginTop: '1.25rem' }}>{clock(latest.recordedAt)}</span>}</div>
      <div className="m-vitals-strip">
        <div>{tr('Heart rate', 'Tibok ng puso')}<strong>{hr ? hr.vitals.heartRate : '–'}{hr && <small>bpm</small>}</strong>{hr && <em className={bad(hr, 'HR') ? 'is-bad' : ''}>{bad(hr, 'HR') ? tr('Above usual', 'Mas mataas') : tr('In range', 'Normal')}</em>}</div>
        <div>{tr('Temperature', 'Temperatura')}<strong>{temp ? temp.vitals.temperatureC : '–'}{temp && <small>°C</small>}</strong>{temp && <em className={bad(temp, 'TEMP') ? 'is-bad' : ''}>{bad(temp, 'TEMP') ? tr('Not normal', 'Hindi normal') : tr('In range', 'Normal')}</em>}</div>
        <div>{tr('Oxygen', 'Oxygen')}<strong>{spo2 ? spo2.vitals.spo2 : '–'}{spo2 && <small>%</small>}</strong>{spo2 && <em className={bad(spo2, 'SPO2') ? 'is-bad' : ''}>{bad(spo2, 'SPO2') ? tr('Below usual', 'Mas mababa') : tr('In range', 'Normal')}</em>}</div>
      </div>

      {data.visits[0] && (
        <>
          <h2 className="m-label" style={{ marginTop: '1.25rem' }}>{tr('Next clinic visit', 'Susunod na pagbisita')}</h2>
          <div className="m-card m-row"><span className="m-thumb tone-ok"><Icon name="calendar" /></span>
            <div><strong>{visitWhen(data.visits[0])}</strong><p className="m-caption">{VISIT_TYPE_LABEL[data.visits[0].visitType]} · {data.visits[0].destination}</p></div></div>
        </>
      )}
      <div className="m-stack" style={{ marginTop: '1rem', gap: '.25rem' }}>
        <Link to={`${BASE}/contact`} className="m-link"><Icon name="message" size={18} /> {tr('Message the clinic', 'Magmensahe sa klinika')}</Link>
        <Link to={`${BASE}/duties`} className="m-link"><Icon name="clipboard" size={18} /> {tr("See the caregiver's duties today", 'Tingnan ang gawain ng tagapag-alaga')}</Link>
      </div>
    </>
  );
}

/* ------------------------------ F3 trends ------------------------------ */
const SEV_RANK = { none: 0, low: 1, moderate: 2, high: 3, critical: 4 };
const ACCENT = { ok: 'var(--accent-ok)', moderate: 'var(--accent-moderate)', high: 'var(--accent-high)', critical: 'var(--accent-critical)' };
const WORD = { ok: ['Normal', 'Normal'], moderate: ['A bit high', 'Medyo mataas'], high: ['High', 'Mataas'], critical: ['Very high', 'Napakataas'] };

function byDay(checkins, days) {
  const out = [];
  for (let i = days - 1; i >= 0; i--) {
    const d = manilaDay(Date.now() - i * 86400000);
    const list = checkins.filter((c) => manilaDay(c.recordedAt) === d);
    const bp = list.filter((c) => c.vitals.systolic).sort((a, b) => b.vitals.systolic - a.vitals.systolic)[0];
    const avg = (k) => { const v = list.map((c) => c.vitals[k]).filter((x) => x != null); return v.length ? Math.round(v.reduce((a, b) => a + b, 0) / v.length) : null; };
    const worst = list.reduce((w, c) => (SEV_RANK[c.severity] > SEV_RANK[w] ? c.severity : w), 'none');
    out.push({ day: d, bp, sys: bp ? bp.vitals.systolic : null, hr: avg('heartRate'), spo2: avg('spo2'), worst, count: list.length });
  }
  return out;
}

const dayLabel = (day, lang, short = true) => new Date(`${day}T12:00:00+08:00`).toLocaleDateString(lang === 'fil' ? 'fil-PH' : 'en-PH', { weekday: short ? 'short' : 'long', timeZone: 'Asia/Manila' }).slice(0, 3);

/** One metric (Figma "Trends" card): value of the chosen day, a status chip, a line over the usual-range band. */
function MetricCard({ title, unit, series, k, band, selected, judge, tr, lang }) {
  const sel = series[selected];
  const value = sel[k];
  const shownValue = value != null ? value : [...series].reverse().find((s) => s[k] != null);
  const v = value != null ? value : null;
  const [tone, en, fil] = v == null ? ['', 'No reading', 'Walang sukat'] : judge(v);
  const w = 300; const hgt = 96; const top = 8; const bottom = 18;
  const vals = series.map((s) => s[k]).filter((x) => x != null);
  const lo = Math.min(band[0], ...vals) - 5; const hi = Math.max(band[1], ...vals) + 5;
  const x = (i) => 8 + (i * (w - 16)) / Math.max(1, series.length - 1);
  const y = (val) => top + (1 - (val - lo) / (hi - lo)) * (hgt - top - bottom);
  // Break the line where a day has no reading.
  const segs = [];
  series.forEach((s, i) => { if (s[k] == null) segs.push([]); else { if (!segs.length) segs.push([]); segs[segs.length - 1].push([x(i), y(s[k])]); } });
  return (
    <section className="m-metric">
      <div className="m-between" style={{ alignItems: 'flex-start' }}>
        <h3>{title}</h3>
        {tone && <Chip tone={tone}>{tr(en, fil)}</Chip>}
      </div>
      <p className="m-metric-value">{v != null ? v : '–'}{v != null && <small>{unit}</small>}</p>
      {v == null && shownValue && <p className="m-caption">{tr('No reading that day', 'Walang sukat nang araw na iyon')}</p>}
      {vals.length ? (
        <svg viewBox={`0 0 ${w} ${hgt}`} role="img" aria-label={`${title}: ${series.map((s) => `${s.day.slice(5)} ${s[k] ?? '–'}`).join(', ')}`}>
          <rect className="band" x="0" width={w} y={y(band[1])} height={y(band[0]) - y(band[1])} rx="4" />
          {segs.filter((sg) => sg.length > 1).map((sg, i) => <polyline key={i} className="line" points={sg.map((p) => p.join(',')).join(' ')} />)}
          {series.map((s, i) => s[k] != null && <circle key={s.day} className={`pt ${judge(s[k])[0] !== 'ok' ? 'is-bad' : ''}`} cx={x(i)} cy={y(s[k])} r={i === selected ? 5 : 3.5} />)}
          {series.map((s, i) => (series.length <= 7 || i % 5 === 0 || i === series.length - 1) && (
            <text key={`t${s.day}`} className="axis" x={x(i)} y={hgt - 3} textAnchor={i === 0 ? 'start' : i === series.length - 1 ? 'end' : 'middle'}>{series.length <= 7 ? dayLabel(s.day, lang) : Number(s.day.slice(8))}</text>
          ))}
        </svg>
      ) : <p className="m-muted">{tr('No readings in this period.', 'Walang sukat sa panahong ito.')}</p>}
      <p className="m-caption">{tr(`Shaded band: usual range ${band[0]}–${band[1]}. No dot = no reading that day.`, `Lilim: karaniwang ${band[0]}–${band[1]}. Walang tuldok = walang sukat.`)}</p>
    </section>
  );
}

function Trends({ patientId }) {
  const tr = useT();
  const { lang } = usePrefs();
  const [days, setDays] = useState(7);
  const data = usePatientData(patientId, days);
  const series = useMemo(() => (data && data.checkins ? byDay(data.checkins, days) : []), [data, days]);
  const week = useMemo(() => (data && data.checkins ? byDay(data.checkins, 7) : []), [data]);
  const [picked, setPicked] = useState(null);
  if (!data) return <><TopBar title={tr('Trends', 'Trends')} back={BASE} /><Loader /></>;
  if (data.error) return <div className="m-error">{data.error}</div>;
  const base = data.patient.baseline || {};
  // Start on the latest day that has a reading (today may have none yet).
  const lastWithData = week.reduce((acc, d, i) => (d.sys != null || d.hr != null || d.spo2 != null ? i : acc), 6);
  const day = picked === null ? lastWithData : picked;
  const selected = series.length - 7 + day;
  const bpBand = [base.systolic ? base.systolic - 15 : 120, base.systolic ? base.systolic + 5 : 140];
  return (
    <>
      <TopBar title={tr('Trends', 'Trends')} back={BASE} action={<button type="button" className="m-icon-btn" aria-label={tr('Show 30 days', 'Ipakita ang 30 araw')} onClick={() => setDays(days === 7 ? 30 : 7)}><Icon name="calendar" /></button>} />
      <div className="m-seg" role="group" aria-label={tr('Period', 'Panahon')}>
        {[7, 30].map((d) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{tr(`${d} days`, `${d} araw`)}</button>)}
      </div>
      <div className="m-days">
        {week.map((d, i) => {
          const tone = d.count ? TONE[d.worst] : null;
          return (
            <button key={d.day} type="button" className={`m-day ${i === day ? 'is-today' : ''}`} aria-pressed={i === day} onClick={() => setPicked(i)}
              aria-label={`${d.day}: ${d.count ? WORD[tone][lang === 'fil' ? 1 : 0] : tr('no check-in', 'walang check-in')}`}>
              {dayLabel(d.day, lang)}
              <strong>{Number(d.day.slice(8))}</strong>
              <i style={{ background: tone ? ACCENT[tone] : 'transparent' }} />
            </button>
          );
        })}
      </div>
      <MetricCard title={tr('Blood pressure (top number)', 'Presyon (itaas na numero)')} unit="mmHg" series={series} k="sys" band={bpBand} selected={selected} tr={tr} lang={lang}
        judge={(v) => (v >= 180 ? ['critical', 'Reported severely high', 'Naiulat na napakataas'] : v > bpBand[1] ? ['moderate', 'Above usual', 'Mas mataas'] : v < 90 ? ['high', 'Below usual', 'Mas mababa'] : ['ok', 'In range', 'Normal'])} />
      <MetricCard title={tr('Heart rate', 'Tibok ng puso')} unit="bpm" series={series} k="hr" band={[60, 100]} selected={selected} tr={tr} lang={lang}
        judge={(v) => (v > 100 ? ['moderate', 'Above usual', 'Mas mataas'] : v < 50 ? ['high', 'Below usual', 'Mas mababa'] : ['ok', 'In range', 'Normal'])} />
      <MetricCard title={tr('Oxygen', 'Oxygen')} unit="%" series={series} k="spo2" band={[95, 100]} selected={selected} tr={tr} lang={lang}
        judge={(v) => (v < 92 ? ['critical', 'Low', 'Mababa'] : v < 95 ? ['moderate', 'Below usual', 'Mas mababa'] : ['ok', 'In range', 'Normal'])} />
      <details className="m-card m-details" style={{ marginTop: '.75rem' }}>
        <summary>{tr('Show readings as a list', 'Ipakita bilang listahan')}</summary>
        <table className="m-table">
          <thead><tr><th>{tr('Day', 'Araw')}</th><th>BP</th><th>{tr('Heart', 'Puso')}</th><th>O₂</th></tr></thead>
          <tbody>
            {[...series].reverse().map((d) => (
              <tr key={d.day}><td>{d.day.slice(5)}</td><td>{d.bp ? `${d.bp.vitals.systolic}/${d.bp.vitals.diastolic}` : '–'}</td><td>{d.hr || '–'}</td><td>{d.spo2 || '–'}</td></tr>
            ))}
          </tbody>
        </table>
      </details>
    </>
  );
}

/* ------------------------------ F4 medicines ------------------------------ */
const FAMILY_DOSE = {
  taken: ['ok', 'check', 'Taken', 'Nainom'],
  missed: ['critical', 'alert', 'Missed', 'Hindi nainom'],
  due: ['info', 'clock', 'Due', 'Mamaya'],
  unknown: ['moderate', 'clock', 'Not recorded', 'Hindi naitala'],
};
function Medicines({ patientId }) {
  const tr = useT();
  const { lang } = usePrefs();
  const data = usePatientData(patientId, 2);
  const [slot, setSlot] = useState(() => slotOf(`${String(manilaHour()).padStart(2, '0')}:00`));
  if (!data) return <><TopBar title={tr('Medicines', 'Mga gamot')} back={BASE} /><Loader /></>;
  if (data.error) return <div className="m-error">{data.error}</div>;
  const doses = todaysDoses(data.meds, data.checkins);
  const past = doses.filter((d) => d.status !== 'due');
  const taken = past.filter((d) => d.status === 'taken').length;
  const missed = past.filter((d) => d.status === 'missed').length;
  const total = past.length || doses.length;
  const shown = doses.filter((d) => d.slot === slot);
  return (
    <>
      <TopBar title={tr('Medicines', 'Mga gamot')} back={BASE} />
      <section className="m-hero">
        <p className="m-eyebrow">{tr("Today's progress", 'Progreso ngayon')}</p>
        <h2>{tr(`${taken} of ${total} taken`, `${taken} sa ${total} nainom`)}</h2>
        <div className="m-bar on-hero" style={{ margin: '.75rem 0' }}><span style={{ width: `${(taken / (total || 1)) * 100}%` }} /></div>
        <p className="m-muted">{missed
          ? tr(`Keep it up — ${missed} missed dose${missed === 1 ? ' was' : 's were'} reported to the clinic.`, `${missed} hindi nainom ang naiulat sa klinika.`)
          : tr('Keep it up. Doses later today show as "Due".', 'Ipagpatuloy. Ang mga gamot mamaya ay "Mamaya".')}</p>
      </section>
      <div className="m-seg" style={{ margin: '1rem 0' }} role="group" aria-label={tr('Time of day', 'Oras')}>
        {SLOTS.map((s) => <button key={s.key} type="button" aria-pressed={slot === s.key} onClick={() => setSlot(s.key)}>{lang === 'fil' ? s.fil : s.en}</button>)}
      </div>
      <div className="m-dose-list">
        {shown.map((d) => {
          const [tone, icon, en, fil] = FAMILY_DOSE[d.status];
          return (
            <div key={d.id} className="m-dose">
              <span className="m-thumb" aria-hidden="true"><Icon name="pill" size={20} /></span>
              <div className="m-grow"><strong>{d.med.name} {d.med.dosage}</strong><span className="m-sub">{d.med.instructions || d.med.frequency} · {hhmm(d.time)}</span></div>
              <Chip tone={tone} icon={icon}>{tr(en, fil)}{d.status === 'taken' && d.at ? ` ${clock(d.at).replace(/ [AP]M$/, '')}` : ''}</Chip>
            </div>
          );
        })}
        {!shown.length && <div className="m-note">{tr('No medicines at this time of day.', 'Walang gamot sa oras na ito.')}</div>}
      </div>
      <p className="m-caption" style={{ marginTop: '1rem' }}>{tr('Only the clinic can change prescriptions. Family members can view, not edit.', 'Klinika lang ang puwedeng magbago ng reseta.')}</p>
    </>
  );
}

/* ------------------------------ alerts ------------------------------ */
/** Family alerts (Figma "Alerts"): the latest alert with what was done about it, then earlier alerts. */
function FamilyAlerts({ user, patientId }) {
  const tr = useT();
  const { lang } = usePrefs();
  const alerts = useNotifications(patientId, 20);
  const people = usePeople(patientId);
  const data = usePatientData(patientId, 2);
  const latest = (alerts || []).find((a) => a.source !== 'weather') || (alerts || [])[0];
  const checkinId = latest && latest.metadata && latest.metadata.checkinId;
  const [checkin, setCheckin] = useState(undefined);
  useEffect(() => {
    if (!checkinId) { setCheckin(null); return; }
    api(`/api/checkins/${checkinId}`).then((r) => setCheckin(r.checkin)).catch(() => setCheckin(null));
  }, [checkinId]);
  if (!alerts || !data) return <><TopBar title={tr('Alerts', 'Mga alerto')} back={BASE} /><Loader /></>;
  if (!latest) return <><TopBar title={tr('Alerts', 'Mga alerto')} back={BASE} /><div className="m-note"><strong>{tr('No alerts', 'Walang alerto')}</strong>{tr('You will see an alert here and get a text if a reading needs attention.', 'Makikita mo rito ang alerto at makakatanggap ka ng text kung may sukat na dapat bantayan.')}</div></>;

  const h = alertHeadline(latest);
  const p = data.patient || {};
  const base = p.baseline || {};
  const caregiver = checkin && people && (people.caregivers.find((c) => c.id === checkin.caregiverId) || {}).name;
  const nurse = people && people.caseNurse ? firstName(people.caseNurse.name) : null;
  const smsToMe = (latest.delivery || []).some((d) => d.channel === 'sms' && ['sent', 'delivered'].includes(d.status));
  const reviewed = checkin && (checkin.review || checkin.action);
  const visit = data.visits && data.visits[0];
  const doses = data.meds ? todaysDoses(data.meds, data.checkins) : [];
  const tags = [
    ...doses.filter((d) => d.status === 'missed').map((d) => tr(`${d.med.name} was missed`, `Hindi nainom ang ${d.med.name}`)),
    ...(checkin && checkin.mobilityStatus === 'fall_reported' ? [tr('A fall was reported', 'May naiulat na pagkahulog')] : []),
    ...(checkin && ['assisted', 'wheelchair', 'bedridden'].includes(checkin.mobilityStatus) ? [tr('Needs help getting around', 'Kailangan ng tulong sa paggalaw')] : []),
    ...(checkin && checkin.mood === 'confused' ? [tr('Seems confused', 'Mukhang lito')] : []),
  ];
  const tone = TONE[latest.severity] === 'ok' ? 'info' : TONE[latest.severity];
  return (
    <>
      <TopBar title={tr('Alerts', 'Mga alerto')} back={BASE} />
      <Link to={`${BASE}/alerts/${latest.id}`} className={`m-attention tone-${tone}`} style={{ display: 'block', textDecoration: 'none' }}>
        <div className="m-between"><span>{['critical', 'high'].includes(latest.severity) ? tr('URGENT', 'AGARAN') : tr('ALERT', 'ALERTO')}</span><span className="m-pill-white">{isToday(latest.createdAt) ? tr('Today', 'Ngayon') : manilaDay(latest.createdAt)}, {clock(latest.createdAt)}</span></div>
        <h2>{reported(h, lang)}</h2>
        {p.fullName && <p style={{ fontWeight: 700 }}>{p.fullName}</p>}
        <Value h={h} />
        {base.systolic && h.unit === 'mmHg' && <p style={{ fontWeight: 700 }}>{tr(`Usual is about ${base.systolic}/${base.diastolic}. This needs assessment by a nurse.`, `Karaniwan: ${base.systolic}/${base.diastolic}. Kailangang suriin ng nars.`)}</p>}
      </Link>

      <h2 className="m-label" style={{ marginTop: '1.25rem' }}>{tr('Status', 'Status')}</h2>
      <ol className="m-timeline">
        <li><span className="m-dot-icon is-ok"><Icon name="check" size={22} /></span><div><strong>{caregiver ? tr(`Reported by ${caregiver}`, `Iniulat ni ${caregiver}`) : tr('Reported by the caregiver', 'Iniulat ng tagapag-alaga')}</strong><span className="m-sub">{tr('Caregiver', 'Tagapag-alaga')} · {clock(checkin ? checkin.recordedAt : latest.createdAt)}</span></div></li>
        <li><span className="m-dot-icon is-ok"><Icon name="check" size={22} /></span><div><strong>{nurse ? tr(`Nurse ${nurse} was notified`, `Naabisuhan si Nurse ${nurse}`) : tr('The clinic was notified', 'Naabisuhan ang klinika')}</strong><span className="m-sub">{clock(latest.createdAt)} · {smsToMe ? tr('You were sent a text', 'Pinadalhan ka ng text') : tr('You got an app alert', 'Nakatanggap ka ng alerto sa app')}</span></div></li>
        <li><span className={`m-dot-icon ${reviewed ? 'is-ok' : 'is-wait'}`}>{reviewed ? <Icon name="check" size={22} /> : <img src={exclamationIcon} width="25" height="25" alt="" aria-hidden="true" />}</span>
          <div><strong>{reviewed ? tr(`Reviewed by ${reviewed.byName || 'a nurse'}`, `Nasuri ni ${reviewed.byName || 'nars'}`) : tr('Nurse assessment: waiting', 'Pagsusuri ng nars: hinihintay')}</strong>
            <span className="m-sub">{reviewed ? `${clock(reviewed.at)}${checkin.action ? ` · ${checkin.action.text}` : ''}` : tr('Not reviewed yet. We will update you here and by text.', 'Hindi pa nasusuri. Ia-update ka namin dito at sa text.')}</span></div></li>
        <li><span className={`m-dot-icon ${visit ? 'is-ok' : ''}`}>{visit && <Icon name="calendar" size={20} />}</span><div><strong>{tr('Follow-up visit', 'Follow-up na pagbisita')}</strong><span className="m-sub">{visit ? visitWhen(visit) : tr('Not scheduled yet', 'Wala pang iskedyul')}</span></div></li>
      </ol>

      {tags.length > 0 && (
        <>
          <h2 className="m-label">{tr('Reported Today', 'Naiulat ngayon')}</h2>
          <div className="m-tag-list">{tags.map((t) => <span key={t} className="m-tag">{t}</span>)}</div>
        </>
      )}

      {alerts.length > 1 && (
        <>
          <h2 className="m-label" style={{ marginTop: '1.25rem' }}>{tr('Earlier alerts', 'Mga naunang alerto')}</h2>
          <div className="m-stack">
            {alerts.filter((a) => a.id !== latest.id).slice(0, 10).map((a) => {
              const ah = alertHeadline(a);
              return (
                <Link key={a.id} to={`${BASE}/alerts/${a.id}`} className="m-list-row">
                  <span className={`m-thumb tone-${TONE[a.severity] === 'high' ? 'critical' : TONE[a.severity] || 'info'}`} aria-hidden="true"><Icon name={a.source === 'weather' ? 'zap' : 'alert'} /></span>
                  <span className="m-grow"><strong>{reported(ah, lang)}{ah.value ? ` · ${ah.value}` : ''}</strong><span className="m-sub">{isToday(a.createdAt) ? clock(a.createdAt) : `${manilaDay(a.createdAt)} ${clock(a.createdAt)}`}</span></span>
                  <Icon name="chevron" />
                </Link>
              );
            })}
          </div>
        </>
      )}
    </>
  );
}

function FamilyDuties({ patientId }) {
  const tr = useT();
  return (
    <>
      <TopBar title={tr('Caregiver duties', 'Gawain ng tagapag-alaga')} back={BASE} />
      <p className="m-muted" style={{ marginBottom: '1rem' }}>{tr('What the caregiver has done today from the care plan the health center set up. View only.', 'Ang nagawa ng tagapag-alaga ngayon mula sa care plan ng health center.')}</p>
      <DutiesScreen patients={[{ id: patientId, fullName: '' }]} editable={false} />
    </>
  );
}

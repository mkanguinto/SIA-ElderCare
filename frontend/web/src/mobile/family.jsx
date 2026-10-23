// Family phone app (Figma F1-F4 + "Family care dashboard"): today, trends, medicines, alerts, alert detail, profile.
import React, { useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Link, navigate } from '../router';
import Icon from './icons';
import { ContactClinic } from './contact';
import { todaysDoses, SLOTS, slotOf, alertHeadline } from './data';
import { AlertsList, AlertDetail, Profile, useNotifications, CallClinic } from './common';
import { DoseRow, WeekStrip } from './caregiver';
import { DutiesScreen, DutiesSummary } from './duties';
import { StatusChip, statusLine } from './status';
import { conditionLabel, visitWhen, VISIT_TYPE_LABEL } from '../format';
import {
  MobileFrame, BottomNav, Greeting, TopBar, Chip, Loader, useT, usePrefs,
  isToday, clock, manilaDay, manilaHour, shortName, TONE,
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
  else if (sub.startsWith('/alerts/')) screen = <AlertDetail id={sub.split('/')[2]} back={`${BASE}/alerts`} callCaregiverLabel={tr('Call the caregiver', 'Tawagan ang tagapag-alaga')} />;
  else if (sub === '/alerts') screen = <AlertsList base={`${BASE}/alerts`} back={BASE} />;
  else if (sub === '/profile') screen = <Profile user={user} back={BASE} />;
  else if (sub === '/duties') screen = <FamilyDuties patientId={patientId} />;
  else if (sub === '/contact') screen = <ContactClinic user={user} patients={[{ id: patientId, name: '' }]} back={BASE} />;
  else screen = <Today user={user} patientId={patientId} />;
  return (
    <MobileFrame emergency>
      {screen}
      <BottomNav items={NAV(tr)} />
    </MobileFrame>
  );
}

/* ------------------------------ F1 today ------------------------------ */
const BP_WORD = {
  BP_HYPERTENSIVE_CRISIS: ['critical', 'Very high', 'Napakataas'],
  BP_HIGH: ['high', 'High', 'Mataas'],
  BP_ABOVE_BASELINE: ['moderate', 'Above usual', 'Mas mataas'],
  BP_LOW: ['high', 'Low', 'Mababa'],
};
const MOBILITY = {
  normal: ['ok', 'Walks alone', 'Nakakalakad mag-isa'],
  assisted: ['info', 'Needs help', 'Kailangan ng tulong'],
  wheelchair: ['info', 'Wheelchair', 'Wheelchair'],
  bedridden: ['info', 'In bed', 'Nakahiga'],
  fall_reported: ['critical', 'Had a fall', 'Nahulog'],
};

function Today({ user, patientId }) {
  const tr = useT();
  const { lang } = usePrefs();
  const data = usePatientData(patientId, 7);
  const alerts = useNotifications(patientId, 10);
  if (!data) return <><Greeting user={user} hello={tr('Hello,', 'Kumusta,')} alertsTo={`${BASE}/alerts`} /><Loader /></>;
  if (data.error) return <div className="m-error">{data.error}</div>;

  const p = data.patient;
  const name = shortName(p.fullName);
  const her = /^lolo/i.test(name) ? ['his', 'His'] : ['her', 'Her'];
  const latest = data.checkins[0];
  const today = latest && isToday(latest.recordedAt) ? latest : null;
  const bpReading = data.checkins.find((c) => c.vitals.systolic);
  const codes = new Set((bpReading ? bpReading.anomalies : []).map((a) => a.code));
  const bpKey = Object.keys(BP_WORD).find((k) => codes.has(k));
  const [bpTone, bpEn, bpFil] = bpKey ? BP_WORD[bpKey] : ['ok', 'Normal', 'Normal'];
  const base = p.baseline || {};
  const todayAlert = (alerts || []).find((a) => isToday(a.createdAt));
  const newAlerts = (alerts || []).filter((a) => isToday(a.createdAt)).length;
  const needsAttention = today && !['none', 'low'].includes(today.severity);
  const doses = todaysDoses(data.meds, data.checkins);
  const latestWith = (k) => data.checkins.find((c) => c.vitals[k] != null);
  const anomalyIn = (c, prefix) => c && c.anomalies.some((a) => a.code.startsWith(prefix));
  const hr = latestWith('heartRate');
  const temp = latestWith('temperatureC');
  const spo2 = latestWith('spo2');
  const mob = data.checkins.find((c) => c.mobilityStatus);
  const [mTone, mEn, mFil] = mob ? MOBILITY[mob.mobilityStatus] || MOBILITY.normal : ['ok', '–', '–'];

  return (
    <>
      <Greeting user={user} hello={tr('Hello,', 'Kumusta,')} alerts={newAlerts} alertsTo={`${BASE}/alerts`} />
      {/* One home: a short status line, then the blood-pressure card (design suggestion: no second headline). */}
      <div className="m-between" style={{ marginBottom: '.35rem' }}>
        <p style={{ fontWeight: 700, fontSize: '1.125rem' }}>{p.fullName}</p>
        <Chip tone={needsAttention ? 'critical' : today ? 'ok' : 'moderate'} icon={needsAttention ? 'alert' : today ? 'check' : 'clock'}>
          {needsAttention ? tr('Needs attention', 'Kailangang bantayan') : today ? tr('Doing well', 'Maayos') : tr('No check-in yet', 'Wala pang check-in')}
        </Chip>
      </div>
      <p className="m-muted" style={{ fontSize: '.9375rem' }}>
        {today ? tr(`Today's check-in was sent at ${clock(today.recordedAt)} by the caregiver.`, `Naipadala ang check-in ngayong ${clock(today.recordedAt)}.`)
          : latest ? tr(`Last check-in ${clock(latest.recordedAt)}, ${manilaDay(latest.recordedAt)}.`, `Huling check-in ${manilaDay(latest.recordedAt)}.`) : tr('No check-ins yet.', 'Wala pang check-in.')}
      </p>
      {latest && (
        <div className="m-row" style={{ gap: '.5rem', marginTop: '.5rem', alignItems: 'center' }}>
          <StatusChip status={latest.status} />
          <span className="m-caption" style={{ flex: 1 }}>{statusLine(latest, tr)}</span>
        </div>
      )}
      {(p.conditions.length > 0 || p.mobilityRestricted) && (
        <div className="m-pills" style={{ margin: '.6rem 0 .25rem', gap: '.35rem' }}>
          {p.conditions.map((c) => <Chip key={c}>{conditionLabel(c)}</Chip>)}
          {p.mobilityRestricted && <Chip tone="moderate">{tr('Limited mobility', 'Limitado ang galaw')}</Chip>}
        </div>
      )}

      <div style={{ marginBottom: '.75rem' }}><WeekStrip checkins={data.checkins} /></div>
      {bpReading && (
        <>
          <section className={`m-bp-hero tone-${bpTone === 'ok' ? 'ok' : bpTone}`} style={{ paddingBottom: '1.25rem', marginTop: '.75rem' }} aria-label={tr('Blood pressure', 'Presyon ng dugo')}>
            <div className="m-between">
              <span style={{ fontSize: '.8125rem', fontWeight: 700, letterSpacing: '.05em' }}>{tr('BLOOD PRESSURE', 'PRESYON NG DUGO')}</span>
              <Chip className="on-light" tone={bpTone}><span style={{ width: '.5rem', height: '.5rem', borderRadius: '50%', background: 'currentColor', display: 'inline-block' }} />{lang === 'fil' ? bpFil : bpEn}</Chip>
            </div>
            <p className="m-bp-value">{bpReading.vitals.systolic}/{bpReading.vitals.diastolic}<small>mmHg</small></p>
            <p style={{ fontSize: '.9375rem', lineHeight: 1.45 }}>
              {bpKey === 'BP_HYPERTENSIVE_CRISIS' || bpKey === 'BP_HIGH'
                ? tr(`Much higher than ${her[0]} usual ${base.systolic || 135}/${base.diastolic || 85}. The clinic has been told and a nurse is reviewing ${her[0]} case.`, `Mas mataas sa karaniwang ${base.systolic || 135}/${base.diastolic || 85}. Alam na ito ng klinika.`)
                : bpKey ? tr(`Different from ${her[0]} usual ${base.systolic}/${base.diastolic}. The clinic can see it.`, `Iba sa karaniwang ${base.systolic}/${base.diastolic}.`)
                  : tr(`Close to ${her[0]} usual ${base.systolic || ''}/${base.diastolic || ''}.`, `Malapit sa karaniwan.`)}
              {' '}<span className="m-caption" style={{ color: 'inherit' }}>{clock(bpReading.recordedAt)}{isToday(bpReading.recordedAt) ? '' : `, ${manilaDay(bpReading.recordedAt)}`}</span>
            </p>
            {todayAlert && <Link to={`${BASE}/alerts/${todayAlert.id}`} style={{ display: 'inline-block', marginTop: '.5rem', fontWeight: 700, textDecoration: 'none' }}>{tr('See details →', 'Tingnan →')}</Link>}
          </section>
          {/* Below the card, not overlapping it, so Big text never hides "See details". */}
          <div style={{ marginTop: '.75rem' }}><CallClinic label={tr('Contact the clinic', 'Tawagan ang klinika')} /></div>
        </>
      )}

      <div className="m-between"><h2 className="m-section-title">{tr('Latest vitals', 'Pinakabagong vital signs')}</h2>{latest && <strong style={{ color: 'var(--text-brand)' }}>{clock(latest.recordedAt)}</strong>}</div>
      <div className="m-tiles">
        <VitalTile icon="heartPulse" label={tr('Heart rate', 'Tibok ng puso')} value={hr && hr.vitals.heartRate} unit="bpm" bad={anomalyIn(hr, 'HR')} tr={tr} />
        <VitalTile icon="thermometer" label={tr('Temperature', 'Temperatura')} value={temp && temp.vitals.temperatureC} unit="°C" bad={anomalyIn(temp, 'TEMP')} tr={tr}
          note={temp && temp.environment && temp.environment.outsideTempC != null ? tr(`Outside was ${Math.round(temp.environment.outsideTempC)} °C`, `${Math.round(temp.environment.outsideTempC)} °C sa labas`) : null} />
        <VitalTile icon="lungs" label={tr('Oxygen', 'Oxygen')} value={spo2 && spo2.vitals.spo2} unit="%" bad={anomalyIn(spo2, 'SPO2')} tr={tr} />
        <div className={`m-tile tone-${mTone}`}>
          <div className="m-between"><span className="m-tile-icon"><Icon name="fall" size={20} /></span><Chip className="on-light" tone={mTone}>{mob ? tr('Reported', 'Naiulat') : tr('No data', 'Wala')}</Chip></div>
          <span className="m-tile-label">{tr('Mobility', 'Paggalaw')}</span>
          <span className="m-tile-value" style={{ fontSize: '1.375rem' }}>{lang === 'fil' ? mFil : mEn}</span>
        </div>
      </div>

      <div className="m-between"><h2 className="m-section-title">{tr('Medicines today', 'Gamot ngayon')}</h2><Link to={`${BASE}/medicines`} className="m-link">{tr('See all', 'Lahat')}</Link></div>
      <div className="m-stack">
        {doses.filter((d) => d.status === 'missed').concat(doses.filter((d) => d.status !== 'missed')).slice(0, 3).map((d) => <DoseRow key={d.id} d={d} tr={tr} />)}
        {!doses.length && <div className="m-note">{tr('No medicines prescribed.', 'Walang nakatakdang gamot.')}</div>}
      </div>

      <div className="m-between"><h2 className="m-section-title">{tr('Caregiver duties today', 'Gawain ng tagapag-alaga ngayon')}</h2></div>
      <DutiesSummary patientId={p.id} to={`${BASE}/duties`} LinkComponent={Link} />

      {data.visits[0] && (
        <>
          <h2 className="m-section-title">{tr('Next clinic visit', 'Susunod na pagbisita')}</h2>
          <div className="m-card m-row"><span className="m-thumb tone-ok"><Icon name="calendar" /></span>
            <div><strong>{visitWhen(data.visits[0])}</strong><p className="m-caption">{VISIT_TYPE_LABEL[data.visits[0].visitType]} · {data.visits[0].destination}</p></div></div>
        </>
      )}
    </>
  );
}

function VitalTile({ icon, label, value, unit, bad, tr, note }) {
  const tone = value == null ? '' : bad ? 'high' : 'ok';
  return (
    <div className={`m-tile ${tone ? `tone-${tone}` : ''}`}>
      <div className="m-between"><span className="m-tile-icon"><Icon name={icon} size={20} /></span>{value != null && <Chip className="on-light" tone={tone}>{bad ? tr('High', 'Mataas') : tr('Normal', 'Normal')}</Chip>}</div>
      <span className="m-tile-label">{label}</span>
      <span className="m-tile-value">{value ?? '–'}{value != null && <small>{unit}</small>}</span>
      {note && <span className="m-caption" style={{ marginTop: '.15rem' }}>{note}</span>}
    </div>
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
    const hrs = list.map((c) => c.vitals.heartRate).filter(Boolean);
    const worst = list.reduce((w, c) => (SEV_RANK[c.severity] > SEV_RANK[w] ? c.severity : w), 'none');
    out.push({ day: d, bp, hr: hrs.length ? Math.round(hrs.reduce((a, b) => a + b, 0) / hrs.length) : null, worst, count: list.length });
  }
  return out;
}

function Trends({ patientId }) {
  const tr = useT();
  const { lang } = usePrefs();
  const [days, setDays] = useState(7);
  const data = usePatientData(patientId, days);
  const series = useMemo(() => (data && data.checkins ? byDay(data.checkins, days) : []), [data, days]);
  const week = useMemo(() => (data && data.checkins ? byDay(data.checkins, 7) : []), [data]);
  if (!data) return <><TopBar title={tr('Trends', 'Trends')} back={BASE} /><Loader /></>;
  if (data.error) return <div className="m-error">{data.error}</div>;

  const base = data.patient.baseline || {};
  const withBp = series.filter((s) => s.bp);
  const half = Math.floor(withBp.length / 2);
  const avg = (l) => l.reduce((a, s) => a + s.bp.vitals.systolic, 0) / (l.length || 1);
  const delta = withBp.length >= 4 ? avg(withBp.slice(half)) - avg(withBp.slice(0, half)) : 0;
  const trend = delta > 5 ? ['critical', 'Rising', 'Tumataas', 'alert'] : delta < -5 ? ['ok', 'Falling', 'Bumababa', 'check'] : ['ok', 'Steady', 'Matatag', 'check'];
  const hrToday = series[series.length - 1].hr;
  const hrAvg = data.trends.heartRate.avg;
  const hrHigh = hrToday && (hrToday > 100 || hrToday < 50);

  return (
    <>
      <TopBar title={tr('Trends', 'Trends')} back={BASE} />
      <div className="m-seg" role="group" aria-label={tr('Period', 'Panahon')}>
        {[7, 30].map((d) => <button key={d} type="button" aria-pressed={days === d} onClick={() => setDays(d)}>{tr(`${d} days`, `${d} araw`)}</button>)}
      </div>
      <div className="m-stats">
        <div><span>{tr('Check-ins', 'Check-in')}</span><strong>{data.trends.totalCheckins}</strong></div>
        <div><span>{tr('Average BP', 'Average BP')}</span><strong>{data.trends.bloodPressure.avgSystolic ? `${data.trends.bloodPressure.avgSystolic}/${data.trends.bloodPressure.avgDiastolic}` : '–'}</strong></div>
        <div><span>{tr('Days with missed medicine', 'Araw na hindi nainom ang gamot')}</span><strong>{data.trends.missedMedicationDays}</strong></div>
        <div><span>{tr('Readings needing attention', 'Sukat na dapat bantayan')}</span><strong>{data.trends.highSeverityCheckins}</strong></div>
      </div>
      <div className="m-days">
        {week.map((d, i) => {
          const dt = new Date(`${d.day}T12:00:00+08:00`);
          const tone = d.count ? TONE[d.worst] : null;
          return (
            <div key={d.day} className={`m-day ${i === 6 ? 'is-today' : ''}`} title={d.count ? `${d.count} check-in(s), ${WORD[tone][0]}` : 'No check-in'}>
              {dt.toLocaleDateString(lang === 'fil' ? 'fil-PH' : 'en-PH', { weekday: 'short', timeZone: 'Asia/Manila' }).slice(0, 3)}
              <strong>{dt.getUTCDate()}</strong>
              <i style={{ background: tone ? ACCENT[tone] : 'transparent' }} />
            </div>
          );
        })}
      </div>

      <section className="m-card">
        <div className="m-between" style={{ alignItems: 'flex-start' }}>
          <div><h2 className="m-card-title" style={{ marginBottom: 0 }}>{tr('Blood pressure', 'Presyon ng dugo')}</h2>
            <p className="m-caption">{tr('Usual', 'Karaniwan')} {base.systolic ? `${base.systolic - 10}–${base.systolic + 5} / ${base.diastolic - 5}–${base.diastolic + 5}` : '–'}</p></div>
          <Chip tone={trend[0]} icon={trend[3]}>{lang === 'fil' ? trend[2] : trend[1]}</Chip>
        </div>
        <BpChart series={series} base={base} tr={tr} lang={lang} />
      </section>

      <section className="m-card">
        <div className="m-between" style={{ alignItems: 'flex-start' }}>
          <div><h2 className="m-card-title" style={{ marginBottom: 0 }}>{tr('Heart rate', 'Tibok ng puso')}</h2>
            <p className="m-caption">{tr(`Average ${hrAvg || '–'} bpm`, `Average ${hrAvg || '–'} bpm`)}</p></div>
          {hrToday && <Chip tone={hrHigh ? 'high' : 'ok'} icon={hrHigh ? 'alert' : 'check'}>{hrToday} {tr('today', 'ngayon')}</Chip>}
        </div>
        <HrChart series={series} tr={tr} />
      </section>
      <details className="m-card m-details">
        <summary>{tr('Show readings as a list', 'Ipakita bilang listahan')}</summary>
        <table className="m-table">
          <thead><tr><th>{tr('Day', 'Araw')}</th><th>BP</th><th>{tr('Heart', 'Puso')}</th><th>{tr('Status', 'Status')}</th></tr></thead>
          <tbody>
            {[...series].reverse().map((d) => (
              <tr key={d.day}>
                <td>{d.day.slice(5)}</td>
                <td>{d.bp ? `${d.bp.vitals.systolic}/${d.bp.vitals.diastolic}` : '–'}</td>
                <td>{d.hr || '–'}</td>
                <td>{d.count ? WORD[TONE[d.worst]][lang === 'fil' ? 1 : 0] : tr('No reading', 'Walang sukat')}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </details>
      <p className="m-caption" style={{ marginTop: '.75rem' }}>{tr('Each bar shows the top and bottom blood pressure numbers (highest reading of the day). Green band = usual range. A grey dash = no reading that day. Tap a bar for details.', 'Bawat bar ay itaas at ibabang numero ng presyon. Berdeng banda = karaniwan. Abong guhit = walang sukat.')}</p>
    </>
  );
}

const CH = { w: 320, h: 180, top: 10, bottom: 22, left: 30, right: 6 };
function useTip() {
  const [tip, setTip] = useState(null);
  return [tip, setTip];
}

function BpChart({ series, base, tr, lang }) {
  const [tip, setTip] = useTip();
  const vals = series.filter((s) => s.bp).flatMap((s) => [s.bp.vitals.systolic, s.bp.vitals.diastolic]);
  if (!vals.length) return <p className="m-muted" style={{ padding: '1rem 0' }}>{tr('No blood pressure readings in this period.', 'Walang sukat ng presyon.')}</p>;
  const lo = Math.min(60, ...vals) - 5;
  const hi = Math.max(160, ...vals) + 5;
  const y = (v) => CH.top + (1 - (v - lo) / (hi - lo)) * (CH.h - CH.top - CH.bottom);
  const step = (CH.w - CH.left - CH.right) / series.length;
  const bw = Math.max(3, Math.min(14, step * 0.45));
  const ticks = [80, 120, 160].filter((t) => t > lo && t < hi);
  const bandTop = base.systolic ? base.systolic + 5 : 140;
  const bandBot = base.diastolic ? base.diastolic - 5 : 80;
  return (
    <div style={{ position: 'relative', marginTop: '.75rem' }}>
      <svg className="m-chart" viewBox={`0 0 ${CH.w} ${CH.h}`} role="img" aria-label={tr('Blood pressure by day', 'Presyon bawat araw')} onMouseLeave={() => setTip(null)}>
        <rect className="band" x={CH.left} width={CH.w - CH.left - CH.right} y={y(bandTop)} height={y(bandBot) - y(bandTop)} rx="6" />
        {ticks.map((t) => <g key={t}><line className="grid" x1={CH.left} x2={CH.w - CH.right} y1={y(t)} y2={y(t)} strokeDasharray="2 4" /><text className="axis" x={CH.left - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
        {series.map((s, i) => {
          const cx = CH.left + step * i + step / 2;
          const show = series.length <= 7 || i % 5 === 0 || i === series.length - 1;
          const label = show && <text className="axis" x={cx} y={CH.h - 6} textAnchor="middle">{Number(s.day.slice(8))}</text>;
          if (!s.bp) return <g key={s.day}><line x1={cx - 4} x2={cx + 4} y1={CH.h - CH.bottom - 4} y2={CH.h - CH.bottom - 4} stroke="var(--text-muted)" strokeWidth="2" strokeLinecap="round"><title>{tr('No reading', 'Walang sukat')}</title></line>{label}</g>;
          const tone = TONE[s.bp.severity] || 'ok';
          const t = y(s.bp.vitals.systolic);
          const b = y(s.bp.vitals.diastolic);
          const tipText = `${s.day.slice(5)} · ${s.bp.vitals.systolic}/${s.bp.vitals.diastolic} · ${WORD[tone][lang === 'fil' ? 1 : 0]}`;
          return (
            <g key={s.day}>
              <rect x={cx - bw / 2} y={t} width={bw} height={Math.max(4, b - t)} rx={bw / 2} fill={ACCENT[tone]} />
              <rect className="hit" x={cx - step / 2} y={CH.top} width={step} height={CH.h - CH.top - CH.bottom} tabIndex="0" aria-label={tipText}
                onMouseEnter={() => setTip({ x: cx, y: t, text: tipText })} onFocus={() => setTip({ x: cx, y: t, text: tipText })} onClick={() => setTip({ x: cx, y: t, text: tipText })} onBlur={() => setTip(null)} />
              {label}
            </g>
          );
        })}
      </svg>
      {tip && <div className="m-tip" style={{ left: `${(tip.x / CH.w) * 100}%`, top: `${(tip.y / CH.h) * 100}%` }}>{tip.text}</div>}
      <div className="m-legend" aria-hidden="true">
        {['ok', 'moderate', 'high', 'critical'].map((k) => <span key={k}><i style={{ background: ACCENT[k] }} />{WORD[k][lang === 'fil' ? 1 : 0]}</span>)}
        <span><i style={{ background: 'var(--text-muted)', height: '.2rem', verticalAlign: '.2rem' }} />{tr('No reading', 'Walang sukat')}</span>
      </div>
    </div>
  );
}

function HrChart({ series, tr }) {
  const [tip, setTip] = useTip();
  const pts = series.map((s, i) => ({ ...s, i })).filter((s) => s.hr);
  if (pts.length < 2) return <p className="m-muted" style={{ padding: '1rem 0' }}>{tr('Not enough heart-rate readings yet.', 'Kulang pa ang sukat.')}</p>;
  const h = 110;
  const vals = pts.map((p) => p.hr);
  const lo = Math.min(55, ...vals) - 5;
  const hi = Math.max(105, ...vals) + 5;
  const step = (CH.w - CH.left - CH.right) / series.length;
  const x = (i) => CH.left + step * i + step / 2;
  const y = (v) => 8 + (1 - (v - lo) / (hi - lo)) * (h - 16);
  const d = pts.map((p, k) => `${k ? 'L' : 'M'}${x(p.i).toFixed(1)},${y(p.hr).toFixed(1)}`).join(' ');
  const last = pts[pts.length - 1];
  const lastHigh = last.hr > 100 || last.hr < 50;
  return (
    <div style={{ position: 'relative', marginTop: '.75rem' }}>
      <svg className="m-chart" viewBox={`0 0 ${CH.w} ${h}`} role="img" aria-label={tr('Heart rate by day', 'Tibok ng puso bawat araw')} onMouseLeave={() => setTip(null)}>
        {[60, 100].map((t) => <g key={t}><line className="grid" x1={CH.left} x2={CH.w - CH.right} y1={y(t)} y2={y(t)} strokeDasharray="2 4" /><text className="axis" x={CH.left - 6} y={y(t) + 4} textAnchor="end">{t}</text></g>)}
        <path className="hr-line" d={d} />
        <circle cx={x(last.i)} cy={y(last.hr)} r="5" fill={lastHigh ? 'var(--accent-critical)' : 'var(--bg-primary)'} stroke="#fff" strokeWidth="2" />
        {pts.map((p) => {
          const text = `${p.day.slice(5)} · ${p.hr} bpm`;
          return <rect key={p.day} className="hit" x={x(p.i) - step / 2} y="0" width={step} height={h} tabIndex="0" aria-label={text}
            onMouseEnter={() => setTip({ x: x(p.i), y: y(p.hr), text })} onFocus={() => setTip({ x: x(p.i), y: y(p.hr), text })} onClick={() => setTip({ x: x(p.i), y: y(p.hr), text })} onBlur={() => setTip(null)} />;
        })}
      </svg>
      {tip && <div className="m-tip" style={{ left: `${(tip.x / CH.w) * 100}%`, top: `${(tip.y / h) * 100}%` }}>{tip.text}</div>}
    </div>
  );
}

/* ------------------------------ F4 medicines ------------------------------ */
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
  const shown = doses.filter((d) => d.slot === slot);
  return (
    <>
      <TopBar title={tr('Medicines', 'Mga gamot')} back={BASE} />
      <section className="m-hero">
        <p className="m-eyebrow">{tr("Today's progress", 'Progreso ngayon')}</p>
        <h2>{tr(`${taken} of ${past.length || doses.length} taken`, `${taken} sa ${past.length || doses.length} nainom`)}</h2>
        <div className="m-bar on-hero" style={{ margin: '.75rem 0' }}><span style={{ width: `${(taken / (past.length || doses.length || 1)) * 100}%` }} /></div>
        <p className="m-muted">{missed
          ? tr(`${missed} missed dose${missed === 1 ? ' was' : 's were'} reported to the clinic.`, `${missed} hindi nainom ang naiulat sa klinika.`)
          : tr('Keep it up. Doses later today show as "Due".', 'Ipagpatuloy. Ang mga gamot mamaya ay "Mamaya".')}</p>
      </section>
      <div className="m-seg" style={{ margin: '1rem 0' }} role="group" aria-label={tr('Time of day', 'Oras')}>
        {SLOTS.map((s) => <button key={s.key} type="button" aria-pressed={slot === s.key} onClick={() => setSlot(s.key)}>{lang === 'fil' ? s.fil : s.en}</button>)}
      </div>
      <div className="m-stack">
        {shown.map((d) => <DoseRow key={d.id} d={d} tr={tr} />)}
        {!shown.length && <div className="m-note">{tr('No medicines at this time of day.', 'Walang gamot sa oras na ito.')}</div>}
      </div>
      <p className="m-caption" style={{ marginTop: '1rem' }}>{tr('Only the clinic can change prescriptions. Family members can view, not edit.', 'Klinika lang ang puwedeng magbago ng reseta.')}</p>
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

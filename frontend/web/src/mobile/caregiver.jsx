// Caregiver phone app (Figma C1-C6): home, 3-step check-in, sent screen, offline outbox, medicines, alerts, profile.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Link, navigate } from '../router';
import { age, relTime, initials, visitWhen, VISIT_TYPE_LABEL } from '../format';
import Icon from './icons';
import { readOutbox, queueCheckin, flushOutbox, onOutboxChange, todaysDoses, SLOTS, slotOf, vitalsWarning, vitalErrors, alertHeadline } from './data';
import { AlertsList, AlertDetail, Profile, useNotifications } from './common';
import { DutiesScreen } from './duties';
import { useOutsideWeather, WeatherCard, toEnvironment, DANGEROUS_HEAT } from './weather';
import { buildPlan, useChecklists, weekDays } from './plan';
import { useReminders, remindersSupported, remindersOn, enableReminders, disableReminders } from './reminders';
import { bluetoothSupported, readBloodPressure } from './bluetooth';
import {
  MobileFrame, BottomNav, Greeting, TopBar, Cta, Chip, Banner, Ring, Loader, useT, usePrefs,
  isToday, clock, hhmm, manilaHour, toneFor, shortName, CLINIC_PHONE, EMERGENCY_PHONE, TONE,
} from './kit';

const BASE = '/m/caregiver';

/** Patients assigned to the caregiver + today's check-ins for each. */
function useElders(user) {
  const [elders, setElders] = useState(null);
  const load = useCallback(() => Promise.all(user.patients.map(async (id) => {
    const [p, h, m, v] = await Promise.all([
      api(`/api/patients/${id}`).catch(() => ({ id, fullName: id, conditions: [] })),
      api(`/api/patients/${id}/history?days=7&limit=30`).catch(() => ({ checkins: [] })),
      api(`/api/patients/${id}/medications`).catch(() => ({ medications: [] })),
      api(`/api/patients/${id}/visits?view=upcoming`).catch(() => ({ visits: [] })),
    ]);
    return { ...p, checkins: h.checkins || [], meds: m.medications || [], visits: v.visits || [] };
  })).then(setElders), [user.patients]);
  useEffect(() => { load(); }, [load]);
  return [elders, load];
}

function useOutbox(userId) {
  const [items, setItems] = useState(() => readOutbox(userId));
  const [online, setOnline] = useState(navigator.onLine);
  useEffect(() => onOutboxChange(() => { setItems(readOutbox(userId)); setOnline(navigator.onLine); }), [userId]);
  // Re-send whenever the signal comes back, and once on open.
  useEffect(() => {
    if (online && readOutbox(userId).length) flushOutbox(userId).then(() => setItems(readOutbox(userId)));
  }, [online, userId]);
  return [items, online];
}

const NAV = (tr) => [
  { to: BASE, icon: 'home', label: tr('Home', 'Home') },
  { to: `${BASE}/duties`, icon: 'clipboard', label: tr('Duties', 'Gawain') },
  { to: `${BASE}/medicines`, icon: 'pill', label: tr('Meds', 'Gamot') },
  { to: `${BASE}/alerts`, icon: 'bell', label: tr('Alerts', 'Alerto'), exact: false },
  { to: `${BASE}/profile`, icon: 'user', label: tr('Me', 'Ako') },
];

export default function CaregiverApp({ user, path }) {
  const tr = useT();
  const sub = path.slice(BASE.length) || '/';
  let screen;
  if (sub.startsWith('/check-in')) screen = <CheckIn user={user} />;
  else if (sub === '/medicines') screen = <Medicines user={user} />;
  else if (sub === '/duties') screen = <Duties user={user} />;
  else if (sub.startsWith('/alerts/')) screen = <AlertDetail id={sub.split('/')[2]} back={`${BASE}/alerts`} />;
  else if (sub === '/alerts') screen = <CaregiverAlerts user={user} />;
  else if (sub === '/profile') screen = <Profile user={user} back={BASE} extra={<ReminderSetting />} />;
  else screen = <Home user={user} />;
  const wizard = sub.startsWith('/check-in');
  return (
    <MobileFrame plain={wizard}>
      {screen}
      {!wizard && <BottomNav items={NAV(tr)} />}
      <ReminderRunner user={user} />
    </MobileFrame>
  );
}

/* ------------------------------ C1 home / C6 offline ------------------------------ */
function Home({ user }) {
  const tr = useT();
  const [elders] = useElders(user);
  const [outbox, online] = useOutbox(user.id);
  const alerts = useNotifications(null, 20);
  const newAlerts = (alerts || []).filter((a) => isToday(a.createdAt)).length;
  const checklists = useChecklists(elders);
  const weather = useOutsideWeather(elders && elders[0]);
  const plan = useMemo(() => (elders ? buildPlan(elders, checklists) : []), [elders, checklists]);

  if (!online || outbox.length) return <Offline user={user} outbox={outbox} online={online} alerts={newAlerts} />;
  if (!elders) return <><Greeting user={user} alertsTo={`${BASE}/alerts`} /><Loader /></>;

  const status = elders.map((e) => {
    const today = e.checkins.filter((c) => isToday(c.recordedAt));
    return { ...e, latest: today[0] || null, last: e.checkins[0] || null };
  });
  const done = status.filter((s) => s.latest).length;
  const due = status.find((s) => !s.latest);
  const firstDose = due && due.meds.flatMap((m) => m.times).sort()[0];

  return (
    <>
      <Greeting user={user} alerts={newAlerts} alertsTo={`${BASE}/alerts`} />
      <section className="m-hero">
        <div className="m-row" style={{ alignItems: 'flex-start' }}>
          <div className="m-grow">
            <p className="m-eyebrow">{tr("Today's check-ins", 'Mga check-in ngayon')}</p>
            <h2>{tr(`${done} of ${status.length} done`, `${done} sa ${status.length} tapos na`)}</h2>
            <p className="m-muted">{due
              ? tr(`${shortName(due.fullName)} is due now${firstDose ? ` (${hhmm(firstDose)})` : ''}.`, `Kailangan nang i-check-in si ${shortName(due.fullName)}.`)
              : tr('Everyone is checked in for today.', 'Tapos na ang lahat ng check-in ngayon.')}</p>
          </div>
          <Ring value={status.length ? done / status.length : 0} label={tr(`${done} of ${status.length} check-ins done`, `${done} sa ${status.length} tapos`)} />
        </div>
        <div style={{ marginTop: '1rem' }}>
          <Cta onClick={() => navigate(`${BASE}/check-in${due ? `?patient=${due.id}` : ''}`)}>{tr('Start check-in', 'Simulan ang check-in')}</Cta>
        </div>
      </section>

      <nav className="m-quick" aria-label={tr('Quick actions', 'Mabilisang aksyon')}>
        <Link to={`${BASE}/check-in`} className="is-primary"><span className="m-quick-icon"><Icon name="clipboard" /></span>{tr('Check-in', 'Check-in')}</Link>
        <Link to={`${BASE}/medicines`}><span className="m-quick-icon"><Icon name="pill" /></span>{tr('Medicines', 'Gamot')}</Link>
        <a href={CLINIC_PHONE ? `tel:${CLINIC_PHONE}` : undefined} aria-disabled={!CLINIC_PHONE} title={CLINIC_PHONE ? undefined : 'Set VITE_CLINIC_PHONE'}><span className="m-quick-icon"><Icon name="phone" /></span>{tr('Call clinic', 'Klinika')}</a>
        <a href={`tel:${EMERGENCY_PHONE}`} className="is-danger"><span className="m-quick-icon"><Icon name="alert" /></span>{tr('Emergency', 'Emergency')}</a>
      </nav>

      {weather.status === 'ready' && DANGEROUS_HEAT.includes(weather.weather.heatLevel) && (
        <div style={{ marginTop: '1rem' }}><WeatherCard state={weather} fallbackLabel={elders[0].addressLine} /></div>
      )}
      <ReminderPrompt />

      <div className="m-between"><h2 className="m-section-title">{tr('Your elders', 'Iyong mga inaalagaan')}</h2></div>
      <div className="m-stack">
        {status.map((e) => {
          const sev = e.latest && e.latest.severity;
          const chip = !e.latest
            ? <Chip tone="moderate" icon="clock">{tr('Due now', 'Kailangan na')}</Chip>
            : sev === 'none' || sev === 'low' ? <Chip tone="ok" icon="check">{tr('Normal', 'Normal')}</Chip>
              : <Chip tone={TONE[sev]} icon="alert">{tr('Needs attention', 'Kailangang bantayan')}</Chip>;
          return (
            <Link key={e.id} to={`${BASE}/check-in?patient=${e.id}`} className="m-list-row">
              <span className={`m-avatar ${e.latest ? 'tone-blue' : 'tone-amber'}`} aria-hidden="true">{initials(e.fullName.replace(/^(Lola|Lolo) /, ''))}</span>
              <span className="m-grow">
                <strong>{e.fullName}</strong>
                <span className="m-sub">{e.latest
                  ? tr(`Checked in ${clock(e.latest.recordedAt)}${sev === 'none' ? ' · all normal' : ''}`, `Na-check-in ${clock(e.latest.recordedAt)}`)
                  : tr(`Due now · last check-in ${e.last ? relTime(e.last.recordedAt) : 'never'}`, `Kailangan na · huling check-in ${e.last ? relTime(e.last.recordedAt) : 'wala pa'}`)}</span>
                {chip}
                <WeekStrip checkins={e.checkins} />
              </span>
              <Icon name="chevron" />
            </Link>
          );
        })}
      </div>

      {status.flatMap((e) => e.visits.map((v) => ({ ...v, who: e.fullName }))).slice(0, 1).map((v) => (
        <section key={v.id} style={{ marginTop: '1rem' }}>
          <h2 className="m-section-title">{tr('Upcoming visit', 'Darating na bisita')}</h2>
          <div className="m-card m-row" style={{ alignItems: 'flex-start' }}>
            <span className="m-thumb tone-ok" aria-hidden="true"><Icon name="calendar" /></span>
            <div className="m-grow"><strong>{visitWhen(v)}</strong>
              <p className="m-muted" style={{ fontSize: '.9375rem' }}>{VISIT_TYPE_LABEL[v.visitType]} · {v.who}</p>
              <p className="m-caption">{v.destination}{v.location ? ` · ${v.location}` : ''}</p>
              {v.notes && <p className="m-caption">{tr('Note from the nurse:', 'Tala ng nars:')} {v.notes}</p>}</div>
          </div>
        </section>
      ))}

      <div className="m-between"><h2 className="m-section-title">{tr("Today's plan", 'Plano ngayon')}</h2><Link to={`${BASE}/duties`} className="m-link">{tr('All duties', 'Lahat ng gawain')}</Link></div>
      <TodayPlan plan={plan} />

      <h2 className="m-section-title">{tr('This week', 'Ngayong linggo')}</h2>
      <div className="m-stack">
        {status.flatMap((e) => e.checkins.map((c) => ({ ...c, who: e.fullName }))).sort((a, b) => b.recordedAt.localeCompare(a.recordedAt)).slice(0, 6).map((c) => (
          <div key={c.id} className="m-card" style={{ marginTop: 0, padding: '.875rem 1rem' }}>
            <div className="m-between">
              <strong>{c.vitals.systolic ? `BP ${c.vitals.systolic}/${c.vitals.diastolic}` : tr('No BP', 'Walang BP')}</strong>
              <Chip tone={TONE[c.severity] || 'ok'} icon={['none', 'low'].includes(c.severity) ? 'check' : 'alert'}>{SEVERITY_WORD[c.severity] ? tr(...SEVERITY_WORD[c.severity]) : c.severity}</Chip>
            </div>
            <p className="m-caption">{c.who} · {isToday(c.recordedAt) ? clock(c.recordedAt) : relTime(c.recordedAt)}
              {[c.vitals.heartRate && ` · ${c.vitals.heartRate} bpm`, c.vitals.temperatureC && ` · ${c.vitals.temperatureC} °C`, c.vitals.spo2 && ` · ${c.vitals.spo2}%`, c.vitals.bloodGlucose && ` · ${c.vitals.bloodGlucose} mg/dL`].filter(Boolean).join('')}
              {c.medication.taken === false ? tr(' · medicine missed', ' · hindi nainom ang gamot') : ''}</p>
          </div>
        ))}
      </div>
    </>
  );
}

const PLAN_STATUS = {
  done: ['ok', 'check', 'Done', 'Tapos'],
  skipped: ['moderate', 'x', 'Skipped', 'Nilaktawan'],
  missed: ['critical', 'alert', 'Missed', 'Hindi nagawa'],
  overdue: ['high', 'alert', 'Overdue', 'Huli na'],
  due: ['info', 'clock', 'Later', 'Mamaya'],
};
const PLAN_ICON = { checkin: 'clipboard', dose: 'pill', duty: 'heart' };

/** Check-ins, medicines and duties for all elders in one time-ordered list, with a "Now" marker. */
function TodayPlan({ plan }) {
  const tr = useT();
  const { lang } = usePrefs();
  const [showDone, setShowDone] = useState(false);
  if (!plan.length) return <div className="m-note">{tr('Nothing scheduled today.', 'Walang nakatakda ngayon.')}</div>;
  const now = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' }).format(new Date());
  const finished = plan.filter((i) => i.status === 'done' || i.status === 'skipped').length;
  const shown = showDone ? plan : plan.filter((i) => i.status !== 'done' && i.status !== 'skipped');
  const nowIndex = shown.findIndex((i) => i.time > now);
  return (
    <>
      <p className="m-caption" style={{ marginBottom: '.5rem' }}>
        {tr(`${finished} of ${plan.length} done today`, `${finished} sa ${plan.length} tapos ngayon`)} ·{' '}
        <button type="button" className="m-link" style={{ padding: 0, fontSize: 'inherit' }} onClick={() => setShowDone(!showDone)}>{showDone ? tr('Hide finished', 'Itago ang tapos') : tr('Show finished', 'Ipakita ang tapos')}</button>
      </p>
      <ol className="m-plan">
        {shown.map((i, n) => {
          const [tone, icon, en, fil] = PLAN_STATUS[i.status] || PLAN_STATUS.due;
          const to = i.kind === 'duty' ? `${BASE}/duties` : `${BASE}/check-in?patient=${i.patientId}`;
          return (
            <React.Fragment key={i.id}>
              {n === nowIndex && <li className="m-plan-now" aria-label={tr(`Now, ${hhmm(now)}`, `Ngayon, ${hhmm(now)}`)}><span>{tr('Now', 'Ngayon')} · {hhmm(now)}</span></li>}
              <li>
                <Link to={to} className={`m-plan-item is-${i.status}`}>
                  <span className="m-plan-time">{hhmm(i.time)}</span>
                  <span className={`m-thumb tone-${tone === 'high' ? 'moderate' : tone}`} style={{ width: '2.25rem', height: '2.25rem' }} aria-hidden="true"><Icon name={PLAN_ICON[i.kind]} size={18} /></span>
                  <span className="m-grow">
                    <strong>{lang === 'fil' ? i.titleFil : i.title}</strong>
                    <span className="m-sub">{i.who}{i.detail ? ` · ${i.detail}` : ''}</span>
                    <Chip tone={tone} icon={icon}>{tr(en, fil)}</Chip>
                  </span>
                </Link>
              </li>
            </React.Fragment>
          );
        })}
        {nowIndex === -1 && shown.length > 0 && <li className="m-plan-now"><span>{tr('Now', 'Ngayon')} · {hhmm(now)}</span></li>}
      </ol>
      {!shown.length && <div className="m-note">{tr('Everything for today is done.', 'Tapos na ang lahat ngayon.')}</div>}
    </>
  );
}

/** "5 of 7 days" with a dot per day (oldest left, today right). */
export function WeekStrip({ checkins }) {
  const tr = useT();
  const days = weekDays(checkins);
  const n = days.filter((d) => d.done).length;
  return (
    <span className="m-week" title={tr(`${n} of the last 7 days have a check-in`, `${n} sa huling 7 araw ay may check-in`)}>
      <span aria-hidden="true">{days.map((d) => <i key={d.day} className={d.done ? 'is-done' : ''} />)}</span>
      <span>{tr(`${n} of 7 days this week`, `${n} sa 7 araw ngayong linggo`)}</span>
    </span>
  );
}

/** Mounted once for the caregiver app: notifies about overdue plan items while the app is open. */
function ReminderRunner({ user }) {
  return remindersOn() ? <ReminderWatcher user={user} /> : null;
}

function ReminderWatcher({ user }) {
  const { lang } = usePrefs();
  const [elders, reload] = useElders(user);
  const checklists = useChecklists(elders);
  const plan = useMemo(() => (elders ? buildPlan(elders, checklists) : null), [elders, checklists]);
  useEffect(() => {
    const t = setInterval(reload, 5 * 60 * 1000);
    return () => clearInterval(t);
  }, [reload]);
  useReminders(plan, BASE, lang);
  return null;
}

function ReminderPrompt() {
  const tr = useT();
  const [on, setOn] = useState(remindersOn());
  const [hidden, setHidden] = useState(() => { try { return localStorage.getItem('eldercare.reminders') === 'off'; } catch { return false; } });
  if (on || hidden || !remindersSupported()) return null;
  return (
    <section className="m-card m-row" style={{ marginTop: '1rem', alignItems: 'flex-start' }}>
      <span className="m-thumb tone-ok" aria-hidden="true"><Icon name="bell" /></span>
      <div className="m-grow">
        <strong>{tr('Get reminders', 'Tumanggap ng paalala')}</strong>
        <p className="m-muted" style={{ fontSize: '.875rem', margin: '.2rem 0 .6rem' }}>{tr('A notification when a check-in, medicine or duty is 15 minutes late.', 'Abiso kapag 15 minutong huli ang check-in, gamot o gawain.')}</p>
        <div className="m-row">
          <button type="button" className="m-btn is-dark" style={{ minHeight: '2.75rem' }} onClick={async () => setOn((await enableReminders()) === 'granted')}>{tr('Turn on', 'I-on')}</button>
          <button type="button" className="m-link" onClick={() => { disableReminders(); setHidden(true); }}>{tr('Not now', 'Hindi muna')}</button>
        </div>
      </div>
    </section>
  );
}

function ReminderSetting() {
  const tr = useT();
  const [on, setOn] = useState(remindersOn());
  const [msg, setMsg] = useState('');
  if (!remindersSupported()) return null;
  return (
    <>
      <h2 className="m-section-title">{tr('Reminders', 'Mga paalala')}</h2>
      <div className="m-pills">
        <button type="button" className="m-pill" aria-pressed={on} onClick={async () => {
          if (on) { disableReminders(); setOn(false); return; }
          const p = await enableReminders();
          setOn(p === 'granted');
          setMsg(p === 'denied' ? tr('Notifications are blocked. Allow them for this site in your browser settings.', 'Naka-block ang abiso. Payagan ito sa browser settings.') : '');
        }}><Icon name="bell" size={18} />{on ? tr('Reminders on', 'Naka-on ang paalala') : tr('Turn on reminders', 'I-on ang paalala')}</button>
      </div>
      <p className="m-caption" style={{ marginTop: '.5rem' }}>{msg || tr('Reminders work while the app is open or installed on this phone.', 'Gumagana ang paalala habang bukas o naka-install ang app.')}</p>
    </>
  );
}

const SEVERITY_WORD = { none: ['Normal', 'Normal'], low: ['Normal', 'Normal'], moderate: ['Watch', 'Bantayan'], high: ['High', 'Mataas'], critical: ['Very high', 'Napakataas'] };

function Duties({ user }) {
  const tr = useT();
  const [elders] = useElders(user);
  return (
    <>
      <TopBar title={tr('Care duties', 'Mga gawain')} back={BASE} />
      <p className="m-muted" style={{ marginBottom: '1rem' }}>{tr('Tick off each duty when it is done. If you could not do one, skip it and say why.', 'Markahan ang bawat gawain kapag tapos na. Kung hindi nagawa, laktawan at sabihin kung bakit.')}</p>
      {!elders ? <Loader /> : <DutiesScreen patients={elders} editable />}
    </>
  );
}

function Offline({ user, outbox, online, alerts }) {
  const tr = useT();
  return (
    <>
      <Greeting user={user} alerts={alerts} alertsTo={`${BASE}/alerts`} />
      <Banner tone="moderate" icon="wifiOff" role="status">
        {online
          ? tr(`Sending ${outbox.length} saved check-in${outbox.length === 1 ? '' : 's'}…`, `Ipinapadala ang ${outbox.length} naka-save na check-in…`)
          : tr(`No signal. ${outbox.length || 'New'} check-in${outbox.length === 1 ? ' is' : 's are'} saved on this phone and will send automatically.`, `Walang signal. Naka-save sa phone ang ${outbox.length} check-in at kusang ipapadala.`)}
      </Banner>
      <div className="m-between"><h2 className="m-section-title">{tr('Waiting to send', 'Naghihintay ipadala')}</h2><strong style={{ color: 'var(--text-brand)' }}>{outbox.length}</strong></div>
      <div className="m-stack">
        {outbox.map((o) => (
          <div key={o.body.idempotencyKey} className="m-list-row" style={{ cursor: 'default' }}>
            <span className="m-thumb tone-moderate" aria-hidden="true"><Icon name="refresh" /></span>
            <span className="m-grow">
              <strong>{o.patientName}</strong>
              <span className="m-sub">{tr('Check-in', 'Check-in')} · {clock(o.body.recordedAt)} · {o.summary}</span>
              <Chip tone="moderate" icon="clock">{tr('Waiting to send', 'Naghihintay ipadala')}</Chip>
            </span>
          </div>
        ))}
        {!outbox.length && <div className="m-note">{tr('Check-ins you save while offline appear here.', 'Lalabas dito ang mga check-in na naka-save habang offline.')}</div>}
      </div>
      <div className="m-note" style={{ marginTop: '1rem' }}>
        <strong>{tr('Safe to close the app', 'Puwedeng isara ang app')}</strong>
        {tr('Each check-in has a unique code, so it is never sent twice, even if the signal comes and goes.', 'May sariling code ang bawat check-in kaya hindi ito maipapadala nang dalawang beses.')}
      </div>
      {online && <div style={{ marginTop: '1rem' }}><Cta onClick={() => flushOutbox(user.id)}>{tr('Send now', 'Ipadala ngayon')}</Cta></div>}
    </>
  );
}

/* ------------------------------ C2-C5 check-in wizard ------------------------------ */
const SYMPTOMS = [
  { key: 'fall', icon: 'fall', en: 'Fell or almost fell', fil: 'Nahulog o muntik mahulog', sub: ['The clinic will be alerted right away', 'Agad aabisuhan ang klinika'] },
  { key: 'dizzy', icon: 'pulse', en: 'Dizzy, weak or short of breath', fil: 'Nahihilo, nanghihina o hinihingal' },
  { key: 'eating', icon: 'heart', en: 'Not eating or drinking well', fil: 'Hindi kumakain o umiinom nang maayos' },
  { key: 'confused', icon: 'message', en: 'Seems confused or very sleepy', fil: 'Mukhang lito o sobrang antok' },
];
const REASONS = [
  ['Ran out of tablets', 'Naubusan ng gamot'],
  ['Refused to take it', 'Ayaw uminom'],
  ['Forgot', 'Nakalimutan'],
  ['Could not swallow / vomited', 'Hindi malunok / nagsuka'],
];
const STEP_NAMES = [['Vitals', 'Vital signs'], ['Medicines', 'Gamot'], ['Anything else?', 'May iba pa?']];

/** One Back button: each tap goes one step back (step 3 -> 2 -> 1). Answers are kept. */
function BackStep({ step, goTo }) {
  const tr = useT();
  const [en, fil] = STEP_NAMES[step - 2];
  return (
    <button type="button" className="m-btn is-block" onClick={() => goTo(step - 1)}>
      <Icon name="back" size={18} />{tr(`Back to step ${step - 1}: ${en.toLowerCase()}`, `Bumalik sa hakbang ${step - 1}: ${fil.toLowerCase()}`)}
    </button>
  );
}

/** Number input that shows its problem underneath straight away (red border + message). */
function VitalField({ k, label, value, onChange, error, hint, placeholder, decimal }) {
  const { lang } = usePrefs();
  const id = `vital-${k}`;
  return (
    <label className={`m-field ${error ? 'is-invalid' : ''}`} htmlFor={id}>
      <span>{label}</span>
      <input id={id} type="number" inputMode={decimal ? 'decimal' : 'numeric'} step={decimal ? '0.1' : '1'} min="0" value={value} onChange={onChange}
        placeholder={placeholder} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-err` : undefined} />
      {error ? <span className="m-field-error" id={`${id}-err`} role="alert">{lang === 'fil' ? error.fil : error.en}</span> : hint && <span className="m-hint">{hint}</span>}
    </label>
  );
}

const EMPTY_VITALS = { systolic: '', diastolic: '', heartRate: '', temperatureC: '', spo2: '', bloodGlucose: '' };
const MOBILITY = [['normal', 'Walks alone', 'Nakakalakad mag-isa'], ['assisted', 'Needs help', 'Kailangan ng tulong'], ['wheelchair', 'Wheelchair', 'Wheelchair'], ['bedridden', 'In bed', 'Nakahiga']];
const MOOD = [['good', 'Good', 'Mabuti'], ['neutral', 'Okay', 'Okay lang'], ['low', 'Low / sad', 'Malungkot'], ['agitated', 'Agitated', 'Balisa']];

function CheckIn({ user }) {
  const tr = useT();
  const { lang } = usePrefs();
  const [elders] = useElders(user);
  const [patientId, setPatientId] = useState(() => new URLSearchParams(window.location.search).get('patient') || user.patients[0]);
  const [picking, setPicking] = useState(false);
  const [step, setStep] = useState(1);
  const [vitals, setVitals] = useState(EMPTY_VITALS);
  const [given, setGiven] = useState({});
  const [reasons, setReasons] = useState({});
  const [symptoms, setSymptoms] = useState([]);
  const [mobility, setMobility] = useState(null);
  const [mood, setMood] = useState(null);
  const [notes, setNotes] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);

  const patient = elders && elders.find((e) => e.id === patientId);
  const [tried, setTried] = useState(false);
  const [bt, setBt] = useState({ busy: false, msg: '' });
  const errors = vitalErrors(vitals, { pair: tried });
  const hasErrors = Object.keys(errors).length > 0;
  const warning = hasErrors ? null : vitalsWarning(vitals);
  const slot = slotOf(`${String(manilaHour()).padStart(2, '0')}:00`);
  const meds = useMemo(() => {
    if (!patient) return [];
    const doses = todaysDoses(patient.meds, []).filter((d) => d.slot === slot);
    const ids = new Set(doses.map((d) => d.med.id));
    return ids.size ? patient.meds.filter((m) => ids.has(m.id)) : patient.meds;
  }, [patient, slot]);
  const slotInfo = SLOTS.find((s) => s.key === slot);
  const firstTime = meds.flatMap((m) => m.times).filter((t) => slotOf(t) === slot).sort()[0];

  const weather = useOutsideWeather(patient);
  const cancel = () => navigate(BASE);

  async function readMonitor() {
    setBt({ busy: true, msg: tr('Choose your monitor, then take a reading…', 'Piliin ang monitor at sumukat…') });
    try {
      const r = await readBloodPressure();
      setVitals((v) => ({ ...v, systolic: String(r.systolic), diastolic: String(r.diastolic), ...(r.heartRate ? { heartRate: String(r.heartRate) } : {}) }));
      setBt({ busy: false, msg: tr(`Read ${r.systolic}/${r.diastolic}${r.heartRate ? `, pulse ${r.heartRate}` : ''} from the monitor.`, `Nabasa: ${r.systolic}/${r.diastolic}.`) });
    } catch (e) {
      setBt({ busy: false, msg: e.name === 'NotFoundError' ? tr('No monitor was chosen.', 'Walang napiling monitor.') : e.message });
    }
  }
  const goTo = (n) => { setStep(n); window.scrollTo({ top: 0 }); };
  const set = (k) => (e) => setVitals((v) => ({ ...v, [k]: e.target.value }));

  function buildBody() {
    const num = (x) => (x === '' ? undefined : Number(x));
    const v = Object.fromEntries(Object.entries(vitals).map(([k, x]) => [k, num(x)]).filter(([, x]) => x !== undefined));
    const answered = meds.filter((m) => given[m.id] !== undefined);
    const missed = meds.filter((m) => given[m.id] === false).map((m) => `${m.name} ${m.dosage}${reasons[m.id] ? ` – ${reasons[m.id]}` : ''}`.slice(0, 100));
    const told = SYMPTOMS.filter((s) => symptoms.includes(s.key) && s.key !== 'fall' && s.key !== 'confused').map((s) => s.en);
    const noteText = [told.length ? `Reported: ${told.join('; ')}.` : '', notes.trim()].filter(Boolean).join(' ');
    return {
      patientId,
      idempotencyKey: `pwa-${crypto.randomUUID()}`,
      recordedAt: new Date().toISOString(),
      ...(Object.keys(v).length ? { vitals: v } : {}),
      ...(answered.length ? { medication: { taken: missed.length === 0, missed } } : {}),
      ...(symptoms.includes('fall') ? { mobilityStatus: 'fall_reported' } : mobility ? { mobilityStatus: mobility } : {}),
      ...(symptoms.includes('confused') ? { mood: 'confused' } : mood ? { mood } : {}),
      ...(noteText ? { notes: noteText.slice(0, 2000) } : {}),
      ...(weather.status === 'ready' ? { environment: toEnvironment(weather.weather) } : {}),
    };
  }

  async function submit() {
    setBusy(true);
    setError(null);
    const body = buildBody();
    try {
      const r = await api('/api/checkins', { method: 'POST', body });
      setSent({ checkin: r.checkin, offline: false });
    } catch (err) {
      if (err.status === 0) {
        const summary = body.vitals && body.vitals.systolic ? `BP ${body.vitals.systolic}/${body.vitals.diastolic}` : tr('saved', 'naka-save');
        queueCheckin(user.id, { body, patientName: patient ? patient.fullName : patientId, summary });
        setSent({ offline: true, body });
      } else setError((err.details || [err.message]).join('. '));
    } finally {
      setBusy(false);
    }
  }

  if (sent) return <Sent sent={sent} patient={patient} />;
  if (!elders) return <><TopBar title={tr('Daily check-in', 'Check-in ngayon')} back={BASE} /><Loader /></>;

  const label = tr(...STEP_NAMES[step - 1]);
  return (
    <>
      <header className="m-topbar">
        {/* Back goes one step back; on step 1 it leaves the check-in (nothing is sent). */}
        <button type="button" className="m-icon-btn" onClick={() => (step > 1 ? goTo(step - 1) : cancel())} aria-label={step > 1 ? tr(`Back to step ${step - 1}`, `Bumalik sa hakbang ${step - 1}`) : tr('Back to home', 'Bumalik sa home')}><Icon name="back" /></button>
        <h1>{tr('Daily check-in', 'Check-in ngayon')}</h1>
        <button type="button" className="m-icon-btn" onClick={cancel} aria-label={tr('Close', 'Isara')}><Icon name="x" /></button>
      </header>
      <div className="m-steps-label"><span>{tr(`Step ${step} of 3`, `Hakbang ${step} sa 3`)}</span><span>{label}</span></div>
      {/* Tappable stepper: jump back to any earlier step (answers are kept). */}
      <nav className="m-steps" aria-label={tr('Check-in steps', 'Mga hakbang')}>
        {STEP_NAMES.map(([en, fil], i) => (
          <button key={en} type="button" className={i + 1 <= step ? 'is-done' : ''} disabled={i + 1 > step} onClick={() => goTo(i + 1)}
            aria-current={i + 1 === step ? 'step' : undefined} aria-label={tr(`Step ${i + 1}: ${en}`, `Hakbang ${i + 1}: ${fil}`)} />
        ))}
      </nav>

      {step === 1 && (
        <div className="m-stack">
          <div className="m-card m-row" style={{ padding: '.875rem 1rem' }}>
            <span className={`m-avatar ${toneFor(patient ? patient.fullName : '')}`} aria-hidden="true" style={{ width: '2.5rem', height: '2.5rem', fontSize: '.875rem' }}>{patient ? initials(patient.fullName.replace(/^(Lola|Lolo) /, '')) : ''}</span>
            <div className="m-grow"><strong>{patient ? patient.fullName : patientId}</strong>
              <p className="m-caption">{patient && [age(patient.birthDate) && tr(`${age(patient.birthDate)} yrs`, `${age(patient.birthDate)} taon`), patient.addressLine].filter(Boolean).join(' · ')}</p></div>
            {elders.length > 1 && <button type="button" className="m-link" onClick={() => setPicking(!picking)} aria-expanded={picking}>{tr('Change', 'Palitan')}</button>}
          </div>
          {picking && (
            <div className="m-pills" role="radiogroup" aria-label={tr('Patient', 'Pasyente')}>
              {elders.map((e) => <button key={e.id} type="button" role="radio" aria-checked={e.id === patientId} className="m-pill" aria-pressed={e.id === patientId} onClick={() => { setPatientId(e.id); setGiven({}); setReasons({}); setPicking(false); }}>{e.fullName}</button>)}
            </div>
          )}
          <WeatherCard state={weather} fallbackLabel={patient ? patient.addressLine : ''} />
          <div className="m-between">
            <p style={{ fontWeight: 700, color: 'var(--text-secondary)', fontSize: '.875rem' }}>{tr('Blood pressure', 'Presyon ng dugo')}</p>
            {bluetoothSupported() && <button type="button" className="m-link" onClick={readMonitor} disabled={bt.busy}><Icon name="zap" size={16} /> {bt.busy ? tr('Connecting…', 'Kumokonekta…') : tr('Read from Bluetooth monitor', 'Basahin mula sa Bluetooth monitor')}</button>}
          </div>
          {bt.msg && <p className="m-caption" role="status">{bt.msg}</p>}
          <div className="m-grid-2">
            <VitalField k="systolic" label={tr('Top number', 'Itaas na numero')} value={vitals.systolic} onChange={set('systolic')} error={errors.systolic} placeholder={patient && patient.baseline && patient.baseline.systolic ? String(patient.baseline.systolic) : '120'} />
            <VitalField k="diastolic" label={tr('Bottom number', 'Ibabang numero')} value={vitals.diastolic} onChange={set('diastolic')} error={errors.diastolic} placeholder={patient && patient.baseline && patient.baseline.diastolic ? String(patient.baseline.diastolic) : '80'} />
            <VitalField k="heartRate" label={tr('Heart rate (bpm)', 'Tibok ng puso (bpm)')} value={vitals.heartRate} onChange={set('heartRate')} error={errors.heartRate} />
            <VitalField k="temperatureC" decimal label={tr('Body temperature (°C)', 'Temperatura ng katawan (°C)')} value={vitals.temperatureC} onChange={set('temperatureC')} error={errors.temperatureC} hint={tr('Use a thermometer', 'Gumamit ng thermometer')} />
          </div>
          <VitalField k="spo2" label={tr('Oxygen level SpO₂ (%)', 'Oxygen SpO₂ (%)')} value={vitals.spo2} onChange={set('spo2')} error={errors.spo2} hint={tr('Normal is 95% or higher', 'Normal ang 95% pataas')} />
          <VitalField k="bloodGlucose" label={tr('Blood sugar (mg/dL, optional)', 'Blood sugar (mg/dL, opsyonal)')} value={vitals.bloodGlucose} onChange={set('bloodGlucose')} error={errors.bloodGlucose} />
          {hasErrors && <Banner tone="critical" role="alert">{tr('Please fix the fields marked in red to continue.', 'Ayusin muna ang mga pulang field para magpatuloy.')}</Banner>}
          {warning && <Banner tone={warning.tone} role="alert">{lang === 'fil' ? warning.fil : warning.en}</Banner>}
          <div className="m-footer-actions"><Cta onClick={() => { setTried(true); if (!Object.keys(vitalErrors(vitals, { pair: true })).length) goTo(2); }} disabled={hasErrors}>{tr('Next: medicines', 'Susunod: gamot')}</Cta></div>
        </div>
      )}

      {step === 2 && (
        <div className="m-stack">
          <h2 style={{ fontSize: '1.25rem' }}>{tr(`${slotInfo.en} medicines`, `Gamot sa ${slotInfo.fil.toLowerCase()}`)}{firstTime ? ` (${hhmm(firstTime)})` : ''}</h2>
          {!meds.length && <div className="m-note">{tr('No medicines are prescribed. Tap Next.', 'Walang nakatakdang gamot. Pindutin ang Susunod.')}</div>}
          {meds.map((m) => (
            <div key={m.id} className="m-card" style={{ marginTop: 0 }}>
              <div className="m-med">
                <span className="m-thumb" aria-hidden="true"><Icon name="pill" /></span>
                <div><strong>{m.name}</strong><span className="m-sub">{m.dosage}{m.instructions ? ` · ${m.instructions}` : ''}</span></div>
              </div>
              <div className="m-given" role="group" aria-label={m.name}>
                <button type="button" className="is-given" aria-pressed={given[m.id] === true} onClick={() => setGiven((g) => ({ ...g, [m.id]: true }))}><Icon name="check" size={18} />{tr('Given', 'Naibigay')}</button>
                <button type="button" className="is-missed" aria-pressed={given[m.id] === false} onClick={() => setGiven((g) => ({ ...g, [m.id]: false }))}><Icon name="x" size={18} />{tr('Not given', 'Hindi naibigay')}</button>
              </div>
              {given[m.id] === false && (
                <>
                  <div className="m-pills" style={{ marginTop: '.75rem' }} role="radiogroup" aria-label={tr('Reason', 'Dahilan')}>
                    {REASONS.map(([en, fil]) => <button key={en} type="button" className="m-pill" style={{ minHeight: '2.5rem', fontSize: '.875rem' }} aria-pressed={reasons[m.id] === en} onClick={() => setReasons((r) => ({ ...r, [m.id]: en }))}>{lang === 'fil' ? fil : en}</button>)}
                  </div>
                  <p className="m-reason">{reasons[m.id] ? tr(`Reason: ${reasons[m.id].toLowerCase()}. The clinic will be told.`, 'Sasabihan ang klinika.') : tr('Pick a reason. The clinic will be told.', 'Pumili ng dahilan. Sasabihan ang klinika.')}</p>
                </>
              )}
            </div>
          ))}
          <div className="m-footer-actions">
            <BackStep step={step} goTo={goTo} />
            <Cta onClick={() => goTo(3)}>{tr('Next: anything else?', 'Susunod: may iba pa?')}</Cta>
          </div>
        </div>
      )}

      {step === 3 && (
        <div className="m-stack">
          <h2 style={{ fontSize: '1.25rem' }}>{tr('Tap anything that happened today', 'Pindutin ang nangyari ngayong araw')}</h2>
          {SYMPTOMS.map((s) => {
            const on = symptoms.includes(s.key);
            return (
              <label key={s.key} className={`m-check ${on ? 'is-on' : ''}`}>
                <input type="checkbox" checked={on} onChange={() => setSymptoms((l) => (on ? l.filter((x) => x !== s.key) : [...l, s.key]))} />
                <span className="m-thumb" style={{ width: '2.5rem', height: '2.5rem', background: on ? '#fff' : undefined }} aria-hidden="true"><Icon name={s.icon} size={20} /></span>
                <span className="m-grow"><strong>{lang === 'fil' ? s.fil : s.en}</strong>{s.sub && <span className="m-sub">{lang === 'fil' ? s.sub[1] : s.sub[0]}</span>}</span>
                <span className="m-box" aria-hidden="true"><Icon name="check" size={18} strokeWidth={3} /></span>
              </label>
            );
          })}
          <fieldset className="m-fieldset"><legend>{tr('Moving around', 'Paggalaw')}</legend>
            <div className="m-pills">{MOBILITY.map(([k, en, fil]) => <button key={k} type="button" className="m-pill" aria-pressed={mobility === k} disabled={symptoms.includes('fall')} onClick={() => setMobility(mobility === k ? null : k)}>{tr(en, fil)}</button>)}</div>
          </fieldset>
          <fieldset className="m-fieldset"><legend>{tr('Mood', 'Pakiramdam')}</legend>
            <div className="m-pills">{MOOD.map(([k, en, fil]) => <button key={k} type="button" className="m-pill" aria-pressed={mood === k} disabled={symptoms.includes('confused')} onClick={() => setMood(mood === k ? null : k)}>{tr(en, fil)}</button>)}</div>
          </fieldset>
          <label className="m-field"><span>{tr('Notes for the nurse (optional)', 'Tala para sa nars (opsyonal)')}</span><textarea rows="3" maxLength={1500} value={notes} onChange={(e) => setNotes(e.target.value)} /></label>
          {error && <p className="m-error" role="alert">{error}</p>}
          <div className="m-footer-actions">
            <BackStep step={step} goTo={goTo} />
            <Cta onClick={submit} disabled={busy || hasErrors}>{busy ? tr('Sending…', 'Ipinapadala…') : tr('Send check-in', 'Ipadala ang check-in')}</Cta></div>
        </div>
      )}
    </>
  );
}

/** C5: what happened after the check-in, from the real alert record (delivery + timing). */
function Sent({ sent, patient }) {
  const tr = useT();
  const [alert, setAlert] = useState(undefined);
  const c = sent.checkin;
  const flagged = c && c.severity !== 'none' && c.severity !== 'low';
  const name = patient ? patient.fullName : '';
  const short = shortName(name);

  useEffect(() => {
    if (!c || !flagged) return undefined;
    let tries = 0;
    let live = true;
    const look = () => api(`/api/alerts/notifications?patientId=${c.patientId}&pageSize=5`).then((r) => {
      const hit = r.notifications.find((n) => n.metadata && n.metadata.checkinId === c.id);
      if (!live) return;
      if (hit) setAlert(hit);
      else if (++tries < 6) setTimeout(look, 1000);
      else setAlert(null);
    }).catch(() => live && setAlert(null));
    look();
    return () => { live = false; };
  }, [c && c.id]); // eslint-disable-line react-hooks/exhaustive-deps

  if (sent.offline) {
    return (
      <>
        <div className="m-done-mark" style={{ background: 'var(--bg-moderate)', color: 'var(--text-moderate)' }}><Icon name="wifiOff" size={36} /></div>
        <h1 style={{ textAlign: 'center', fontSize: '1.625rem' }}>{tr('Saved on this phone', 'Naka-save sa phone')}</h1>
        <p className="m-muted" style={{ textAlign: 'center', margin: '.5rem 0 1.25rem' }}>{name} · {clock(sent.body.recordedAt)}</p>
        <Banner tone="moderate" icon="wifiOff">{tr('No signal right now. It will send by itself when the signal returns.', 'Walang signal. Kusang ipapadala kapag may signal na.')}</Banner>
        <div className="m-footer-actions"><Cta onClick={() => navigate(BASE)}>{tr('Back to home', 'Bumalik sa home')}</Cta></div>
      </>
    );
  }

  const top = (c.anomalies || [])[0];
  const h = alert ? alertHeadline(alert) : null;
  const secs = alert ? Math.max(0.1, (new Date(alert.createdAt) - new Date(c.createdAt)) / 1000).toFixed(1) : null;
  const sms = alert ? (alert.delivery || []).filter((d) => d.channel === 'sms') : [];
  return (
    <>
      <div className="m-done-mark"><Icon name="check" size={40} strokeWidth={3} /></div>
      <h1 style={{ textAlign: 'center', fontSize: '1.75rem' }}>{tr('Check-in sent', 'Naipadala ang check-in')}</h1>
      <p className="m-muted" style={{ textAlign: 'center', margin: '.5rem 0 1.25rem' }}>{name} · {clock(c.recordedAt)}</p>
      {flagged && top && (
        <Banner tone={TONE[c.severity]} role="alert">
          {h && h.value ? `${h.title} (${h.value}). ` : `${top.message}. `}
          {tr(`${short.startsWith('Lolo') ? 'His' : 'Her'} family and the clinic were alerted.`, 'Naabisuhan ang pamilya at klinika.')}
        </Banner>
      )}
      {!flagged && <Banner tone="ok" icon="checkCircle">{tr('All readings look normal.', 'Normal ang lahat ng sukat.')}</Banner>}
      <section className="m-card" style={{ marginTop: '.75rem' }}>
        <h2 className="m-card-title">{tr('What happens next', 'Ano ang susunod')}</h2>
        <ul className="m-steps-list">
          {flagged ? (
            <>
              <li>
                <span style={{ color: alert ? 'var(--accent-ok)' : 'var(--accent-moderate)' }}><Icon name={alert ? 'checkCircle' : 'clock'} /></span>
                <div><strong>{alert ? tr('Family notified', 'Naabisuhan ang pamilya') : alert === null ? tr('Family alert queued', 'Nakapila ang alerto') : tr('Notifying family…', 'Inaabisuhan ang pamilya…')}</strong>
                  <span className="m-sub">{alert ? tr(`${sms.length ? 'SMS + ' : ''}app alert`, `${sms.length ? 'SMS + ' : ''}alerto sa app`) : tr('Sent through the message queue', 'Ipinadala sa message queue')}</span></div>
                {secs && <span className="m-time">{secs} s</span>}
              </li>
              <li>
                <span style={{ color: 'var(--accent-ok)' }}><Icon name="checkCircle" /></span>
                <div><strong>{tr('Clinic queue updated', 'Na-update ang clinic queue')}</strong><span className="m-sub">{tr(`${short} was added to the risk queue`, `Idinagdag si ${short} sa risk queue`)}</span></div>
              </li>
              <li>
                <span style={{ color: 'var(--accent-moderate)' }}><Icon name="clock" /></span>
                <div><strong>{tr('A nurse will review it', 'Susuriin ito ng nars')}</strong><span className="m-sub">{tr('Keep your phone nearby', 'Panatilihing malapit ang phone')}</span></div>
                <span className="m-time">{tr('Next', 'Susunod')}</span>
              </li>
            </>
          ) : (
            <li>
              <span style={{ color: 'var(--accent-ok)' }}><Icon name="checkCircle" /></span>
              <div><strong>{tr('Saved to the record', 'Naitala')}</strong><span className="m-sub">{tr('Family can see it in their app. No alert needed.', 'Makikita ng pamilya sa app. Walang kailangang alerto.')}</span></div>
            </li>
          )}
        </ul>
      </section>
      <div className="m-footer-actions">
        {CLINIC_PHONE && <a className="m-btn is-block" href={`tel:${CLINIC_PHONE}`}>{tr('Call the clinic', 'Tawagan ang klinika')}</a>}
        <Cta onClick={() => navigate(BASE)}>{tr('Back to home', 'Bumalik sa home')}</Cta>
      </div>
    </>
  );
}

/* ------------------------------ medicines / alerts ------------------------------ */
const DOSE_CHIP = {
  taken: ['ok', 'check', 'Taken', 'Nainom'],
  missed: ['critical', 'alert', 'Missed', 'Hindi nainom'],
  due: ['info', 'clock', 'Due', 'Mamaya'],
  unknown: ['moderate', 'clock', 'Not recorded', 'Hindi naitala'],
};
export function DoseRow({ d, tr }) {
  const [tone, icon, en, fil] = DOSE_CHIP[d.status];
  return (
    <div className="m-card m-med" style={{ marginTop: 0 }}>
      <span className="m-thumb" aria-hidden="true"><Icon name="pill" /></span>
      <div className="m-grow"><strong>{d.med.name} {d.med.dosage}</strong><span className="m-sub">{d.med.instructions || d.med.frequency} · {hhmm(d.time)}</span></div>
      <Chip tone={tone} icon={icon}>{tr(en, fil)}{d.status === 'taken' && d.at ? ` ${clock(d.at).replace(/ [AP]M$/, '')}` : d.status === 'due' ? ` ${hhmm(d.time)}` : ''}</Chip>
    </div>
  );
}

function Medicines({ user }) {
  const tr = useT();
  const [elders] = useElders(user);
  return (
    <>
      <TopBar title={tr('Medicines', 'Mga gamot')} back={BASE} />
      {!elders && <Loader />}
      {(elders || []).map((e) => {
        const doses = todaysDoses(e.meds, e.checkins);
        return (
          <section key={e.id} style={{ marginBottom: '1.25rem' }}>
            <h2 className="m-section-title" style={{ marginTop: 0 }}>{e.fullName}</h2>
            <div className="m-stack">
              {doses.length ? doses.map((d) => <DoseRow key={d.id} d={d} tr={tr} />) : <div className="m-note">{tr('No medicines prescribed.', 'Walang nakatakdang gamot.')}</div>}
            </div>
          </section>
        );
      })}
      <p className="m-caption">{tr('Record medicines in the daily check-in. Only the clinic can change prescriptions.', 'Itala ang gamot sa check-in. Klinika lang ang puwedeng magbago ng reseta.')}</p>
    </>
  );
}

function CaregiverAlerts({ user }) {
  const [names, setNames] = useState({});
  useEffect(() => {
    Promise.all(user.patients.map((id) => api(`/api/patients/${id}`).then((p) => [id, p.fullName]).catch(() => [id, id]))).then((l) => setNames(Object.fromEntries(l)));
  }, [user.patients]);
  return <AlertsList base={`${BASE}/alerts`} patientNames={names} back={BASE} />;
}

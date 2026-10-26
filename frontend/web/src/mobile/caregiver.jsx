// Caregiver phone app (Figma C1-C6): home, 3-step check-in, sent screen, offline outbox, medicines, alerts, profile.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api, loadDraft } from '../api';
import { Link, navigate } from '../router';
import { age, relTime, initials, visitWhen, VISIT_TYPE_LABEL, conditionLabel } from '../format';
import Icon from './icons';
import { readOutbox, queueCheckin, flushOutbox, onOutboxChange, todaysDoses, SLOTS, slotOf, vitalsWarning, vitalErrors, alertHeadline, MISSING_REASONS, vitalsSummary } from './data';
import { AlertsList, AlertDetail, Profile, useNotifications } from './common';
import { DutiesScreen } from './duties';
import { useOutsideWeather, WeatherCard, toEnvironment, DANGEROUS_HEAT } from './weather';
import { buildPlan, useChecklists, weekDays } from './plan';
import { useReminders, remindersSupported, remindersOn, enableReminders, disableReminders } from './reminders';
import { bluetoothSupported, readBloodPressure } from './bluetooth';
import { StatusChip, StatusTimeline, statusLine } from './status';
import { useRestoredDraft, useKeepDraft, DraftNotice } from './drafts';
import { ContactClinic } from './contact';
import { Intro, introSeen } from './intro';
import { SelectOther } from '../components/ui';
import { Avatar, Badge, WeekDots, QuickAction, PatientPicker, SwitchPill, usePeople, sirenIcon } from './figma';
import {
  MobileFrame, BottomNav, Greeting, TopBar, Cta, Chip, Banner, Ring, Loader, useT, usePrefs,
  isToday, clock, hhmm, manilaHour, toneFor, shortName, EMERGENCY_PHONE, TONE,
} from './kit';

const BASE = '/m/caregiver';

/** Patients assigned to the caregiver + today's check-ins for each. */
function useElders(user) {
  const [elders, setElders] = useState(null);
  const load = useCallback(() => Promise.all(user.patients.map(async (id) => {
    const [p, h, m, v, c] = await Promise.all([
      api(`/api/patients/${id}`).catch(() => ({ id, fullName: id, conditions: [] })),
      api(`/api/patients/${id}/history?days=7&limit=30`).catch(() => ({ checkins: [] })),
      api(`/api/patients/${id}/medications`).catch(() => ({ medications: [] })),
      api(`/api/patients/${id}/visits?view=upcoming`).catch(() => ({ visits: [] })),
      api(`/api/patients/${id}/case`).catch(() => ({ case: null })),
    ]);
    return { ...p, checkins: h.checkins || [], meds: m.medications || [], visits: v.visits || [], case: c.case || null };
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
  const [intro, setIntro] = useState(() => !introSeen(user.id));
  let screen;
  if (intro || sub === '/intro') screen = <Intro user={user} onDone={() => { setIntro(false); if (sub === '/intro') navigate(BASE); }} />;
  else if (sub.startsWith('/check-in')) screen = <CheckIn user={user} />;
  else if (sub === '/medicines') screen = <Medicines user={user} />;
  else if (sub === '/duties') screen = <Duties user={user} />;
  else if (sub.startsWith('/alerts/')) screen = <AlertDetail id={sub.split('/')[2]} back={`${BASE}/alerts`} />;
  else if (sub === '/alerts') screen = <CaregiverAlerts user={user} />;
  else if (sub === '/profile') screen = <Profile user={user} back={BASE} notifications={remindersSupported() ? <ReminderSwitch /> : null} />;
  else if (sub.startsWith('/checkins/')) screen = <CheckinDetail id={sub.split('/')[2]} />;
  else if (sub === '/patients') screen = <Patients user={user} />;
  else if (sub.startsWith('/patients/')) screen = <PatientProfile user={user} patientId={decodeURIComponent(sub.split('/')[2])} />;
  else if (sub === '/contact') screen = <CaregiverContact user={user} />;
  else screen = <Home user={user} />;
  const wizard = sub.startsWith('/check-in') || intro || sub === '/intro';
  return (
    <MobileFrame plain={wizard} light>
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
  const weather = useOutsideWeather(elders && elders[0]);
  const [unsent] = useState(() => loadDraft('checkin'));

  if (!online || outbox.length) return <Offline user={user} outbox={outbox} online={online} alerts={newAlerts} />;
  if (!elders) return <><Greeting user={user} alertsTo={`${BASE}/alerts`} /><Loader /></>;

  const status = elders.map((e) => {
    const today = e.checkins.filter((c) => isToday(c.recordedAt));
    return { ...e, latest: today[0] || null, last: e.checkins[0] || null };
  });
  const done = status.filter((s) => s.latest).length;
  const due = status.find((s) => !s.latest);
  const firstDose = due && due.meds.flatMap((m) => m.times).sort()[0];
  const visit = status.flatMap((e) => e.visits.map((v) => ({ ...v, who: e.fullName })))[0];

  return (
    <>
      <Greeting user={user} alerts={newAlerts} alertsTo={`${BASE}/alerts`} />
      {unsent && (
        <Banner tone="warning" icon="clipboard" role="status">
          {tr('You have a check-in that was not sent yet.', 'May check-in na hindi pa naipadala.')}{' '}
          <Link to={`${BASE}/check-in?patient=${encodeURIComponent(unsent.data.patientId)}`} className="m-link" style={{ padding: 0, minHeight: 0 }}>{tr('Continue it', 'Ituloy')}</Link>
        </Banner>
      )}
      <section className="m-hero">
        <div className="m-row" style={{ alignItems: 'flex-start' }}>
          <div className="m-grow">
            <p className="m-eyebrow">{tr("Today's check-ins", 'Mga check-in ngayon')}</p>
            <h2>{tr(`${done} of ${status.length} done`, `${done} sa ${status.length} tapos na`)}</h2>
            <p className="m-muted">{due
              ? tr(`${shortName(due.fullName)} is due now${firstDose ? ` (${hhmm(firstDose)})` : ''}.`, `Kailangan nang i-check-in si ${shortName(due.fullName)}.`)
              : tr('Everyone is checked in for today', 'Tapos na ang lahat ng check-in ngayon')}</p>
          </div>
          <Ring value={status.length ? done / status.length : 0} label={tr(`${done} of ${status.length} check-ins done`, `${done} sa ${status.length} tapos`)} />
        </div>
        <div style={{ marginTop: '1rem' }}>
          {due
            ? <Cta onClick={() => navigate(`${BASE}/check-in?patient=${due.id}`)}>{tr('Start check-in', 'Simulan ang check-in')}</Cta>
            : <Cta onClick={() => navigate(`${BASE}/patients/${status[0].id}`)}>{tr('View summary', 'Tingnan ang buod')}</Cta>}
        </div>
      </section>

      <h2 className="m-label" style={{ marginTop: '1.25rem' }}>{tr('Quick Actions', 'Mabilisang aksyon')}</h2>
      <nav className="m-qa" aria-label={tr('Quick actions', 'Mabilisang aksyon')}>
        <QuickAction to={`${BASE}/check-in`} LinkComponent={Link} icon="clipboard" label={tr('Check-in', 'Check-in')} />
        <QuickAction to={`${BASE}/medicines`} LinkComponent={Link} icon="pill" label={tr('Medicines', 'Gamot')} />
        <QuickAction to={`${BASE}/contact`} LinkComponent={Link} icon="phone" label={tr('Call clinic', 'Klinika')} />
        <QuickAction href={`tel:${EMERGENCY_PHONE}`} img={sirenIcon} danger label={tr('Emergency', 'Emergency')} />
      </nav>

      {weather.status === 'ready' && DANGEROUS_HEAT.includes(weather.weather.heatLevel) && (
        <div style={{ marginTop: '1rem' }}><WeatherCard state={weather} fallbackLabel={elders[0].addressLine} /></div>
      )}
      <ReminderPrompt />

      <div className="m-between" style={{ marginTop: '1.25rem' }}>
        <h2 className="m-label" style={{ margin: 0 }}>{tr('Your Patients', 'Iyong mga pasyente')}</h2>
        <Link to={`${BASE}/patients`} className="m-link">{tr('See all', 'Lahat')}</Link>
      </div>
      <div style={{ marginTop: '.75rem' }}>
        {status.map((e) => <PatientCard key={e.id} e={e} tr={tr} />)}
      </div>

      {visit && (
        <section style={{ marginTop: '1rem' }}>
          <h2 className="m-label">{tr('Upcoming visit', 'Darating na bisita')}</h2>
          <div className="m-card m-row" style={{ alignItems: 'flex-start' }}>
            <span className="m-thumb tone-ok" aria-hidden="true"><Icon name="calendar" /></span>
            <div className="m-grow"><strong>{visitWhen(visit)}</strong>
              <p className="m-muted" style={{ fontSize: '.9375rem' }}>{VISIT_TYPE_LABEL[visit.visitType]} · {visit.who}</p>
              <p className="m-caption">{visit.destination}{visit.location ? ` · ${visit.location}` : ''}</p>
              {visit.notes && <p className="m-caption">{tr('Note from the nurse:', 'Tala ng nars:')} {visit.notes}</p>}</div>
          </div>
        </section>
      )}
    </>
  );
}

/** Grey patient card: name, today's state, last check-in time, the week's dots. */
function PatientCard({ e, tr }) {
  const sev = e.latest && e.latest.severity;
  // A flagged reading the clinic has since closed (visit done / case resolved) is no longer "needs attention".
  const followedUp = e.latest && e.case && e.case.closed && new Date(e.case.closedAt) >= new Date(e.latest.recordedAt);
  const badge = !e.latest ? <Badge tone="moderate">{tr('Due now', 'Kailangan na')}</Badge>
    : sev === 'none' || sev === 'low' ? <Badge>{tr('All Normal', 'Normal lahat')}</Badge>
      : followedUp ? <Badge>{tr('Followed up', 'Na-follow up')}</Badge>
        : <Badge tone="critical">{tr('Needs attention', 'Bantayan')}</Badge>;
  return (
    <Link to={`${BASE}/patients/${e.id}`} className="m-person">
      <Avatar name={e.fullName} />
      <span className="m-grow">
        <span className="m-row" style={{ gap: '.5rem', flexWrap: 'wrap' }}><strong>{shortName(e.fullName)}</strong>{badge}</span>
        <span className="m-sub">{e.latest
          ? tr(`Checked in at ${clock(e.latest.recordedAt)}`, `Na-check-in ${clock(e.latest.recordedAt)}`)
          : tr(`Not checked in yet today${e.last ? ` · last ${relTime(e.last.recordedAt)}` : ''}`, 'Wala pang check-in ngayon')}</span>
        <WeekDots checkins={e.checkins} />
      </span>
      <Icon name="chevron" />
    </Link>
  );
}

/** "See all": every assigned elder. */
function Patients({ user }) {
  const tr = useT();
  const [elders] = useElders(user);
  return (
    <>
      <TopBar title={tr('Your Patients', 'Iyong mga pasyente')} back={BASE} />
      {!elders ? <Loader /> : elders.map((e) => {
        const today = e.checkins.filter((c) => isToday(c.recordedAt));
        return <PatientCard key={e.id} e={{ ...e, latest: today[0] || null, last: e.checkins[0] || null }} tr={tr} />;
      })}
    </>
  );
}

const PROFILE_TABS = [['vitals', 'Vitals', 'Vital signs'], ['medicines', 'Medicines', 'Gamot'], ['notes', 'Notes', 'Tala']];

/** Patient profile (Figma "Your Patients"): who, what needs attention, start a check-in, the last 7 days. */
function PatientProfile({ user, patientId }) {
  const tr = useT();
  const [elders] = useElders(user);
  const people = usePeople(patientId);
  const [tab, setTab] = useState('vitals');
  if (!elders) return <><TopBar title={tr('Patient Profile', 'Profile ng pasyente')} back={BASE} /><Loader /></>;
  const e = elders.find((x) => x.id === patientId);
  if (!e) return <><TopBar title={tr('Patient Profile', 'Profile ng pasyente')} back={BASE} /><div className="m-note">{tr('This elder is not assigned to you.', 'Hindi nakatalaga sa iyo ang pasyenteng ito.')}</div></>;
  const latest = e.checkins[0];
  const byName = (id) => (people && people.caregivers.find((c) => c.id === id) || {}).name;
  const doses = todaysDoses(e.meds, e.checkins);
  const attention = [
    ...(latest && isToday(latest.recordedAt) ? latest.anomalies.map((a) => a.message) : []),
    ...(!e.checkins.some((c) => isToday(c.recordedAt)) ? [tr('No check-in yet today', 'Wala pang check-in ngayon')] : []),
    ...doses.filter((d) => d.status === 'missed').map((d) => tr(`${d.med.name} was missed (${hhmm(d.time)})`, `Hindi nainom ang ${d.med.name} (${hhmm(d.time)})`)),
    ...(latest && latest.mobilityStatus === 'fall_reported' && isToday(latest.recordedAt) ? [tr('A fall was reported', 'May naiulat na pagkahulog')] : []),
  ];
  const week = e.checkins.filter((c) => Date.now() - new Date(c.recordedAt).getTime() < 7 * 86400000);
  const from = new Date(Date.now() - 6 * 86400000).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
  const to = new Date().toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' });
  const conditions = (e.conditions || []).map(conditionLabel);
  const notes = e.checkins.filter((c) => c.notes).slice(0, 10);
  return (
    <>
      <TopBar title={tr('Patient Profile', 'Profile ng pasyente')} back={BASE} />
      <section className="m-soft">
        <div className="m-row" style={{ alignItems: 'flex-start' }}>
          <Avatar name={e.fullName} />
          <div className="m-grow">
            <strong style={{ display: 'block', fontSize: '1rem' }}>{e.fullName}</strong>
            <span className="m-caption" style={{ display: 'block' }}>{[age(e.birthDate) && tr(`${age(e.birthDate)} years old`, `${age(e.birthDate)} taong gulang`), conditions[0]].filter(Boolean).join(' · ')}</span>
            {e.addressLine && <span className="m-caption" style={{ display: 'block' }}>{e.addressLine}</span>}
          </div>
        </div>
        <p className="m-caption" style={{ marginTop: '.6rem' }}><strong style={{ color: 'var(--text-primary)' }}>{tr('Latest check-in:', 'Huling check-in:')}</strong>{' '}
          {latest ? `${isToday(latest.recordedAt) ? tr('today', 'ngayon') : relTime(latest.recordedAt)}, ${clock(latest.recordedAt)}${byName(latest.caregiverId) ? tr(` by ${byName(latest.caregiverId)}`, ` ni ${byName(latest.caregiverId)}`) : ''}` : tr('none yet', 'wala pa')}</p>
      </section>

      <h2 className="m-label">{tr('Needs Attention', 'Kailangang bantayan')}</h2>
      <div className="m-attn-box">
        {attention.length
          ? <ul>{attention.map((a, i) => <li key={i} style={{ color: 'var(--text-critical)', fontWeight: 700 }}>{a}</li>)}</ul>
          : <p className="m-muted">{tr('Nothing needs attention right now.', 'Walang kailangang bantayan ngayon.')}</p>}
      </div>

      <div style={{ margin: '1rem 0' }}><Cta onClick={() => navigate(`${BASE}/check-in?patient=${e.id}`)}>{tr('Start daily Check-in', 'Simulan ang check-in')}</Cta></div>

      <div className="m-tabs3" role="group" aria-label={tr('Show', 'Ipakita')}>
        {PROFILE_TABS.map(([k, en, fil]) => <button key={k} type="button" aria-pressed={tab === k} onClick={() => setTab(k)}>{tr(en, fil)}</button>)}
      </div>
      <p className="m-caption" style={{ margin: '.6rem 0 .75rem' }}>{tr(`Last 7 days · ${from} to ${to}`, `Huling 7 araw · ${from} hanggang ${to}`)}</p>
      {tab === 'vitals' && (
        <div className="m-stack">
          {!week.length && <div className="m-note">{tr('No check-ins in the last 7 days.', 'Walang check-in sa huling 7 araw.')}</div>}
          {week.map((c) => (
            <Link key={c.id} to={`${BASE}/checkins/${c.id}`} className="m-card m-card-link" style={{ marginTop: 0, padding: '.875rem 1rem' }}>
              <div className="m-between">
                <strong>{c.vitals.systolic ? `BP ${c.vitals.systolic}/${c.vitals.diastolic}` : c.vitalsMissing && c.vitalsMissing.bp ? tr('BP not taken', 'Walang BP') : tr('No BP', 'Walang BP')}</strong>
                <Chip tone={TONE[c.severity] || 'ok'} icon={['none', 'low'].includes(c.severity) ? 'check' : 'alert'}>{SEVERITY_WORD[c.severity] ? tr(...SEVERITY_WORD[c.severity]) : c.severity}</Chip>
              </div>
              <p className="m-caption">{isToday(c.recordedAt) ? clock(c.recordedAt) : `${relTime(c.recordedAt)}, ${clock(c.recordedAt)}`} · {vitalsSummary(c, tr)}{c.medication.taken === false ? tr(' · medicine missed', ' · hindi nainom ang gamot') : ''}</p>
              <div className="m-row" style={{ gap: '.5rem', marginTop: '.4rem', alignItems: 'center' }}>
                <StatusChip status={c.status} />
                <span className="m-caption" style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{statusLine(c, tr)}</span>
              </div>
            </Link>
          ))}
        </div>
      )}
      {tab === 'medicines' && (
        <div className="m-stack">
          {doses.length ? doses.map((d) => <DoseRow key={d.id} d={d} tr={tr} />) : <div className="m-note">{tr('No medicines prescribed.', 'Walang nakatakdang gamot.')}</div>}
        </div>
      )}
      {tab === 'notes' && (
        <div className="m-stack">
          {!notes.length && <div className="m-note">{tr('No notes yet.', 'Wala pang tala.')}</div>}
          {notes.map((c) => <div key={c.id} className="m-info-box" style={{ marginTop: 0 }}><p className="m-caption">{relTime(c.recordedAt)}, {clock(c.recordedAt)}</p><p>{c.notes}</p></div>)}
        </div>
      )}

      <div className="m-info-box" style={{ marginTop: '1.25rem' }}>
        <h3>{tr('Known Conditions', 'Mga kondisyon')}</h3>
        {conditions.length ? <div className="m-pills" style={{ gap: '.35rem' }}>{conditions.map((c) => <Chip key={c}>{c}</Chip>)}</div> : <p className="m-muted">{tr('None recorded.', 'Walang naitala.')}</p>}
        {e.mobilityRestricted && <p className="m-caption" style={{ marginTop: '.35rem' }}>{tr('Limited mobility', 'Limitado ang galaw')}</p>}
      </div>
      <div className="m-info-box">
        <h3>{tr('Care Team', 'Care team')}</h3>
        {!people ? <p className="m-muted">{tr('Loading…', 'Naglo-load…')}</p> : (
          <ul className="m-steps-list">
            {people.caseNurse && <li><Icon name="heartPulse" /><div><strong>{people.caseNurse.name}</strong><span className="m-sub">{tr('Case nurse', 'Nars')}{people.careTeam ? ` · ${people.careTeam.name}` : ''}</span></div></li>}
            {people.caregivers.map((c) => <li key={c.id}><Icon name="user" /><div><strong>{c.name}{c.id === user.id ? tr(' (you)', ' (ikaw)') : ''}</strong><span className="m-sub">{tr('Caregiver', 'Tagapag-alaga')}</span></div></li>)}
            {people.family.map((f) => <li key={f.id}><Icon name="users" /><div><strong>{f.name}</strong><span className="m-sub">{tr('Family (view only)', 'Pamilya')}</span></div></li>)}
          </ul>
        )}
      </div>
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

/** Profile switch for phone reminders (only where the browser supports notifications). */
function ReminderSwitch() {
  const tr = useT();
  const [on, setOn] = useState(remindersOn());
  const [msg, setMsg] = useState('');
  return (
    <span style={{ display: 'grid', justifyItems: 'end' }}>
      <SwitchPill on={on} label={tr('Notifications & Reminders', 'Abiso at paalala')} onClick={async () => {
        if (on) { disableReminders(); setOn(false); return; }
        const p = await enableReminders();
        setOn(p === 'granted');
        setMsg(p === 'denied' ? tr('Blocked: allow notifications for this site in the browser settings.', 'Naka-block: payagan sa browser settings.') : '');
      }} />
      {msg && <span className="m-caption" role="status" style={{ maxWidth: '12rem', textAlign: 'right' }}>{msg}</span>}
    </span>
  );
}

const SEVERITY_WORD = { none: ['Normal', 'Normal'], low: ['Normal', 'Normal'], moderate: ['Watch', 'Bantayan'], high: ['High', 'Mataas'], critical: ['Very high', 'Napakataas'] };

function Duties({ user }) {
  const tr = useT();
  const [elders] = useElders(user);
  return (
    <>
      <TopBar title={tr("Today's Care Tasks", 'Mga gawain ngayon')} back={BASE} />
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
/* ------------------------------ measurement devices (health safeguard) ------------------------------ */
const BP_DEVICES = [
  ['upper_arm_digital', 'Upper-arm digital monitor', 'Digital na pang-braso'],
  ['wrist_digital', 'Wrist digital monitor', 'Digital na pang-pulso'],
  ['manual_aneroid', 'Manual (stethoscope + cuff)', 'Manwal (stethoscope + cuff)'],
  ['bluetooth_monitor', 'Bluetooth monitor', 'Bluetooth monitor'],
];
const THERMOMETERS = [
  ['digital_oral', 'Digital, under the tongue', 'Digital, sa ilalim ng dila'],
  ['digital_axillary', 'Digital, under the arm', 'Digital, sa kili-kili'],
  ['infrared_forehead', 'Infrared, forehead', 'Infrared, noo'],
  ['infrared_ear', 'Infrared, ear', 'Infrared, tainga'],
];
const DEVICE_DEFAULT = { bp: 'upper_arm_digital', thermometer: 'digital_oral' };
function readDevices(userId) {
  try { return { ...DEVICE_DEFAULT, ...JSON.parse(localStorage.getItem(`eldercare.devices.${userId}`)) }; } catch { return DEVICE_DEFAULT; }
}
function saveDevices(userId, d) {
  try { localStorage.setItem(`eldercare.devices.${userId}`, JSON.stringify(d)); } catch { /* per-device convenience only */ }
}

/** Which devices the readings come from; remembered on this phone. Wrist cuffs read less reliably, so we say so. */
function DevicePicker({ devices, setDevice }) {
  const tr = useT();
  const { lang } = usePrefs();
  const label = (list, v) => { const x = list.find((d) => d[0] === v); return x ? (lang === 'fil' ? x[2] : x[1]) : v; };
  return (
    <div className="m-note" style={{ padding: '.75rem 1rem' }}>
      <strong style={{ fontSize: '.875rem' }}>{tr('Measured with', 'Ginamit sa pagsukat')}</strong>
      <label className="m-device">{tr('Blood pressure:', 'Presyon:')}
        <SelectOther value={devices.bp} onChange={(v) => setDevice('bp', v)} other={devices.bpOther} onOther={(v) => setDevice('bpOther', v)} label={tr('Blood pressure device', 'Gamit sa presyon')}
          aria-label={tr('Blood pressure device', 'Gamit sa presyon')} options={BP_DEVICES.map(([k]) => [k, label(BP_DEVICES, k)])}
          otherLabel={tr('Other (type it)', 'Iba pa (i-type)')} otherPlaceholder={tr('Which device?', 'Anong gamit?')} />
      </label>
      <label className="m-device" style={{ marginTop: '.35rem' }}>{tr('Thermometer:', 'Thermometer:')}
        <SelectOther value={devices.thermometer} onChange={(v) => setDevice('thermometer', v)} other={devices.thermometerOther} onOther={(v) => setDevice('thermometerOther', v)}
          label={tr('Thermometer type', 'Uri ng thermometer')} aria-label={tr('Thermometer type', 'Uri ng thermometer')} options={THERMOMETERS.map(([k]) => [k, label(THERMOMETERS, k)])}
          otherLabel={tr('Other (type it)', 'Iba pa (i-type)')} otherPlaceholder={tr('Which thermometer?', 'Anong thermometer?')} />
      </label>
      {devices.bp === 'wrist_digital' && <p className="m-caption" style={{ marginTop: '.35rem' }}>{tr('Wrist monitors read less accurately: keep the wrist at heart level.', 'Hindi gaanong tumpak ang pang-pulso: itapat ang pulso sa puso.')}</p>}
    </div>
  );
}

/** One check-in with its review timeline (caregiver). */
function CheckinDetail({ id }) {
  const tr = useT();
  const [data, setData] = useState(null);
  useEffect(() => { api(`/api/checkins/${id}`).then(setData).catch((e) => setData({ error: e.message })); }, [id]);
  const c = data && data.checkin;
  return (
    <>
      <TopBar title={tr('Check-in', 'Check-in')} back={BASE} />
      {!data && <Loader />}
      {data && data.error && <p className="m-error">{data.error}</p>}
      {c && (
        <>
          <section className="m-card">
            <div className="m-between"><strong style={{ fontSize: '1.25rem' }}>{isToday(c.recordedAt) ? clock(c.recordedAt) : relTime(c.recordedAt)}</strong><StatusChip status={c.status} /></div>
            <p style={{ marginTop: '.25rem' }}>{vitalsSummary(c, tr)}</p>
            {c.notes && <p className="m-muted" style={{ marginTop: '.35rem' }}>“{c.notes}”</p>}
          </section>
          <section className="m-card">
            <h2 className="m-card-title">{tr('Status', 'Status')}</h2>
            <StatusTimeline checkinId={c.id} />
          </section>
        </>
      )}
    </>
  );
}

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
function VitalField({ k, label, value, onChange, error, hint, placeholder, decimal, missing }) {
  const { lang } = usePrefs();
  const id = `vital-${k}`;
  return (
    <div className="m-stack" style={{ gap: '.4rem' }}>
      <label className={`m-field ${error ? 'is-invalid' : ''}`} htmlFor={id}>
        <span>{label}</span>
        <input id={id} type="number" inputMode={decimal ? 'decimal' : 'numeric'} step={decimal ? '0.1' : '1'} min="1" value={value} onChange={onChange}
          placeholder={placeholder} aria-invalid={error ? 'true' : undefined} aria-describedby={error ? `${id}-err` : undefined} />
        {error ? <span className="m-field-error" id={`${id}-err`} role="alert">{lang === 'fil' ? error.fil : error.en}</span> : hint && <span className="m-hint">{hint}</span>}
      </label>
      {missing && value === '' && <MissingPicker label={label} {...missing} />}
    </div>
  );
}

/** "Not measured / No device / Unknown": why a reading is empty, so the nurse never mistakes it for 0 or normal. */
/** "No reading?" under a vital: why it is empty (never a zero). A small dropdown so it fits half-width fields. */
function MissingPicker({ label, value, onChange, other, onOther }) {
  const tr = useT();
  return (
    <label className={`m-missing-select ${value ? 'is-set' : ''}`}>
      <span>{tr('No reading?', 'Walang sukat?')}</span>
      <SelectOther value={value} onChange={(v) => onChange(v || undefined)} other={other} onOther={onOther} label={label} aria-label={tr(`${label}: why is it empty?`, `${label}: bakit walang sukat?`)}
        placeholder={tr('Choose why', 'Pumili')} options={MISSING_REASONS.map(([k, en, fil]) => [k, tr(en, fil)])}
        otherLabel={tr('Other (type it)', 'Iba pa (i-type)')} otherPlaceholder={tr('Why?', 'Bakit?')} />
    </label>
  );
}

const EMPTY_VITALS = { systolic: '', diastolic: '', heartRate: '', temperatureC: '', spo2: '', bloodGlucose: '' };

function CheckIn({ user }) {
  const tr = useT();
  const { lang } = usePrefs();
  const [elders] = useElders(user);
  const fromUrl = new URLSearchParams(window.location.search).get('patient');
  const saved = useRestoredDraft('checkin');
  // An unsent check-in (kept through a lock or a session that ended) comes back unless another elder was chosen.
  const draft = saved && (!fromUrl || fromUrl === saved.data.patientId) ? saved : null;
  const d = draft ? draft.data : {};
  const [patientId, setPatientId] = useState(() => fromUrl || d.patientId || user.patients[0]);
  const [step, setStep] = useState(d.step || 1);
  const [vitals, setVitals] = useState(d.vitals || EMPTY_VITALS);
  const [missing, setMissingState] = useState(d.missing || {});
  const setMissing = (k) => (reason) => setMissingState((m) => { const next = { ...m }; if (reason) next[k] = reason; else delete next[k]; return next; });
  const missingFor = (k) => ({ value: missing[k], onChange: setMissing(k), other: missing[`${k}Other`], onOther: setMissing(`${k}Other`) });
  const [given, setGiven] = useState(d.given || {});
  const [reasons, setReasons] = useState(d.reasons || {});
  const [symptoms, setSymptoms] = useState(d.symptoms || []);
  const [mobility, setMobility] = useState(d.mobility || null);
  const [mood, setMood] = useState(d.mood || null);
  const [notes, setNotes] = useState(d.notes || '');
  const [vitalsNote, setVitalsNote] = useState(d.vitalsNote || '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState(null);
  const [sent, setSent] = useState(null);
  const entered = Object.values(vitals).some((x) => x !== '') || Object.keys(missing).length > 0 || Object.keys(given).length > 0
    || symptoms.length > 0 || Boolean(mobility || mood || notes.trim() || vitalsNote.trim());
  useKeepDraft('checkin', { patientId, step, vitals, missing, given, reasons, symptoms, mobility, mood, notes, vitalsNote }, entered && !sent);
  function discardDraft() {
    setStep(1); setVitals(EMPTY_VITALS); setMissingState({}); setGiven({}); setReasons({}); setSymptoms([]); setMobility(null); setMood(null); setNotes(''); setVitalsNote('');
  }

  const patient = elders && elders.find((e) => e.id === patientId);
  const [tried, setTried] = useState(false);
  const [bt, setBt] = useState({ busy: false, msg: '' });
  const [devices, setDevicesState] = useState(() => readDevices(user.id));
  const setDevice = (k, v) => setDevicesState((d) => { const next = { ...d, [k]: v }; saveDevices(user.id, next); return next; });
  const errors = vitalErrors(vitals, { pair: tried });
  const hasErrors = Object.keys(errors).length > 0;
  const warning = hasErrors ? null : vitalsWarning(vitals, patient && patient.baseline);
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
      setDevicesState((d) => ({ ...d, bp: 'bluetooth_monitor' })); // this reading only; the saved choice stays
      setBt({ busy: false, msg: tr(`Read ${r.systolic}/${r.diastolic}${r.heartRate ? `, pulse ${r.heartRate}` : ''} from the monitor.`, `Nabasa: ${r.systolic}/${r.diastolic}.`) });
    } catch (e) {
      setBt({ busy: false, msg: e.name === 'NotFoundError' ? tr('No monitor was chosen.', 'Walang napiling monitor.') : e.message });
    }
  }
  const goTo = (n) => { setStep(n); window.scrollTo({ top: 0 }); };
  const set = (k) => (e) => {
    setVitals((v) => ({ ...v, [k]: e.target.value }));
    if (e.target.value !== '') setMissing(k === 'systolic' || k === 'diastolic' ? 'bp' : k)(undefined); // a value replaces the reason
  };

  function buildBody() {
    const num = (x) => (x === '' ? undefined : Number(x));
    const v = Object.fromEntries(Object.entries(vitals).map(([k, x]) => [k, num(x)]).filter(([, x]) => x !== undefined));
    // "<vital>Other" holds the caregiver's own words when the reason is "other"; it goes with its vital.
    const vitalsMissing = Object.fromEntries(Object.entries(missing).filter(([key]) => {
      const k = key.replace(/Other$/, '');
      if (key !== k && missing[k] !== 'other') return false;
      return k === 'bp' ? v.systolic === undefined && v.diastolic === undefined : v[k] === undefined;
    }));
    const answered = meds.filter((m) => given[m.id] !== undefined);
    const missed = meds.filter((m) => given[m.id] === false).map((m) => `${m.name} ${m.dosage}${reasons[m.id] ? ` – ${reasons[m.id]}` : ''}`.slice(0, 100));
    const told = SYMPTOMS.filter((s) => symptoms.includes(s.key) && s.key !== 'fall' && s.key !== 'confused').map((s) => s.en);
    const noteText = [vitalsNote.trim() ? `Vitals: ${vitalsNote.trim()}${/[.!?]$/.test(vitalsNote.trim()) ? '' : '.'}` : '', told.length ? `Reported: ${told.join('; ')}.` : '', notes.trim()].filter(Boolean).join(' ');
    return {
      patientId,
      idempotencyKey: `pwa-${crypto.randomUUID()}`,
      recordedAt: new Date().toISOString(),
      ...(Object.keys(v).length ? { vitals: v } : {}),
      ...(Object.keys(vitalsMissing).length ? { vitalsMissing } : {}),
      ...(answered.length ? { medication: { taken: missed.length === 0, missed } } : {}),
      ...(symptoms.includes('fall') ? { mobilityStatus: 'fall_reported' } : mobility ? { mobilityStatus: mobility } : {}),
      ...(symptoms.includes('confused') ? { mood: 'confused' } : mood ? { mood } : {}),
      ...(noteText ? { notes: noteText.slice(0, 2000) } : {}),
      ...(weather.status === 'ready' ? { environment: toEnvironment(weather.weather) } : {}),
      measurementDevice: {
        ...(v.systolic ? { bp: devices.bp, ...(devices.bp === 'other' ? { bpOther: devices.bpOther || '' } : {}) } : {}),
        ...(v.temperatureC ? { thermometer: devices.thermometer, ...(devices.thermometer === 'other' ? { thermometerOther: devices.thermometerOther || '' } : {}) } : {}),
        ...(v.spo2 ? { oximeter: 'fingertip' } : {}),
      },
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

      <DraftNotice draft={draft} onDiscard={discardDraft} />
      {step === 1 && (
        <div className="m-stack">
          <PatientPicker
            patients={elders.map((x) => ({ id: x.id, name: x.fullName, sub: [age(x.birthDate) && tr(`${age(x.birthDate)} years old`, `${age(x.birthDate)} taong gulang`), (x.conditions || []).map(conditionLabel)[0]].filter(Boolean).join(' · ') }))}
            value={patientId}
            onChange={(id) => { setPatientId(id); setGiven({}); setReasons({}); }}
          />
          <div className="m-between">
            <p style={{ fontWeight: 700, color: 'var(--text-secondary)', fontSize: '.875rem' }}>{tr('Blood pressure', 'Presyon ng dugo')}</p>
            {bluetoothSupported() && <button type="button" className="m-link" onClick={readMonitor} disabled={bt.busy}><Icon name="zap" size={16} /> {bt.busy ? tr('Connecting…', 'Kumokonekta…') : tr('Read from Bluetooth monitor', 'Basahin mula sa Bluetooth monitor')}</button>}
          </div>
          {bt.msg && <p className="m-caption" role="status">{bt.msg}</p>}
          <div className="m-grid-2">
            <VitalField k="systolic" label={tr('Top number', 'Itaas na numero')} value={vitals.systolic} onChange={set('systolic')} error={errors.systolic} hint={tr('Usual: 90–139', 'Karaniwan: 90–139')} placeholder={patient && patient.baseline && patient.baseline.systolic ? String(patient.baseline.systolic) : '120'} />
            <VitalField k="diastolic" label={tr('Bottom number', 'Ibabang numero')} value={vitals.diastolic} onChange={set('diastolic')} error={errors.diastolic} hint={tr('Usual: 60–89', 'Karaniwan: 60–89')} placeholder={patient && patient.baseline && patient.baseline.diastolic ? String(patient.baseline.diastolic) : '80'} />
          </div>
          {vitals.systolic === '' && vitals.diastolic === '' && <MissingPicker label={tr('Blood pressure', 'Presyon ng dugo')} {...missingFor('bp')} />}
          <div className="m-grid-2" style={{ alignItems: 'start' }}>
            <VitalField k="heartRate" label={tr('Heart rate (bpm)', 'Tibok ng puso (bpm)')} value={vitals.heartRate} onChange={set('heartRate')} error={errors.heartRate} hint={tr('Usual at rest: 60–100', 'Karaniwan habang nagpapahinga: 60–100')} placeholder="72" missing={missingFor('heartRate')} />
            <VitalField k="temperatureC" decimal label={tr('Temperature (°C)', 'Temperatura (°C)')} value={vitals.temperatureC} onChange={set('temperatureC')} error={errors.temperatureC} hint={tr('Usual: 36.1–37.5 °C · fever from 38', 'Karaniwan: 36.1–37.5 °C · lagnat mula 38')} placeholder="36.8" missing={missingFor('temperatureC')} />
          </div>
          <VitalField k="spo2" label={tr('Oxygen level SpO₂ (%)', 'Oxygen SpO₂ (%)')} value={vitals.spo2} onChange={set('spo2')} error={errors.spo2} hint={tr('Usual: 95–100% · low below 95', 'Karaniwan: 95–100% · mababa kung mas mababa sa 95')} placeholder="97" missing={missingFor('spo2')} />
          <details className="m-more">
            <summary>{tr('Blood sugar and measuring devices (optional)', 'Blood sugar at gamit sa pagsukat (opsyonal)')}</summary>
            <div className="m-stack" style={{ marginTop: '.75rem' }}>
              <VitalField k="bloodGlucose" label={tr('Blood sugar (mg/dL)', 'Blood sugar (mg/dL)')} value={vitals.bloodGlucose} onChange={set('bloodGlucose')} error={errors.bloodGlucose} hint={tr('Usual before meals: 70–130 mg/dL', 'Karaniwan bago kumain: 70–130 mg/dL')} placeholder="110" missing={missingFor('bloodGlucose')} />
              <DevicePicker devices={devices} setDevice={setDevice} />
            </div>
          </details>
          {hasErrors && <Banner tone="critical" role="alert">{tr('Please fix the fields marked in red to continue.', 'Ayusin muna ang mga pulang field para magpatuloy.')}</Banner>}
          {warning && <Banner tone={warning.tone} role="alert">{lang === 'fil' ? warning.fil : warning.en}</Banner>}
          {/* Figma note: notes here too, so the nurse on duty sees context even when step 3 is skipped. */}
          <label className="m-field"><span>{tr('Notes (Optional)', 'Tala (opsyonal)')}</span>
            <textarea rows="2" maxLength={500} value={vitalsNote} onChange={(e) => setVitalsNote(e.target.value)} placeholder={tr('e.g., Re-checked BP on left arm after resting', 'hal. Inulit ang BP sa kaliwang braso pagkatapos magpahinga')} /></label>
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
          <label className="m-field"><span>{tr('Notes (Optional)', 'Tala (opsyonal)')}</span><textarea rows="3" maxLength={1500} value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={tr('e.g., Felt dizzy after waking up, rested 10 min.', 'hal. Nahilo pagkagising, nagpahinga ng 10 minuto.')} /></label>
          {error && <p className="m-error" role="alert">{error}</p>}
          <div className="m-footer-actions">
            <BackStep step={step} goTo={goTo} />
            <Cta onClick={submit} disabled={busy || hasErrors}>{busy ? tr('Sending…', 'Ipinapadala…') : tr('Send Check-in', 'Ipadala ang check-in')}</Cta></div>
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
  const people = usePeople(c && flagged ? c.patientId : null);
  const nurse = people && people.caseNurse ? people.caseNurse.name.replace(/,.*$/, '') : null;

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
                <div><strong>{nurse ? tr(`Nurse ${nurse.split(' ')[0]} will review it`, `Susuriin ito ni Nurse ${nurse.split(' ')[0]}`) : tr('A nurse will review it', 'Susuriin ito ng nars')}</strong><span className="m-sub">{tr('Keep your phone nearby: the clinic may call you', 'Panatilihing malapit ang phone: baka tumawag ang klinika')}</span></div>
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
      <p style={{ textAlign: 'center', marginTop: '.75rem' }}><Link to={`${BASE}/checkins/${c.id}`} className="m-link">{tr('Track this check-in (received → reviewed)', 'Subaybayan ang check-in')}</Link></p>
      <div className="m-footer-actions">
        <button type="button" className="m-btn is-block m-btn-call" onClick={() => navigate(`${BASE}/contact`)}><span>{tr('Call the clinic', 'Tawagan ang klinika')}</span><Icon name="phone" /></button>
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
  const { lang } = usePrefs();
  const [elders] = useElders(user);
  const [patientId, setPatientId] = useState(() => new URLSearchParams(window.location.search).get('patient') || user.patients[0]);
  const e = elders && (elders.find((x) => x.id === patientId) || elders[0]);
  const doses = e ? todaysDoses(e.meds, e.checkins) : [];
  return (
    <>
      <TopBar title={tr('Medicines', 'Mga gamot')} back={BASE} />
      {!elders && <Loader />}
      {e && (
        <>
          <h2 className="m-label">{tr('Patient', 'Pasyente')}</h2>
          <PatientPicker
            patients={elders.map((x) => ({ id: x.id, name: x.fullName, sub: [age(x.birthDate) && tr(`${age(x.birthDate)} years old`, `${age(x.birthDate)} taong gulang`), (x.conditions || []).map(conditionLabel)[0]].filter(Boolean).join(' · ') }))}
            value={e.id}
            onChange={setPatientId}
          />
          {!doses.length && <div className="m-note" style={{ marginTop: '1rem' }}>{tr('No medicines prescribed.', 'Walang nakatakdang gamot.')}</div>}
          {SLOTS.map((slot) => {
            const list = doses.filter((d) => d.slot === slot.key);
            if (!list.length) return null;
            return (
              <section key={slot.key}>
                <h3 className="m-label" style={{ color: 'var(--text-secondary)', fontSize: '.875rem' }}>{lang === 'fil' ? slot.fil : slot.en}</h3>
                <div className="m-stack">{list.map((d) => <DoseRow key={d.id} d={d} tr={tr} />)}</div>
              </section>
            );
          })}
        </>
      )}
      <p className="m-caption" style={{ marginTop: '1rem' }}>{tr('Record medicines in the daily check-in. Only the clinic can change prescriptions.', 'Itala ang gamot sa check-in. Klinika lang ang puwedeng magbago ng reseta.')}</p>
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

/** Contact the clinic about one of the caregiver's elders. */
function CaregiverContact({ user }) {
  const [elders] = useElders(user);
  if (!elders) return <Loader />;
  return <ContactClinic user={user} patients={elders.map((e) => ({ id: e.id, name: e.fullName }))} back={BASE} />;
}

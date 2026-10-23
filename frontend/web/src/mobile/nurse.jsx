// Nurse phone app (Figma N1-N5): risk queue, patient detail, schedule visit, add patient, daily digest.
// The desktop clinic pages (/clinic) stay available for computers; each view links to the other.
import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { Link, navigate } from '../router';
import { age, initials, relTime, REASON_LABEL, VISIT_TYPE_LABEL } from '../format';
import Icon from './icons';
import { Profile } from './common';
import {
  MobileFrame, BottomNav, Greeting, TopBar, Cta, Chip, Banner, Loader, useT, useMobileToast,
  isToday, clock, manilaDay, hhmm, toneFor, PRIORITY_TONE,
} from './kit';

const BASE = '/m/nurse';
const NAV = (tr) => [
  { to: BASE, icon: 'clipboard', label: tr('Queue', 'Queue') },
  { to: `${BASE}/patients`, icon: 'users', label: tr('Patients', 'Pasyente'), exact: false },
  { to: `${BASE}/visits`, icon: 'calendar', label: tr('Visits', 'Bisita') },
  { to: `${BASE}/digest`, icon: 'zap', label: tr('Digest', 'Digest') },
  { to: `${BASE}/profile`, icon: 'user', label: tr('Me', 'Ako') },
];
const PRIORITY_WORD = { P1: ['Urgent', 'Agaran'], P2: ['Soon', 'Malapit na'], P3: ['Watch', 'Bantayan'], P4: ['Routine', 'Karaniwan'] };
const avatarInitials = (name = '') => initials(name.replace(/^(Lola|Lolo) /, ''));

export default function NurseApp({ user, path }) {
  const tr = useT();
  const sub = path.slice(BASE.length) || '/';
  const parts = sub.split('/').filter(Boolean);
  let screen;
  let nav = true;
  if (sub === '/patients/new') { screen = <AddPatient />; nav = false; }
  else if (parts[0] === 'patients' && parts[2] === 'schedule') { screen = <ScheduleVisit patientId={parts[1]} />; nav = false; }
  else if (parts[0] === 'patients' && parts[1]) screen = <PatientDetail user={user} patientId={parts[1]} />;
  else if (sub === '/patients') screen = <Patients />;
  else if (sub === '/visits') screen = <Visits />;
  else if (sub === '/digest') screen = <Digest />;
  else if (sub === '/profile') screen = <Profile user={user} back={BASE} desktopTo="/clinic" />;
  else screen = <Queue user={user} />;
  return (
    <MobileFrame plain={!nav}>
      {screen}
      {nav && <BottomNav items={NAV(tr)} />}
    </MobileFrame>
  );
}

function useQueue() {
  const [q, setQ] = useState(null);
  const load = useCallback(() => api('/api/clinic/queue?pageSize=200').then(setQ).catch((e) => setQ({ error: e.message })), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);
  return [q, load];
}

/** The reason behind the current priority, in a short line ("BP 186/118 · missed medicine · 8:06 AM"). */
export function reasonLine(item) {
  const r = item.reasons.slice(0, 6);
  const health = r.find((x) => x.type === 'health_anomaly') || r.find((x) => x.type === 'missed_checkin');
  const env = r.find((x) => x.type === 'environmental_risk');
  const main = item.scores.health >= item.scores.environment ? health || env : env || health;
  const at = main ? (isToday(main.at) ? clock(main.at) : relTime(main.at)) : '';
  return [main ? main.detail : REASON_LABEL[(r[0] || {}).type] || '', at].filter(Boolean).join(' · ');
}

/* ------------------------------ N1 risk queue ------------------------------ */
function Queue({ user }) {
  const tr = useT();
  const [q] = useQueue();
  const [filter, setFilter] = useState(null);
  const [mine, setMine] = useState(false);
  const [search, setSearch] = useState('');
  const [staff, setStaff] = useState({});
  useEffect(() => {
    api('/api/directory/users?role=clinic_staff').then((r) => setStaff(Object.fromEntries(r.users.map((u) => [u.id, u.name])))).catch(() => {});
  }, []);
  if (!q) return <><Greeting user={user} alertsTo={`${BASE}/digest`} /><Loader /></>;
  if (q.error) return <div className="m-error">{q.error}</div>;

  const s = q.summary;
  const items = q.items
    .filter((i) => !filter || i.priority === filter)
    .filter((i) => !mine || i.assignedTo === user.id)
    .filter((i) => !search || `${i.patient.name} ${i.patient.zipCode} ${i.patient.id}`.toLowerCase().includes(search.toLowerCase()));
  const weather = q.items.flatMap((i) => i.reasons.filter((r) => r.type === 'environmental_risk' && isToday(r.at)).map((r) => ({ ...r, patient: i.patient.name })));
  const urgent = (s.P1 || 0) + (s.P2 || 0);
  return (
    <>
      <Greeting user={user} alerts={urgent} alertsTo={`${BASE}/digest`} />
      <div className="m-counts" role="group" aria-label={tr('Filter by priority', 'Salain ayon sa priority')}>
        {['P1', 'P2', 'P3'].map((p) => (
          <button key={p} type="button" className={`m-count tone-${PRIORITY_TONE[p]}`} aria-pressed={filter === p} onClick={() => setFilter(filter === p ? null : p)}>
            <small>{p} · {tr(...PRIORITY_WORD[p])}</small><strong>{s[p] || 0}</strong><span>{tr('patients', 'pasyente')}</span>
          </button>
        ))}
      </div>
      {weather.length > 0 && (
        <div style={{ marginTop: '.75rem' }}>
          <Banner tone="info" icon="bell">{weather[0].detail}. {tr(`${new Set(weather.map((w) => w.patient)).size} patient(s) flagged by the weather check.`, `${new Set(weather.map((w) => w.patient)).size} pasyente ang na-flag dahil sa panahon.`)}</Banner>
        </div>
      )}
      <label className="m-search" style={{ marginTop: '.75rem' }}>
        <Icon name="search" />
        <span className="m-sr">{tr('Search', 'Hanapin')}</span>
        <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('Search patient or ZIP code', 'Hanapin ang pasyente o ZIP')} />
      </label>
      <div className="m-between">
        <h2 className="m-section-title">{tr('Needs action now', 'Kailangang aksyunan')}</h2>
        <div className="m-seg" role="group" aria-label={tr('Show', 'Ipakita')} style={{ padding: '.2rem' }}>
          <button type="button" aria-pressed={!mine} onClick={() => setMine(false)} style={{ minHeight: '2.25rem', padding: '0 .75rem' }}>{tr('All', 'Lahat')}</button>
          <button type="button" aria-pressed={mine} onClick={() => setMine(true)} style={{ minHeight: '2.25rem', padding: '0 .75rem' }}>{tr('Mine', 'Akin')}</button>
        </div>
      </div>
      <div className="m-stack">
        {items.map((i) => (
          <Link key={i.id} to={`${BASE}/patients/${i.patient.id}`} className="m-list-row">
            <span className={`m-avatar ${toneFor(i.patient.name)}`} aria-hidden="true">{avatarInitials(i.patient.name)}</span>
            <span className="m-grow">
              <strong>{i.patient.name}</strong>
              <span className="m-sub">{reasonLine(i)}</span>
              <Chip tone={PRIORITY_TONE[i.priority]} icon="alert">{i.priority} · {tr('score', 'score')} {i.scores.total}</Chip>
              {i.status !== 'open' && <Chip tone="info">{i.status === 'scheduled' ? tr('Visit booked', 'May bisita') : tr('In review', 'Sinusuri')}</Chip>}
              {i.assignedTo && <span className="m-sub" style={{ marginTop: '.35rem', marginBottom: 0 }}>{i.assignedTo === user.id ? tr('You are handling this', 'Ikaw ang may hawak') : tr(`${staff[i.assignedTo] || 'Another nurse'} is handling this`, `Hawak ni ${staff[i.assignedTo] || 'ibang nars'}`)}</span>}
            </span>
            <Icon name="chevron" />
          </Link>
        ))}
        {!items.length && <div className="m-note"><strong>{tr('Nothing here', 'Wala rito')}</strong>{mine ? tr('No cases are assigned to you. Open a patient and tap "Assign to me".', 'Walang kasong nakatalaga sa iyo.') : tr('No patients match. Clear the filter or search.', 'Walang tugma.')}</div>}
      </div>
    </>
  );
}

/* ------------------------------ N2 patient detail ------------------------------ */
function breakdown(item, patient) {
  const { health, environment, emr, total } = item.scores;
  const comp = Math.round(0.3 * Math.min(health, environment));
  const emrPts = Math.min(10, emr);
  const rows = [];
  if (health) rows.push(['Health readings', 'Sukat ng kalusugan', health >= environment ? health : comp, 'var(--accent-critical)']);
  if (environment) rows.push(['Weather exposure', 'Panahon', environment > health ? environment : comp, 'var(--accent-moderate)']);
  if (emrPts) rows.push(['Legacy clinic records', 'Lumang rekord', emrPts, 'var(--accent-high)']);
  const vulnerable = total - rows.reduce((a, r) => a + r[2], 0);
  if (vulnerable > 0) rows.push([`Age & conditions${patient && patient.conditions.length ? ` (${patient.conditions.join(', ')})` : ''}`, 'Edad at kondisyon', vulnerable, 'var(--accent-moderate)']);
  return rows.sort((a, b) => b[2] - a[2]);
}

function PatientDetail({ user, patientId }) {
  const tr = useT();
  const [toast, setToast] = useMobileToast();
  const [patient, setPatient] = useState(null);
  const [item, setItem] = useState(undefined);
  const [emr, setEmr] = useState(null);
  const [busy, setBusy] = useState(false);
  const loadItem = useCallback(() => api(`/api/clinic/queue?patientId=${encodeURIComponent(patientId)}`).then((r) => setItem(r.items[0] || null)).catch(() => setItem(null)), [patientId]);
  useEffect(() => {
    api(`/api/patients/${encodeURIComponent(patientId)}`).then(setPatient).catch((e) => setPatient({ error: e.message }));
    api(`/api/clinic/patients/${encodeURIComponent(patientId)}/emr-history`).then((r) => setEmr(r.history)).catch((e) => setEmr({ error: e.message }));
    loadItem();
  }, [patientId, loadItem]);

  async function update(body, done) {
    setBusy(true);
    try {
      await api(`/api/clinic/queue/${item.id}`, { method: 'PATCH', body });
      setToast(done);
      await loadItem();
    } catch (e) { setToast(e.message); } finally { setBusy(false); }
  }

  if (!patient || item === undefined) return <><TopBar title={tr('Patient', 'Pasyente')} back={BASE} /><Loader /></>;
  if (patient.error) return <><TopBar title={tr('Patient', 'Pasyente')} back={BASE} /><div className="m-error">{patient.error}</div></>;
  const phone = patient.emergencyContact && patient.emergencyContact.phone;
  const ringTone = item ? `var(--accent-${PRIORITY_TONE[item.priority] === 'ok' ? 'ok' : PRIORITY_TONE[item.priority]})` : 'var(--accent-ok)';
  const score = item ? item.scores.total : 0;
  const r = 26; const c = 2 * Math.PI * r;
  return (
    <>
      {toast}
      <TopBar title={tr('Patient', 'Pasyente')} back={BASE}
        action={phone ? <a className="m-icon-btn" href={`tel:${phone}`} aria-label={tr(`Call ${patient.emergencyContact.name}`, `Tawagan si ${patient.emergencyContact.name}`)}><Icon name="phone" /></a> : <span />} />
      <section className="m-card">
        <div className="m-row">
          <span className={`m-avatar ${toneFor(patient.fullName)}`} aria-hidden="true">{avatarInitials(patient.fullName)}</span>
          <div className="m-grow"><strong style={{ fontSize: '1.25rem' }}>{patient.fullName}</strong>
            <p className="m-caption">{[age(patient.birthDate) && tr(`${age(patient.birthDate)} yrs`, `${age(patient.birthDate)} taon`), patient.addressLine, patient.zipCode].filter(Boolean).join(' · ')}</p></div>
          {item && (
            <div className="m-score-ring" role="img" aria-label={tr(`Risk score ${score} of 100`, `Risk score ${score} sa 100`)}>
              <svg width="64" height="64"><circle cx="32" cy="32" r={r} fill="none" stroke="var(--bg-critical)" strokeWidth="6" /><circle cx="32" cy="32" r={r} fill="none" stroke={ringTone} strokeWidth="6" strokeLinecap="round" strokeDasharray={c} strokeDashoffset={c * (1 - score / 100)} /></svg>
              <span aria-hidden="true">{score}</span>
            </div>
          )}
        </div>
        <div className="m-pills" style={{ marginTop: '.75rem' }}>
          {item ? <Chip tone={PRIORITY_TONE[item.priority]} icon="alert">{tr(`Priority ${item.priority.slice(1)}`, `Priority ${item.priority.slice(1)}`)}</Chip> : <Chip tone="ok" icon="check">{tr('Not in the queue', 'Wala sa queue')}</Chip>}
          {item && <Chip tone="info" icon="bell">{item.status === 'open' ? tr(`Open since ${isToday(item.createdAt) ? clock(item.createdAt) : manilaDay(item.createdAt)}`, `Bukas mula ${clock(item.createdAt)}`) : item.status.replace('_', ' ')}</Chip>}
          {item && item.assignedTo === user.id && <Chip tone="ok" icon="user">{tr('Assigned to you', 'Nakatalaga sa iyo')}</Chip>}
        </div>
      </section>

      {item && (
        <section className="m-card">
          <h2 className="m-card-title">{tr(`Why priority ${item.priority.slice(1)} (score ${score})`, `Bakit priority ${item.priority.slice(1)} (score ${score})`)}</h2>
          {breakdown(item, patient).map(([en, fil, pts, color]) => (
            <div key={en}>
              <div className="m-between" style={{ fontSize: '.9375rem' }}><span className="m-muted">{tr(en, fil)}</span><strong>+{pts}</strong></div>
              <div className="m-score-bar"><span style={{ width: `${Math.min(100, pts)}%`, background: color }} /></div>
            </div>
          ))}
          <p className="m-caption">{item.priorityRule}</p>
          <ul className="m-steps-list" style={{ marginTop: '.5rem' }}>
            {item.reasons.slice(0, 3).map((x) => <li key={`${x.at}${x.detail}`}><Icon name={x.type === 'environmental_risk' ? 'zap' : 'alert'} size={18} /><div><strong style={{ fontSize: '.9375rem' }}>{x.detail}</strong><span className="m-sub">{REASON_LABEL[x.type]} · {relTime(x.at)}</span></div></li>)}
          </ul>
        </section>
      )}

      <section className="m-card">
        <div className="m-between"><h2 className="m-card-title" style={{ marginBottom: 0 }}>{tr('Legacy clinic records', 'Lumang rekord ng klinika')}</h2><Chip icon="checkCircle">{tr('via SOAP', 'via SOAP')}</Chip></div>
        {!emr && <Loader />}
        {emr && emr.error && <p className="m-muted">{emr.error}</p>}
        {emr && !emr.error && (
          <ul className="m-emr" style={{ marginTop: '.5rem' }}>
            {[...emr.diagnoses.map((d) => ({ date: d.diagnosedOn, text: `${d.description}${d.chronic ? ' (long-term)' : ''}` })),
              ...emr.visits.map((v) => ({ date: v.date, text: `${v.complaint || v.type} · ${v.facility}${v.bloodPressure ? ` · BP ${v.bloodPressure.systolic}/${v.bloodPressure.diastolic}` : ''}` }))]
              .sort((a, b) => b.date.localeCompare(a.date)).slice(0, 5)
              .map((x) => <li key={x.date + x.text}><span>{new Date(`${x.date}T00:00:00Z`).toLocaleDateString('en-PH', { month: 'short', year: 'numeric', timeZone: 'UTC' })}</span><span>{x.text}</span></li>)}
          </ul>
        )}
      </section>

      {item && (
        <div className="m-footer-actions">
          <div className="m-grid-2">
            <button type="button" className="m-btn" disabled={busy || item.assignedTo === user.id} onClick={() => update({ assignedTo: user.id, ...(item.status === 'open' ? { status: 'in_review' } : {}) }, tr('Assigned to you', 'Nakatalaga sa iyo'))}>{item.assignedTo === user.id ? tr('Assigned', 'Nakatalaga') : tr('Assign to me', 'Sa akin')}</button>
            <button type="button" className="m-btn" disabled={busy} onClick={() => update({ status: 'resolved', notes: 'Resolved from the phone app' }, tr('Case resolved', 'Nalutas')).then(() => navigate(BASE))}>{tr('Resolve', 'Lutasin')}</button>
          </div>
          <Cta onClick={() => navigate(`${BASE}/patients/${patientId}/schedule`)}>{item.status === 'scheduled' ? tr('Reschedule visit', 'I-reschedule') : tr('Schedule a visit', 'Mag-iskedyul ng bisita')}</Cta>
        </div>
      )}
    </>
  );
}

/* ------------------------------ N3 schedule visit ------------------------------ */
const TIMES = ['09:00', '10:00', '14:00', '16:00'];
function ScheduleVisit({ patientId }) {
  const tr = useT();
  const [patient, setPatient] = useState(null);
  const [item, setItem] = useState(undefined);
  const [type, setType] = useState('home_visit');
  const [day, setDay] = useState(0);
  const [time, setTime] = useState('14:00');
  const [location, setLocation] = useState('');
  const [phone, setPhone] = useState('');
  const [notes, setNotes] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api(`/api/patients/${encodeURIComponent(patientId)}`).then((p) => {
      setPatient(p);
      setLocation([p.addressLine, p.zipCode].filter(Boolean).join(', '));
      setPhone((p.emergencyContact && p.emergencyContact.phone) || '');
    }).catch((e) => setError(e.message));
    api(`/api/clinic/queue?patientId=${encodeURIComponent(patientId)}`).then((r) => setItem(r.items[0] || null)).catch(() => setItem(null));
  }, [patientId]);

  const dates = [0, 1, 2].map((i) => manilaDay(Date.now() + i * 86400000));
  const dayLabel = (i) => (i === 0 ? tr('Today', 'Ngayon') : i === 1 ? tr('Tomorrow', 'Bukas')
    : new Date(`${dates[i]}T12:00:00+08:00`).toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', timeZone: 'Asia/Manila' }));
  const nowHm = new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Manila', hour: '2-digit', minute: '2-digit' }).format(new Date());

  async function submit() {
    setBusy(true);
    setError(null);
    const destination = type === 'home_visit' ? "Patient's home" : (patient.assignedClinic || 'Rural Health Unit');
    try {
      await api(`/api/clinic/queue/${item.id}/visits`, {
        method: 'POST',
        body: { visitType: type, visitDate: dates[day], visitTime: time, destination, location: location || destination, contactPhone: phone.replace(/\s/g, '') || undefined, notes: notes.trim() || undefined },
      });
      navigate(`${BASE}/visits`);
    } catch (e) { setError((e.details || [e.message]).join('. ')); setBusy(false); }
  }

  if (!patient || item === undefined) return <><TopBar title={tr('Schedule visit', 'Iskedyul ng bisita')} back={`${BASE}/patients/${patientId}`} />{error ? <div className="m-error">{error}</div> : <Loader />}</>;
  return (
    <>
      <TopBar title={tr('Schedule visit', 'Iskedyul ng bisita')} back={`${BASE}/patients/${patientId}`} />
      <div className="m-stack">
        <div className="m-card m-row" style={{ padding: '.875rem 1rem' }}>
          <span className={`m-avatar ${toneFor(patient.fullName)}`} aria-hidden="true" style={{ width: '2.5rem', height: '2.5rem', fontSize: '.875rem' }}>{avatarInitials(patient.fullName)}</span>
          <div><strong>{patient.fullName}</strong>{item && <p style={{ color: 'var(--text-critical)', fontSize: '.875rem' }}>{tr(`Priority ${item.priority.slice(1)} · score ${item.scores.total}`, `Priority ${item.priority.slice(1)} · score ${item.scores.total}`)}</p>}</div>
        </div>
        {!item && <Banner tone="moderate">{tr('This patient has no open case, so a visit cannot be booked from here.', 'Walang bukas na kaso ang pasyenteng ito.')}</Banner>}
        <div className="m-seg" role="group" aria-label={tr('Type of visit', 'Uri ng bisita')}>
          <button type="button" aria-pressed={type === 'home_visit'} onClick={() => setType('home_visit')}>{tr('Home visit', 'Bisita sa bahay')}</button>
          <button type="button" aria-pressed={type === 'clinic_visit'} onClick={() => setType('clinic_visit')}>{tr('Clinic visit', 'Sa klinika')}</button>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="m-field" style={{ padding: 0 }}><span>{tr('Date', 'Petsa')}</span></legend>
          <div className="m-pills" style={{ marginTop: '.4rem' }}>{[0, 1, 2].map((i) => <button key={i} type="button" className="m-pill" aria-pressed={day === i} onClick={() => setDay(i)}>{day === i && <Icon name="check" size={16} />}{dayLabel(i)}</button>)}</div>
        </fieldset>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}><legend className="m-field" style={{ padding: 0 }}><span>{tr('Time', 'Oras')}</span></legend>
          <div className="m-pills" style={{ marginTop: '.4rem' }}>{TIMES.map((t) => <button key={t} type="button" className="m-pill" disabled={day === 0 && t <= nowHm} aria-pressed={time === t} onClick={() => setTime(t)}>{time === t && <Icon name="check" size={16} />}{hhmm(t)}</button>)}</div>
        </fieldset>
        <label className="m-field"><span>{type === 'home_visit' ? tr('Address', 'Address') : tr('Clinic address', 'Address ng klinika')}</span><input value={location} onChange={(e) => setLocation(e.target.value)} /></label>
        <label className="m-field"><span>{tr('Contact phone', 'Numero')}</span><input inputMode="tel" value={phone} onChange={(e) => setPhone(e.target.value)} placeholder="09171234567" /></label>
        <label className="m-field"><span>{tr('Notes', 'Tala')}</span><textarea rows="2" value={notes} onChange={(e) => setNotes(e.target.value)} placeholder={tr('Bring BP monitor; check medicine supply.', 'Dalhin ang BP monitor.')} /></label>
        <p className="m-caption">{tr('The caregiver and family will see the visit in their app.', 'Makikita ng tagapag-alaga at pamilya ang bisita sa app.')}</p>
        {error && <p className="m-error" role="alert">{error}</p>}
        <Cta onClick={submit} disabled={busy || !item || (day === 0 && time <= nowHm)}>{busy ? tr('Saving…', 'Sine-save…') : tr('Schedule visit', 'I-iskedyul')}</Cta>
      </div>
    </>
  );
}

/* ------------------------------ N4 add patient ------------------------------ */
const CONDITIONS = [
  ['hypertension', 'High blood pressure', 'Altapresyon'],
  ['diabetes', 'Diabetes', 'Diabetes'],
  ['cardiovascular', 'Heart disease', 'Sakit sa puso'],
  ['copd', 'Lung disease (COPD)', 'Sakit sa baga'],
];
function AddPatient() {
  const tr = useT();
  const [f, setF] = useState({ fullName: '', birthDate: '', sex: 'F', barangay: '', city: 'Manila', zipCode: '', ecName: '', ecPhone: '' });
  const [conditions, setConditions] = useState([]);
  const [mobility, setMobility] = useState(false);
  const [alone, setAlone] = useState(false);
  const [users, setUsers] = useState({ caregivers: [], family: [] });
  const [caregiverId, setCaregiverId] = useState('');
  const [familyId, setFamilyId] = useState('');
  const [errors, setErrors] = useState(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/api/directory/users?role=caregiver,family_member').then((r) => setUsers({ caregivers: r.users.filter((u) => u.role === 'caregiver'), family: r.users.filter((u) => u.role === 'family_member') })).catch(() => {});
  }, []);
  const set = (k) => (e) => setF((x) => ({ ...x, [k]: e.target.value }));
  const toggle = (c) => setConditions((l) => (l.includes(c) ? l.filter((x) => x !== c) : [...l, c]));

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setErrors(null);
    try {
      const r = await api('/api/patients', {
        method: 'POST',
        body: {
          fullName: f.fullName, birthDate: f.birthDate, sex: f.sex,
          addressLine: [f.barangay && `Brgy. ${f.barangay.replace(/^brgy\.?\s*/i, '')}`, f.city].filter(Boolean).join(', '),
          zipCode: f.zipCode, conditions, mobilityRestricted: mobility,
          emergencyContact: f.ecPhone ? { name: f.ecName || 'Family contact', relation: 'family', phone: f.ecPhone.replace(/\s/g, '') } : undefined,
          notes: alone ? 'Lives alone' : undefined,
        },
      });
      const pid = r.patient.id;
      for (const uid of [caregiverId, familyId].filter(Boolean)) await api(`/api/directory/users/${uid}/patients`, { method: 'PUT', body: { add: [pid] } }).catch(() => {});
      if (f.ecPhone) await api('/api/alerts/subscribers', { method: 'POST', body: { patientId: pid, name: f.ecName || 'Family contact', relation: 'family', phone: f.ecPhone.replace(/\s/g, '') } }).catch(() => {});
      navigate(`${BASE}/patients/${pid}`);
    } catch (err) {
      setErrors(err.status === 409 ? [tr('This patient already exists (same name and birth date).', 'Mayroon nang ganitong pasyente.')] : err.details || [err.message]);
      setBusy(false);
    }
  }

  return (
    <>
      <TopBar title={tr('Add patient', 'Magdagdag ng pasyente')} back={BASE} />
      <form className="m-stack" onSubmit={submit}>
        <label className="m-field"><span>{tr('Full name', 'Buong pangalan')}</span><input required minLength={3} value={f.fullName} onChange={set('fullName')} autoComplete="off" /></label>
        <div className="m-grid-2">
          <label className="m-field"><span>{tr('Birth date', 'Kaarawan')}</span><input required type="date" value={f.birthDate} onChange={set('birthDate')} /></label>
          <label className="m-field"><span>{tr('Sex', 'Kasarian')}</span><select value={f.sex} onChange={set('sex')}><option value="F">{tr('Female', 'Babae')}</option><option value="M">{tr('Male', 'Lalaki')}</option><option value="X">{tr('Other', 'Iba')}</option></select></label>
          <label className="m-field"><span>Barangay</span><input required value={f.barangay} onChange={set('barangay')} placeholder="659" /></label>
          <label className="m-field"><span>{tr('ZIP code', 'ZIP code')}</span><input required inputMode="numeric" value={f.zipCode} onChange={set('zipCode')} placeholder="1012" /></label>
        </div>
        <fieldset style={{ border: 0, padding: 0, margin: 0 }}>
          <legend className="m-field" style={{ padding: 0 }}><span>{tr('Health conditions (affect the risk score)', 'Mga kondisyon (nakaaapekto sa risk score)')}</span></legend>
          <div className="m-pills" style={{ marginTop: '.4rem' }}>
            {CONDITIONS.map(([k, en, fil]) => <button key={k} type="button" className="m-pill" aria-pressed={conditions.includes(k)} onClick={() => toggle(k)}>{conditions.includes(k) && <Icon name="check" size={16} />}{tr(en, fil)}</button>)}
            <button type="button" className="m-pill" aria-pressed={mobility} onClick={() => setMobility(!mobility)}>{mobility && <Icon name="check" size={16} />}{tr('Mobility-restricted', 'Limitado ang galaw')}</button>
            <button type="button" className="m-pill" aria-pressed={alone} onClick={() => setAlone(!alone)}>{alone && <Icon name="check" size={16} />}{tr('Lives alone', 'Mag-isang nakatira')}</button>
          </div>
        </fieldset>
        <label className="m-field"><span>{tr('Caregiver', 'Tagapag-alaga')}</span>
          <select value={caregiverId} onChange={(e) => setCaregiverId(e.target.value)}><option value="">{tr('Not yet', 'Wala pa')}</option>{users.caregivers.map((u) => <option key={u.id} value={u.id}>{u.username} — {u.name}</option>)}</select></label>
        <label className="m-field"><span>{tr('Family account', 'Account ng pamilya')}</span>
          <select value={familyId} onChange={(e) => setFamilyId(e.target.value)}><option value="">{tr('Not yet', 'Wala pa')}</option>{users.family.map((u) => <option key={u.id} value={u.id}>{u.username} — {u.name}</option>)}</select></label>
        <div className="m-grid-2">
          <label className="m-field"><span>{tr('Family contact for SMS', 'Contact para sa SMS')}</span><input value={f.ecName} onChange={set('ecName')} placeholder="Jose Cruz" /></label>
          <label className="m-field"><span>{tr('Mobile number', 'Numero')}</span><input inputMode="tel" value={f.ecPhone} onChange={set('ecPhone')} placeholder="09187654321" /></label>
        </div>
        <Banner tone="info" icon="bell">{tr('Duplicate check: the same name and birth date is blocked.', 'Hindi puwede ang parehong pangalan at kaarawan.')}</Banner>
        {errors && <div className="m-error" role="alert">{errors.map((x) => <p key={x}>{x}</p>)}</div>}
        <Cta type="submit" disabled={busy}>{busy ? tr('Adding…', 'Idinadagdag…') : tr('Add patient', 'Idagdag')}</Cta>
      </form>
    </>
  );
}

/* ------------------------------ patients / visits ------------------------------ */
function Patients() {
  const tr = useT();
  const [list, setList] = useState(null);
  const [q] = useQueue();
  const [search, setSearch] = useState('');
  useEffect(() => { api('/api/patients?pageSize=200').then((r) => setList(r.patients || r.items || [])).catch(() => setList([])); }, []);
  const byPatient = Object.fromEntries(((q && q.items) || []).map((i) => [i.patient.id, i]));
  const shown = (list || []).filter((p) => !search || `${p.fullName} ${p.id} ${p.zipCode}`.toLowerCase().includes(search.toLowerCase()));
  return (
    <>
      <TopBar title={tr('Patients', 'Mga pasyente')} action={<Link to={`${BASE}/patients/new`} className="m-icon-btn" aria-label={tr('Add patient', 'Magdagdag')}><Icon name="plus" /></Link>} />
      <label className="m-search"><Icon name="search" /><span className="m-sr">{tr('Search', 'Hanapin')}</span><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder={tr('Search name, ID or ZIP', 'Hanapin')} /></label>
      <div className="m-stack" style={{ marginTop: '1rem' }}>
        {!list && <Loader />}
        {shown.map((p) => {
          const it = byPatient[p.id];
          return (
            <Link key={p.id} to={`${BASE}/patients/${p.id}`} className="m-list-row">
              <span className={`m-avatar ${toneFor(p.fullName)}`} aria-hidden="true">{avatarInitials(p.fullName)}</span>
              <span className="m-grow"><strong>{p.fullName}</strong><span className="m-sub">{p.id} · {[age(p.birthDate) && `${age(p.birthDate)} yrs`, p.addressLine].filter(Boolean).join(' · ')}</span>
                {it ? <Chip tone={PRIORITY_TONE[it.priority]} icon="alert">{it.priority} · {it.scores.total}</Chip> : <Chip tone="ok" icon="check">{tr('No open case', 'Walang kaso')}</Chip>}</span>
              <Icon name="chevron" />
            </Link>
          );
        })}
      </div>
    </>
  );
}

function Visits() {
  const tr = useT();
  const [visits, setVisits] = useState(null);
  useEffect(() => { api('/api/clinic/visits?view=upcoming&pageSize=50').then((r) => setVisits(r.visits)).catch(() => setVisits([])); }, []);
  return (
    <>
      <TopBar title={tr('Upcoming visits', 'Mga darating na bisita')} />
      {!visits && <Loader />}
      {visits && !visits.length && <div className="m-note"><strong>{tr('No visits booked', 'Walang naka-book')}</strong>{tr('Schedule one from a patient in the queue.', 'Mag-iskedyul mula sa queue.')}</div>}
      <div className="m-stack">
        {(visits || []).map((v) => (
          <Link key={v.id} to={`${BASE}/patients/${v.patient.id}`} className="m-list-row">
            <span className="m-thumb tone-ok" aria-hidden="true"><Icon name="calendar" /></span>
            <span className="m-grow"><strong>{v.patient.name}</strong>
              <span className="m-sub">{VISIT_TYPE_LABEL[v.visitType]} · {v.visitDate === manilaDay() ? tr('today', 'ngayon') : v.visitDate} {hhmm(v.visitTime)}</span>
              <span className="m-sub">{v.location}</span></span>
            <Icon name="chevron" />
          </Link>
        ))}
      </div>
    </>
  );
}

/* ------------------------------ N5 daily digest ------------------------------ */
function Digest() {
  const tr = useT();
  const [q, reload] = useQueue();
  const groups = useMemo(() => (q && q.items ? ['P1', 'P2', 'P3'].map((p) => ({ priority: p, items: q.items.filter((i) => i.priority === p) })) : []), [q]);
  if (!q) return <><TopBar title={tr('Daily digest', 'Daily digest')} back={BASE} /><Loader /></>;
  if (q.error) return <div className="m-error">{q.error}</div>;
  const t = { P1: q.summary.P1 || 0, P2: q.summary.P2 || 0, P3: q.summary.P3 || 0 };
  const total = t.P1 + t.P2 + t.P3;
  return (
    <>
      <TopBar title={tr('Daily digest', 'Daily digest')} back={BASE} action={<button type="button" className="m-icon-btn" onClick={reload} aria-label={tr('Refresh', 'I-refresh')}><Icon name="refresh" /></button>} />
      <section className="m-hero">
        <div className="m-between"><span className="m-eyebrow">{manilaDay()} · {clock(q.generatedAt)}</span><Chip className="on-light" icon="checkCircle">{tr('From the queue', 'Mula sa queue')}</Chip></div>
        <h2 style={{ marginTop: '.5rem' }}>{tr(`${total} patient${total === 1 ? ' needs' : 's need'} follow-up`, `${total} pasyente ang kailangang i-follow-up`)}</h2>
        <div className="m-pills" style={{ margin: '.5rem 0' }}>
          <Chip tone="critical" icon="alert">{t.P1} {tr('urgent', 'agaran')}</Chip>
          <Chip tone="high" icon="alert">{t.P2} {tr('soon', 'malapit na')}</Chip>
          <Chip tone="moderate" icon="alert">{t.P3} {tr('watch', 'bantayan')}</Chip>
        </div>
        <p className="m-caption" style={{ color: 'var(--text-secondary)' }}>{tr('Built from the clinic risk queue. Start with the urgent patients.', 'Mula sa clinic risk queue. Unahin ang mga agaran.')}</p>
      </section>
      {groups.filter((g) => g.items.length).map((g) => (
        <section key={g.priority}>
          <div className="m-between"><h2 className="m-section-title">{tr(`${PRIORITY_WORD[g.priority][0]} (${g.priority})`, `${PRIORITY_WORD[g.priority][1]} (${g.priority})`)}</h2><strong style={{ color: 'var(--text-brand)' }}>{g.items.length}</strong></div>
          <div className="m-stack">
            {g.items.map((i) => (
              <Link key={i.id} to={`${BASE}/patients/${i.patient.id}`} className="m-list-row">
                <span className={`m-avatar ${toneFor(i.patient.name)}`} aria-hidden="true">{avatarInitials(i.patient.name)}</span>
                <span className="m-grow"><strong>{i.patient.name}</strong><span className="m-sub">{reasonLine(i)}</span><Chip tone={PRIORITY_TONE[g.priority]} icon="alert">{tr('Score', 'Score')} {i.scores.total}</Chip></span>
                <Icon name="chevron" />
              </Link>
            ))}
          </div>
        </section>
      ))}
      {!total && <div className="m-note">{tr('No patients need follow-up right now.', 'Walang kailangang i-follow-up ngayon.')}</div>}
    </>
  );
}

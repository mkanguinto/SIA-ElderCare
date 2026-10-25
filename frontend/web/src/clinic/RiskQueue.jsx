// Nurse desktop risk queue (Figma page "All", "Nurse · Risk queue"): greeting, search, weather check and alerts in
// the header; P1-P3 and check-ins-to-review counts; the queue with All / My cases / Handover; and a side column
// with the duty switch, upcoming visits and open family messages. Same data as the phone queue.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { Link } from '../router';
import { dateTime, initials, relTime } from '../format';
import Icon from '../mobile/icons';
import { Chip, useT, useGreeting, toneFor, isToday, PRIORITY_TONE } from '../mobile/kit';
import { useQueue, useReviewQueue, reasonLine, avatarInitials, PRIORITY_WORD } from '../mobile/nurse';
import { DutyToggle, PendingHandovers, MyCases, usePendingHandovers, useMyCases } from '../mobile/handover';
import { VisitCard } from '../components/visits';
import { weatherSentence } from '../pages/ClinicQueue';

const KPI_ICON = { P1: 'alert', P2: 'clock', P3: 'eye' };

function WeatherCheck({ onResult }) {
  const [checking, setChecking] = useState(false);
  async function run() {
    setChecking(true);
    try {
      onResult({ ok: true, ...(await api('/api/alerts/weather-check', { method: 'POST', body: {} })) });
    } catch (e) {
      onResult({ ok: false, message: e.status === 503 ? 'Weather checks are not set up yet. Add an OpenWeatherMap API key to the alert service.' : e.message });
    } finally { setChecking(false); }
  }
  return <button type="button" className="ad-pill-btn" onClick={run} disabled={checking}><Icon name="thermometer" size={22} />{checking ? 'Checking weather…' : 'Check weather risk now'}</button>;
}

function WeatherResult({ weather, onDismiss }) {
  const s = weather.ok && weather.summary;
  const tone = !weather.ok || s.areasFailed === s.areasChecked ? 'critical' : s.heatAreas.length || s.stormAreas.length ? 'moderate' : 'info';
  return (
    <p className={`m-banner tone-${tone}`} role="status">
      <Icon name="thermometer" />
      <span className="m-grow"><strong>Weather check{weather.ok ? ` at ${dateTime(weather.ranAt)}` : ' failed'}.</strong> {weather.ok ? weatherSentence(s) : weather.message}</span>
      <button type="button" className="m-link" onClick={onDismiss}>Dismiss</button>
    </p>
  );
}

function UpcomingVisits() {
  const [visits, setVisits] = useState(null);
  const load = () => api('/api/clinic/visits?view=upcoming&pageSize=3').then((r) => setVisits(r.visits)).catch(() => setVisits([]));
  useEffect(() => { load(); }, []);
  return (
    <section className="ad-panel ad-side-card">
      <div className="m-between"><h2>Visits</h2><Link to="/clinic/visits" className="m-link">Upcoming</Link></div>
      {visits && !visits.length && <p className="m-caption">No visits booked. Schedule one from a patient's case.</p>}
      {(visits || []).slice(0, 2).map((v) => <VisitCard key={v.id} visit={v} canAct showPatient onChanged={load} />)}
    </section>
  );
}

function FamilyMessages() {
  const [d, setD] = useState(null);
  useEffect(() => { api('/api/clinic/contact-requests').then(setD).catch(() => setD({ requests: [], open: 0 })); }, []);
  const open = d ? (d.requests || []).filter((r) => ['sent', 'seen'].includes(r.status)) : [];
  return (
    <section className="ad-panel ad-side-card">
      <div className="m-between"><h2>Messages from families</h2><Chip icon="checkCircle">Open ({d ? d.open ?? open.length : '…'})</Chip></div>
      {d && !open.length && <p className="m-muted">No open messages.</p>}
      <ul className="ad-msg-list">
        {open.slice(0, 3).map((r) => (
          <li key={r.id}><Link to="/clinic/messages"><strong>{r.reasonLabel}</strong><span className="m-sub">{r.from.name} · {r.patient.name} · {relTime(r.createdAt)}</span></Link></li>
        ))}
      </ul>
      {open.length > 0 && <Link to="/clinic/messages" className="m-link">Open the inbox</Link>}
    </section>
  );
}

export default function RiskQueue({ user }) {
  const tr = useT();
  const greet = useGreeting();
  const [q] = useQueue();
  const [reviews] = useReviewQueue();
  const [filter, setFilter] = useState(null);
  const [tab, setTabState] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'all');
  const setTab = (t) => { setTabState(t); window.history.replaceState(null, '', t === 'all' ? '/clinic' : `/clinic?tab=${t}`); };
  const [handovers, reloadHandovers] = usePendingHandovers();
  const [myCases, reloadMyCases] = useMyCases();
  const [search, setSearch] = useState('');
  const [weather, setWeather] = useState(null);
  const [staff, setStaff] = useState({});
  useEffect(() => {
    api('/api/directory/users?role=clinic_staff').then((r) => setStaff(Object.fromEntries(r.users.map((u) => [u.id, u.name])))).catch(() => {});
  }, []);

  const s = q && q.summary ? q.summary : {};
  const items = q && q.items ? q.items
    .filter((i) => !filter || i.priority === filter)
    .filter((i) => !search || `${i.patient.name} ${i.patient.zipCode} ${i.patient.id}`.toLowerCase().includes(search.toLowerCase())) : [];
  const flagged = q && q.items ? q.items.flatMap((i) => i.reasons.filter((r) => r.type === 'environmental_risk' && isToday(r.at)).map((r) => ({ ...r, patient: i.patient.name }))) : [];
  const toReview = reviews && reviews.pagination ? reviews.pagination.totalItems : null;
  const urgent = (s.P1 || 0) + (s.P2 || 0);

  return (
    <>
      <header className="ad-queue-head">
        <span className={`m-avatar ${toneFor(user.name)}`} aria-hidden="true">{initials(user.name)}</span>
        <div className="m-grow"><small>{greet}</small><strong>{user.name}</strong></div>
        <label className="m-search ad-search"><Icon name="search" /><span className="m-sr">Search</span>
          <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search patient or ZIP code" /></label>
        <WeatherCheck onResult={setWeather} />
        <Link to="/clinic/digest" className="ad-round-btn" aria-label={urgent ? `Alerts, ${urgent} urgent` : 'Alerts'}><Icon name="bell" size={22} />{urgent > 0 && <span className="m-dot" />}</Link>
      </header>
      {weather && <WeatherResult weather={weather} onDismiss={() => setWeather(null)} />}

      <div className="ad-counts" role="group" aria-label="Filter by priority">
        {['P1', 'P2', 'P3'].map((p) => (
          <button key={p} type="button" className={`ad-count tone-${PRIORITY_TONE[p]}`} aria-pressed={filter === p} onClick={() => setFilter(filter === p ? null : p)}>
            <span className="ad-count-label"><span className="ad-count-icon"><Icon name={KPI_ICON[p]} size={20} /></span>{p} · {PRIORITY_WORD[p][0]}</span>
            <strong>{s[p] || 0}</strong><span>patients</span>
          </button>
        ))}
        <Link to="/clinic/reviews" className="ad-count tone-ok">
          <span className="ad-count-label"><span className="ad-count-icon"><Icon name="clipboard" size={20} /></span>check-ins to review</span>
          <strong>{toReview ?? '…'}</strong><span>{reviews && reviews.counts && reviews.counts.historical ? `Including ${reviews.counts.historical} older one(s) still pending` : 'Mark them reviewed and record what you did'}</span>
        </Link>
      </div>

      <div className="ad-queue">
        <section className="ad-panel">
          <div className="m-between ad-queue-title">
            <h2>{tab === 'mine' ? 'Cases you hold' : tab === 'handover' ? 'Handovers' : 'Needs action now'}</h2>
            <div className="m-seg" role="tablist" aria-label="Show">
              <button type="button" role="tab" aria-selected={tab === 'all'} aria-pressed={tab === 'all'} onClick={() => setTab('all')}>All</button>
              <button type="button" role="tab" aria-selected={tab === 'mine'} aria-pressed={tab === 'mine'} onClick={() => setTab('mine')}>My cases{myCases && myCases.cases ? ` (${myCases.cases.length})` : ''}</button>
              <button type="button" role="tab" aria-selected={tab === 'handover'} aria-pressed={tab === 'handover'} onClick={() => setTab('handover')}>
                Handover{handovers && handovers.incoming && handovers.incoming.length ? <span className="m-badge">{handovers.incoming.length}</span> : ''}
              </button>
            </div>
          </div>
          {flagged.length > 0 && tab === 'all' && <p className="m-banner tone-info"><Icon name="bell" />{flagged[0].detail}. {new Set(flagged.map((w) => w.patient)).size} patient(s) flagged by the weather check.</p>}
          {!q && <p className="m-caption">Loading…</p>}
          {q && q.error && <p className="m-error">{q.error}</p>}
          {tab === 'mine' && <MyCases data={myCases} reasonLine={reasonLine} />}
          {tab === 'handover' && <PendingHandovers data={handovers} reload={() => { reloadHandovers(); reloadMyCases(); }} />}
          {tab === 'all' && q && !q.error && (
            <div className="ad-rows">
              {items.map((i) => (
                <Link key={i.id} to={`/clinic/patients/${i.patient.id}`} className="m-list-row">
                  <span className={`m-avatar ${toneFor(i.patient.name)}`} aria-hidden="true">{avatarInitials(i.patient.name)}</span>
                  <span className="m-grow">
                    <strong>{i.patient.name}</strong>
                    <span className="m-sub">{reasonLine(i)}</span>
                    <span className="m-pills">
                      <Chip tone={PRIORITY_TONE[i.priority]} icon={PRIORITY_TONE[i.priority] === 'ok' ? 'check' : 'alert'}>{i.priority} · score {i.scores.total}</Chip>
                      {i.status !== 'open' && <Chip tone="info" icon="bell">{i.status === 'scheduled' ? 'Visit booked' : 'In review'}</Chip>}
                    </span>
                    {i.assignedTo && <span className="m-sub ad-holder">{i.assignedTo === user.id ? 'You are handling this' : `${staff[i.assignedTo] || 'Another nurse'} is handling this`}</span>}
                  </span>
                  <Icon name="chevron" />
                </Link>
              ))}
              {!items.length && <div className="m-note"><strong>{tr('Nothing here', 'Wala rito')}</strong>No patients match. Clear the filter or search.</div>}
            </div>
          )}
        </section>
        <aside className="ad-queue-side" aria-label="Today">
          <section className="ad-panel ad-side-card ad-duty"><DutyToggle user={user} /></section>
          <UpcomingVisits />
          <FamilyMessages />
        </aside>
      </div>
    </>
  );
}

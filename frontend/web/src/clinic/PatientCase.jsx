// Nurse desktop patient case (Figma page "All", "Nurse · Patient case v2"): a header card with the case status
// and Resolve, then three tabs - Overview & Clinical Data (why this priority, check-ins to review, blood pressure,
// visits, recent check-ins), Care Plan & Medications, and Care Team & System Settings (care team and case holder,
// legacy records, app accounts and SMS contacts). The phone app keeps its one-column patient screen.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Link, navigate } from '../router';
import { age, bp, relTime, REASON_LABEL, SEVERITY_LABEL } from '../format';
import Icon from '../mobile/icons';
import { Chip, useMobileToast, toneFor, isToday, clock, manilaDay, PRIORITY_TONE } from '../mobile/kit';
import { breakdown, avatarInitials, useReviewQueue, ReviewCard } from '../mobile/nurse';
import { CareTeamCard } from '../mobile/handover';
import { weekDays } from '../mobile/plan';
import TrendChart from '../components/TrendChart';
import { VisitCard } from '../components/visits';
import { CareToday } from '../components/care';
import CarePlanManager from './CarePlanManager';
import { Medications, CareTeam } from '../pages/PatientProfile';
import { EmrPanel } from '../pages/ClinicQueue';

const TABS = [['overview', 'Overview & Clinical Data'], ['plan', 'Care Plan & Medications'], ['team', 'Care Team & System Settings']];
// The case page shows what is coming and the last two that happened; the Visits page has the rest.
const shownVisits = (visits) => [...visits.filter((v) => v.status === 'scheduled'), ...visits.filter((v) => v.status !== 'scheduled').slice(0, 2)];
const SEVERITY_TONE = { none: 'ok', low: 'info', moderate: 'moderate', high: 'high', critical: 'critical' };

function useCase(patientId) {
  const [d, setD] = useState({});
  const load = useCallback(() => Promise.all([
    api(`/api/patients/${encodeURIComponent(patientId)}`),
    api(`/api/clinic/queue?patientId=${encodeURIComponent(patientId)}`).then((r) => r.items[0] || null).catch(() => null),
    api(`/api/clinic/patients/${encodeURIComponent(patientId)}/care`).catch((e) => (e.status === 404 ? null : { error: e.message })),
    api(`/api/patients/${encodeURIComponent(patientId)}/history?days=30&limit=200`).then((h) => h.checkins).catch(() => []),
    api(`/api/clinic/visits?patientId=${encodeURIComponent(patientId)}&view=all&limit=20`).then((r) => r.visits).catch(() => []),
    api(`/api/clinic/queue/history?patientId=${encodeURIComponent(patientId)}&limit=20`).then((r) => r.cases).catch(() => []),
  ]).then(([patient, item, care, checkins, visits, cases]) => setD({ patient, item, care, checkins, visits, cases }))
    .catch((e) => setD({ error: e.status === 404 ? `Patient ${patientId} was not found.` : e.message })), [patientId]);
  useEffect(() => { load(); }, [load]);
  return [d, load];
}

export default function PatientCase({ user, patientId }) {
  const [toast, setToast] = useMobileToast();
  const [d, reload] = useCase(patientId);
  const [busy, setBusy] = useState(false);
  const [tab, setTabState] = useState(() => new URLSearchParams(window.location.search).get('tab') || 'overview');
  const setTab = (t) => { setTabState(t); window.history.replaceState(null, '', t === 'overview' ? window.location.pathname : `${window.location.pathname}?tab=${t}`); };
  const { patient, item, care, checkins, visits, cases } = d;

  async function update(body, done) {
    setBusy(true);
    try {
      await api(`/api/clinic/queue/${item.id}`, { method: 'PATCH', body });
      setToast(done);
      await reload();
    } catch (e) { setToast(e.message); } finally { setBusy(false); }
  }

  if (d.error) return <p className="m-error">{d.error}</p>;
  if (!patient) return <p className="m-caption">Loading…</p>;
  const holder = care && !care.error && care.caseNurse ? care.caseNurse : null;
  const heldByOther = Boolean(holder && holder.id !== user.id);

  return (
    <>
      {toast}
      <header className="ad-case-head">
        <Link to="/clinic" className="ad-round-btn" aria-label="Back to the risk queue"><Icon name="back" size={22} /></Link>
        <span className={`m-avatar ${toneFor(patient.fullName)}`} aria-hidden="true">{avatarInitials(patient.fullName)}</span>
        <div className="m-grow">
          <h1>{patient.fullName}</h1>
          <p>{[age(patient.birthDate) && `${age(patient.birthDate)} yrs`, patient.addressLine, patient.zipCode].filter(Boolean).join(' · ')}</p>
        </div>
        <div className="m-pills">
          {item ? <Chip tone={PRIORITY_TONE[item.priority]} icon={PRIORITY_TONE[item.priority] === 'ok' ? 'check' : 'alert'}>Priority {item.priority.slice(1)}</Chip> : <Chip tone="ok" icon="check">Not in the queue</Chip>}
          {item && <Chip tone="info" icon="bell">{item.status === 'open' ? `Open since ${isToday(item.createdAt) ? clock(item.createdAt) : manilaDay(item.createdAt)}` : item.status === 'scheduled' ? 'Visit booked' : 'In review'}</Chip>}
          {item && item.assignedTo === user.id && <Chip tone="ok" icon="user">Assigned to you</Chip>}
        </div>
        {item && <button type="button" className="m-btn ad-btn-auto" disabled={busy} onClick={() => window.confirm(`Resolve the case for ${patient.fullName}?`) && update({ status: 'resolved', notes: 'Resolved from the clinic console' }, 'Case resolved').then(() => navigate('/clinic'))}>Resolve</button>}
      </header>

      <div className="ad-tabs" role="tablist" aria-label="Patient case">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>

      {tab === 'overview' && (
        <div className="ad-case-grid">
          <WhyPriority item={item} patient={patient} />
          <CaseReviews patientId={patientId} />
          <Concerns patientId={patientId} />
          <CareReports patientId={patientId} />
          <section className="ad-panel">
            <h2>Blood pressure, last 30 days</h2>
            <p className="m-caption">Clinic records</p>
            <TrendChart points={[...checkins].reverse().map((c) => ({ t: c.recordedAt, sys: c.vitals.systolic, dia: c.vitals.diastolic, flag: ['high', 'critical'].includes(c.severity) }))}
              unit="mmHg" band={[90, 140]} label="Blood pressure trend"
              series={[{ key: 'sys', label: 'Top number', className: 's-primary' }, { key: 'dia', label: 'Bottom number', className: 's-secondary' }]} />
          </section>
          <section className="ad-panel ad-visits-card">
            <h2>Visits</h2>
            {!visits.length && <div className="ad-empty"><span className="ad-kpi-icon"><Icon name="calendar" size={20} /></span><strong>No visits yet</strong><span>Schedule one when the case needs a home or clinic visit.</span></div>}
            {shownVisits(visits).map((v) => <VisitCard key={v.id} visit={v} canAct onChanged={reload} />)}
            {visits.length > shownVisits(visits).length && <Link to="/clinic/visits" className="m-link">All visits ({visits.length})</Link>}
            {item && <button type="button" className="m-btn" onClick={() => navigate(`/clinic/patients/${patientId}/schedule`)}>{item.status === 'scheduled' ? 'Reschedule visit' : 'Schedule a visit'}</button>}
          </section>
          <RecentCheckins checkins={checkins} cases={cases} />
        </div>
      )}

      {tab === 'plan' && (
        <div className="ad-case-grid is-plan">
          <div className="ad-span"><Medications patientId={patient.id} canEdit /></div>
          <CarePlanManager patientId={patient.id} care={care} />
          <section className="ad-panel ad-span"><h2>Today's tasks</h2><CareToday patientId={patient.id} compact /></section>
        </div>
      )}

      {tab === 'team' && (
        <div className="ad-case-grid is-team">
          <div className="ad-stack">
            <CareTeamCard user={user} patientId={patientId} care={care}>
              {item && (heldByOther
                ? <button type="button" className="m-btn" disabled>Held by {holder.name.split(',')[0]}</button>
                : <button type="button" className="m-btn" disabled={busy || item.assignedTo === user.id} onClick={() => update({ assignedTo: user.id, ...(item.status === 'open' ? { status: 'in_review' } : {}) }, 'Assigned to you')}>{item.assignedTo === user.id ? 'Assigned to you' : 'Assign to me'}</button>)}
            </CareTeamCard>
            <LegacyRecords patientId={patientId} />
          </div>
          <CareTeam patientId={patient.id} canEdit />
        </div>
      )}
    </>
  );
}

function WhyPriority({ item, patient }) {
  if (!item) {
    return (
      <section className="ad-panel">
        <h2>No open case</h2>
        <p className="m-muted">This patient is not in the risk queue. A new case opens when a check-in, a missed check-in or the weather check flags them.</p>
      </section>
    );
  }
  return (
    <section className="ad-panel">
      <h2>Why priority {item.priority.slice(1)} (score {item.scores.total})</h2>
      {breakdown(item, patient).map(([en, , pts, color]) => (
        <div key={en} className="ad-score-row">
          <div className="m-between"><span>{en}</span><strong>+{pts}</strong></div>
          <div className="m-score-bar"><span style={{ width: `${Math.min(100, pts)}%`, background: color }} /></div>
        </div>
      ))}
      <p className="m-caption">{item.priorityRule}</p>
      {item.reasons.slice(0, 3).map((x) => (
        <div key={`${x.at}${x.detail}`} className={`ad-reason tone-${x.type === 'environmental_risk' ? 'info' : 'moderate'}`}>
          <Icon name={x.type === 'environmental_risk' ? 'zap' : 'alert'} size={20} />
          <div><strong>{x.detail}</strong><span>{REASON_LABEL[x.type]} · {relTime(x.at)}</span></div>
        </div>
      ))}
    </section>
  );
}

function CaseReviews({ patientId }) {
  const [data, reload] = useReviewQueue(patientId);
  const list = data && data.checkins ? data.checkins : [];
  return (
    <section className="ad-panel">
      <h2>Check-ins to review</h2>
      {!data && <p className="m-caption">Loading…</p>}
      {data && !list.length && <p className="m-muted">All check-ins for this patient are reviewed.</p>}
      <div className="ad-stack">{list.slice(0, 3).map((c) => <ReviewCard key={c.id} c={c} onDone={reload} />)}</div>
      {list.length > 3 && <Link to="/clinic/reviews" className="m-link">{list.length - 3} more in Check-in reviews</Link>}
    </section>
  );
}

const CONCERN_TONE = { open: 'critical', acknowledged: 'moderate', resolved: 'ok' };

/** Concerns raised by the caregiver: open until a nurse resolves them with an assessment and the action taken. */
function Concerns({ patientId }) {
  const [d, setD] = useState(null);
  const [act, setAct] = useState(null); // {id, op}
  const [f, setF] = useState({ note: '', assessment: '', actionTaken: '' });
  const [error, setError] = useState('');
  const load = useCallback(() => api(`/api/patients/${encodeURIComponent(patientId)}/concerns`).then(setD).catch((e) => setD({ error: e.message })), [patientId]);
  useEffect(() => { load(); }, [load]);
  async function submit(e) {
    e.preventDefault();
    setError('');
    try {
      await api(`/api/clinic/concerns/${act.id}/${act.op}`, { method: 'POST', body: act.op === 'resolve' ? { assessment: f.assessment, actionTaken: f.actionTaken } : { note: f.note } });
      setAct(null); setF({ note: '', assessment: '', actionTaken: '' }); load();
    } catch (err) { setError((err.details || [err.message]).join('. ')); }
  }
  const list = d && d.concerns ? d.concerns : [];
  const open = list.filter((x) => x.status !== 'resolved');
  return (
    <section className="ad-panel">
      <div className="m-between"><h2>Concerns</h2><Chip tone={open.length ? 'critical' : 'ok'} icon={open.length ? 'alert' : 'check'}>{open.length} open</Chip></div>
      <p className="m-caption">A concern stays open until a nurse resolves it. Reviewing a report, a normal reading or a finished task does not close it.</p>
      {d && d.error && <p className="m-error">{d.error}</p>}
      {d && !list.length && <p className="m-muted">No concerns reported.</p>}
      <ul className="ad-concerns">
        {list.slice(0, 6).map((x) => (
          <li key={x.id} className={`tone-${CONCERN_TONE[x.status]}`}>
            <div className="m-between"><strong>{x.categoryLabel}</strong><Chip tone={CONCERN_TONE[x.status]}>{x.status}</Chip></div>
            <p>{x.description}</p>
            <span className="m-sub">{x.id} · {x.reportedBy.name || x.reportedBy.id} ({x.reportedBy.role.replace('_', ' ')}) · {relTime(x.createdAt)}</span>
            {x.resolved && <span className="m-sub">Resolved by {x.resolved.byName || x.resolved.by}: {x.resolved.assessment} → {x.resolved.actionTaken}</span>}
            {x.status !== 'resolved' && (!act || act.id !== x.id) && (
              <div className="ad-actions">
                {x.status === 'open' && <button type="button" className="m-link" onClick={() => setAct({ id: x.id, op: 'acknowledge' })}>Acknowledge</button>}
                <button type="button" className="m-link" onClick={() => setAct({ id: x.id, op: 'note' })}>Add a note</button>
                <button type="button" className="m-link" onClick={() => setAct({ id: x.id, op: 'resolve' })}>Resolve</button>
              </div>
            )}
            {act && act.id === x.id && (
              <form className="ad-concern-form" onSubmit={submit}>
                {act.op === 'resolve' ? (
                  <>
                    <label className="ad-field"><span>Your assessment</span><textarea rows="2" value={f.assessment} onChange={(e) => setF({ ...f, assessment: e.target.value })} /></label>
                    <label className="ad-field"><span>Action taken</span><textarea rows="2" value={f.actionTaken} onChange={(e) => setF({ ...f, actionTaken: e.target.value })} /></label>
                  </>
                ) : <label className="ad-field"><span>{act.op === 'acknowledge' ? 'Note (optional)' : 'Note'}</span><textarea rows="2" value={f.note} onChange={(e) => setF({ ...f, note: e.target.value })} /></label>}
                {error && <p className="m-error">{error}</p>}
                <div className="ad-actions"><button className="m-btn is-brand ad-btn-auto">{act.op === 'resolve' ? 'Resolve' : act.op === 'acknowledge' ? 'Acknowledge' : 'Save note'}</button><button type="button" className="m-link" onClick={() => setAct(null)}>Cancel</button></div>
              </form>
            )}
          </li>
        ))}
      </ul>
    </section>
  );
}

const FLAG = { not_done: 'Not done', not_applicable: 'Not applicable', not_taken: 'Not taken', unknown: 'Unknown', not_measured: 'Not measured', no_device: 'No device',
  plan_version_differs: 'Different plan version', prescription_changed: 'Prescription changed', comment: 'Comment' };

/** Caregiver reports that need a nurse's look (missing readings, doses not taken, version differences). */
function CareReports({ patientId }) {
  const [d, setD] = useState(null);
  const [open, setOpen] = useState(null);
  const [note, setNote] = useState('');
  const [error, setError] = useState('');
  const load = useCallback(() => api(`/api/patients/${encodeURIComponent(patientId)}/care-reports`).then(setD).catch((e) => setD({ error: e.message })), [patientId]);
  useEffect(() => { load(); }, [load]);
  async function review(e, it) {
    e.preventDefault();
    setError('');
    try { await api(`/api/care-reports/${it.type}/${it.id}/review`, { method: 'POST', body: { note } }); setOpen(null); setNote(''); load(); } catch (err) { setError((err.details || [err.message]).join('. ')); }
  }
  const items = d && d.items ? d.items : [];
  return (
    <section className="ad-panel">
      <div className="m-between"><h2>Caregiver reports to review</h2><Chip tone={items.length ? 'moderate' : 'ok'} icon={items.length ? 'eye' : 'check'}>{items.length}</Chip></div>
      <p className="m-caption">What the caregiver reported, not proof of care. Reviewing records what you assessed and did; it does not resolve a concern.</p>
      {d && d.error && <p className="m-error">{d.error}</p>}
      {d && !items.length && <p className="m-muted">Nothing waiting.</p>}
      <ul className="ad-concerns">
        {items.slice(0, 6).map((it) => (
          <li key={`${it.type}${it.id}`}>
            <div className="m-between"><strong>{it.title}</strong><span className="m-pills">{it.flags.map((fl) => <Chip key={fl} tone={fl === 'comment' ? '' : 'moderate'}>{FLAG[fl] || fl}</Chip>)}</span></div>
            <span className="m-sub">{it.date}{it.slot && !['any', 'log', 'prn'].includes(it.slot) ? ` ${it.slot}` : ''} · reported {relTime(it.reportedAt)}{it.seenPlanVersion ? ` · seen on plan v${it.seenPlanVersion}` : ''}</span>
            {(it.note || it.reason) && <p>“{it.note || it.reason}”</p>}
            {open === it.id ? (
              <form className="ad-concern-form" onSubmit={(e) => review(e, it)}>
                <label className="ad-field"><span>What you assessed and did</span><textarea rows="2" value={note} onChange={(e) => setNote(e.target.value)} /></label>
                {error && <p className="m-error">{error}</p>}
                <div className="ad-actions"><button className="m-btn is-brand ad-btn-auto">Mark reviewed</button><button type="button" className="m-link" onClick={() => setOpen(null)}>Cancel</button></div>
              </form>
            ) : <button type="button" className="m-link" onClick={() => { setOpen(it.id); setNote(''); }}>Review</button>}
          </li>
        ))}
      </ul>
    </section>
  );
}

function RecentCheckins({ checkins, cases }) {
  const days = weekDays(checkins);
  const done = days.filter((x) => x.done).length;
  const last = checkins[0];
  return (
    <section className="ad-panel ad-span">
      <h2>Recent check-ins</h2>
      <div className="ad-tiles">
        {checkins.slice(0, 3).map((c) => (
          <div key={c.id} className="ad-tile">
            <span className={`ad-tile-label tone-${SEVERITY_TONE[c.severity] || 'ok'}`}><span className="ad-kpi-icon"><Icon name="heartPulse" size={18} /></span>{SEVERITY_LABEL[c.severity] || 'Normal'}</span>
            <strong>{c.vitals.systolic ? bp(c.vitals) : '–'}</strong>
            <span>{isToday(c.recordedAt) ? clock(c.recordedAt) : relTime(c.recordedAt)}{c.vitals.heartRate ? ` · HR ${c.vitals.heartRate}` : ''}</span>
          </div>
        ))}
        {!checkins.length && <div className="ad-tile"><span className="ad-tile-label">No check-ins</span><strong>–</strong><span>None in the last 30 days.</span></div>}
        <div className="ad-tile">
          <span className="ad-tile-label tone-ok"><span className="ad-kpi-icon"><Icon name="calendar" size={18} /></span>This week</span>
          <strong>{done} of 7</strong>
          <span>days this week{last ? ` · Last check-in ${isToday(last.recordedAt) ? clock(last.recordedAt) : relTime(last.recordedAt)}` : ''}{last && last.vitals.temperatureC ? ` · body ${last.vitals.temperatureC} °C` : ''}</span>
        </div>
        <div className="ad-tile">
          <span className="ad-tile-label"><span className="ad-kpi-icon"><Icon name="checkCircle" size={18} /></span>Resolved cases</span>
          <strong>{cases.length}</strong>
          <span>{cases.length ? `Last ${relTime(cases[0].resolvedAt)}` : 'No resolved cases.'}</span>
        </div>
      </div>
    </section>
  );
}

/** The old clinic system (via the SOAP adapter) and the health center record, one row each. */
function LegacyRecords({ patientId }) {
  const [emr, setEmr] = useState(null);
  useEffect(() => {
    api(`/api/clinic/patients/${encodeURIComponent(patientId)}/emr-history`)
      .then((r) => setEmr(r)).catch((e) => setEmr({ error: e.status === 404 ? 'No record for this patient in the health center records system yet.' : e.message }));
  }, [patientId]);
  return (
    <section className="ad-panel">
      <div className="m-between"><h2>Legacy clinic records</h2><Chip icon="checkCircle">via SOAP</Chip></div>
      {!emr && <p className="m-caption">Loading…</p>}
      {emr && <EmrPanel state={emr} />}
    </section>
  );
}

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';
import { PageHeader, PriorityTag, StatusPill, Empty, ErrorNote, Loading, Chip } from '../components/ui';
import TriageBar from '../components/TriageBar';
import { ScheduleVisitDialog, VisitCard } from '../components/visits';
import { navigate } from '../router';
import { REASON_LABEL, STATUS_LABEL, conditionLabel, relTime, dateTime } from '../format';

// 'Schedule visit' is not a plain status change: it opens a form that captures date, time, destination
// and location (POST /api/clinic/queue/:id/visits), which then moves the case to 'scheduled'.
const ACTIONS = {
  open: [['in_review', 'Start review'], ['schedule', 'Schedule visit'], ['resolved', 'Mark resolved'], ['dismissed', 'Dismiss']],
  in_review: [['schedule', 'Schedule visit'], ['resolved', 'Mark resolved'], ['dismissed', 'Dismiss']],
  scheduled: [['schedule', 'Reschedule'], ['resolved', 'Mark resolved'], ['in_review', 'Back to review']],
};
const ACTIVE = ['open', 'in_review', 'scheduled'];
const HEALTH_TYPES = ['health_anomaly', 'vitals_normal', 'missed_checkin'];

/**
 * The reason that explains the CURRENT priority: the latest health reading if it still adds risk,
 * otherwise the latest weather risk, otherwise the latest event (e.g. "Normal check-in").
 */
function primaryReason(item) {
  const recent = item.reasons.slice(0, 10);
  const health = recent.find((r) => HEALTH_TYPES.includes(r.type));
  const env = recent.find((r) => r.type === 'environmental_risk');
  if (item.scores.health > 0 && health && health.type !== 'vitals_normal') return health;
  if (item.scores.environment > 0 && env) return env;
  return health || env || recent[0] || null;
}

/** Collapse repeated identical reasons ("Clinic records" x5) into one line with a count. */
function groupReasons(reasons) {
  const out = [];
  for (const r of reasons) {
    const last = out[out.length - 1];
    if (last && last.type === r.type && last.detail === r.detail) last.count += 1;
    else out.push({ ...r, count: 1 });
  }
  return out;
}

export function weatherSentence(s) {
  if (!s) return '';
  if (s.areasChecked === 0) return 'No patient areas to check.';
  if (s.areasFailed === s.areasChecked) return 'Could not get weather for any area. Check the OpenWeatherMap key and internet connection, then try again.';
  const failed = s.areasFailed ? ` Weather was unavailable for ${s.areasFailed} area${s.areasFailed === 1 ? '' : 's'}.` : '';
  const hot = s.hottest ? ` Highest heat index ${s.hottest.heatIndexC} °C in ${s.hottest.locationName || s.hottest.zipCode}.` : '';
  const hazards = s.heatAreas.length + s.stormAreas.length;
  const okCount = s.areasChecked - s.areasFailed;
  if (!hazards) return `Checked ${okCount} area${okCount === 1 ? '' : 's'}. No heat or storm hazards right now.${hot}${failed}`;
  const parts = [];
  if (s.heatAreas.length) parts.push(`heat risk in ${s.heatAreas.length} area${s.heatAreas.length === 1 ? '' : 's'}`);
  if (s.stormAreas.length) parts.push(`storm risk in ${s.stormAreas.length} area${s.stormAreas.length === 1 ? '' : 's'}`);
  const warned = s.patientsWarned
    ? ` ${s.patientsWarned} patient${s.patientsWarned === 1 ? '' : 's'} warned and added to the queue.`
    : s.alreadyWarned ? ' At-risk patients were already warned earlier today.' : ' No at-risk patients live there.';
  return `Found ${parts.join(' and ')}.${warned}${hot}${failed}`;
}

function ScoreBreakdown({ scores }) {
  const rows = [
    ['Health readings', scores.health],
    ['Weather exposure', scores.environment],
    ['Clinic records', scores.emr * 10],
  ];
  return (
    <div className="score">
      <div className="score-total"><span>{scores.total}</span><small>risk score out of 100</small></div>
      <dl className="score-bars">
        {rows.map(([label, v]) => (
          <div key={label}>
            <dt>{label}</dt>
            <dd><span className="bar"><span style={{ width: `${Math.min(100, v)}%` }} /></span><span className="bar-value">{label === 'Clinic records' ? `+${scores.emr}` : v}</span></dd>
          </div>
        ))}
      </dl>
    </div>
  );
}

export function EmrPanel({ state }) {
  if (!state) return <Loading label="Loading clinic records" />;
  if (state.error) return <p className="muted small">{state.error}</p>;
  const h = state.history;
  return (
    <div className="emr">
      <p className="muted small">From the health center's records system{h.facility ? ` (${h.facility})` : ''}.</p>
      <dl className="emr-facts">
        <div><dt>Diagnoses</dt><dd>{h.diagnoses.length ? h.diagnoses.map((d) => <span key={d.code} className="emr-line">{d.description}<small> {d.code}{d.chronic ? ', long-term' : ''}</small></span>) : 'None recorded'}</dd></div>
        <div><dt>Current medicines</dt><dd>{h.medications.filter((m) => m.active).map((m) => <span key={m.name} className="emr-line">{m.name} {m.dosage}<small> {m.frequency}</small></span>)}</dd></div>
        <div><dt>Allergies</dt><dd>{h.allergies.length ? h.allergies.join(', ') : 'None recorded'}</dd></div>
      </dl>
      <h4>Past visits in the records system</h4>
      <ul className="visits">
        {h.visits.slice(0, 4).map((v) => (
          <li key={v.id}>
            <span>{v.date}</span>
            <span><strong>{v.type.replace('_', ' ')}</strong> at {v.facility}<br /><small className="muted">{[v.complaint, v.bloodPressure && `BP ${v.bloodPressure.systolic}/${v.bloodPressure.diastolic}`].filter(Boolean).join(', ')}</small></span>
          </li>
        ))}
      </ul>
    </div>
  );
}

export default function ClinicQueue({ user }) {
  const toast = useToast();
  const [queue, setQueue] = useState(null);
  const [error, setError] = useState('');
  // ?case=<id> preselects a case (used by the patient profile's "Open in risk queue" link)
  const [selectedId, setSelectedId] = useState(() => new URLSearchParams(window.location.search).get('case'));
  const [priority, setPriority] = useState(null);
  const [search, setSearch] = useState('');
  const [emr, setEmr] = useState(null);
  const [note, setNote] = useState('');
  const [saving, setSaving] = useState(false);
  const [weather, setWeather] = useState(null);
  const [checking, setChecking] = useState(false);
  const [showAllReasons, setShowAllReasons] = useState(false);
  const [visits, setVisits] = useState(null);
  const [scheduling, setScheduling] = useState(false);
  const canAct = user.role === 'clinic_staff';

  const load = useCallback(() => api('/api/clinic/queue')
    .then((q) => { setQueue(q); setError(''); })
    .catch((e) => setError(e.message)), []);

  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  const items = useMemo(() => {
    if (!queue) return [];
    const q = search.trim().toLowerCase();
    return queue.items.filter((i) => (!priority || i.priority === priority)
      && (!q || i.patient.name.toLowerCase().includes(q) || i.patient.id.toLowerCase().includes(q)));
  }, [queue, priority, search]);

  const selected = queue && queue.items.find((i) => i.id === selectedId);

  function select(id) {
    setSelectedId(id);
    if (window.matchMedia('(max-width: 960px)').matches) {
      setTimeout(() => document.querySelector('.detail')?.scrollIntoView({ behavior: 'smooth', block: 'start' }), 50);
    }
  }

  const loadVisits = useCallback((patientId) => Promise.all([
    api(`/api/clinic/visits?patientId=${patientId}&view=upcoming`),
    api(`/api/clinic/visits?patientId=${patientId}&view=recent`),
  ]).then(([u, r]) => setVisits({ upcoming: u.visits, recent: r.visits })).catch(() => setVisits({ upcoming: [], recent: [] })), []);

  useEffect(() => {
    setEmr(null);
    setNote('');
    setShowAllReasons(false);
    setVisits(null);
    if (!selected) return;
    loadVisits(selected.patient.id);
    api(`/api/clinic/patients/${selected.patient.id}/emr-history`)
      .then((r) => setEmr(r))
      .catch((e) => setEmr({ error: e.status === 404 ? 'This patient has no record in the clinic records system.' : e.message }));
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  async function act(status, label) {
    if (status === 'schedule') { setScheduling(true); return; }
    setSaving(true);
    try {
      await api(`/api/clinic/queue/${selected.id}`, { method: 'PATCH', body: { status, notes: note.trim() || undefined, assignedTo: user.id } });
      toast({ tone: 'success', title: `${selected.patient.name}: ${STATUS_LABEL[status]}`, body: note.trim() ? 'Your note was saved to the follow-up log.' : undefined });
      setNote('');
      if (!ACTIVE.includes(status)) setSelectedId(null);
      load();
    } catch (e) {
      toast({ tone: 'error', title: `Could not ${label.toLowerCase()}`, body: e.message });
    } finally {
      setSaving(false);
    }
  }

  async function runWeatherCheck() {
    setChecking(true);
    try {
      const r = await api('/api/alerts/weather-check', { method: 'POST', body: {} });
      setWeather({ ok: true, ...r });
      load();
    } catch (e) {
      setWeather({ ok: false, message: e.status === 503 ? 'Weather checks are not set up yet. Add an OpenWeatherMap API key to the alert service.' : e.message });
    } finally {
      setChecking(false);
    }
  }

  return (
    <>
      <PageHeader title="Risk queue" subtitle="Patients who need attention, highest risk first. Updates every 15 seconds.">
        <button type="button" className="btn btn-secondary" onClick={runWeatherCheck} disabled={checking}>
          {checking ? 'Checking weather…' : 'Check weather risk now'}
        </button>
      </PageHeader>

      {weather && (
        <div className={`note ${!weather.ok || weather.summary.areasFailed === weather.summary.areasChecked ? 'note-error' : weather.summary.heatAreas.length || weather.summary.stormAreas.length ? 'note-warn' : 'note-info'}`} role="status">
          <span>
            <strong>Weather check{weather.ok ? ` at ${dateTime(weather.ranAt)}` : ' failed'}.</strong>{' '}
            {weather.ok ? weatherSentence(weather.summary) : weather.message}
            {weather.ok && weather.summary.usedCachedData && ' OpenWeatherMap was unreachable, so the last saved readings were used.'}
          </span>
          <button type="button" className="icon-btn" aria-label="Dismiss" onClick={() => setWeather(null)}>×</button>
        </div>
      )}

      <ErrorNote error={error} onRetry={load} />
      {!queue && !error && <Loading label="Loading risk queue" />}

      {queue && (
        <>
          <TriageBar summary={queue.summary} active={priority} onSelect={setPriority} />
          <div className="layout-split layout-queue">
            <section className="panel panel-flush">
              <div className="list-toolbar">
                <input type="search" placeholder="Search by name or patient ID" value={search} onChange={(e) => setSearch(e.target.value)} aria-label="Search patients" />
              </div>
              {items.length === 0 ? (
                <Empty title={queue.items.length ? 'No patients match this filter' : 'The queue is clear'}>
                  {queue.items.length ? 'Clear the search or choose another priority.' : 'New check-in alerts and weather risks will appear here.'}
                </Empty>
              ) : (
                <ul className="queue">
                  {items.map((i) => {
                    const why = primaryReason(i);
                    return (
                    <li key={i.id}>
                      <button type="button" className={`queue-row ribbon-${i.priority} ${i.id === selectedId ? 'is-selected' : ''}`} onClick={() => select(i.id)} aria-current={i.id === selectedId}>
                        <span className="queue-score">{i.scores.total}</span>
                        <span className="queue-main">
                          <span className="queue-name">{i.patient.name}</span>
                          {why && (
                            <span className="queue-reason">
                              <strong>{REASON_LABEL[why.type] || 'Update'}:</strong> {why.detail}
                            </span>
                          )}
                        </span>
                        <span className="queue-side">
                          <PriorityTag value={i.priority} />
                          <StatusPill value={i.status} />
                          <time className="muted small" dateTime={i.lastEventAt}>{relTime(i.lastEventAt)}</time>
                        </span>
                      </button>
                    </li>
                    );
                  })}
                </ul>
              )}
            </section>

            <aside className="panel detail" aria-label="Patient details">
              {!selected ? (
                <Empty title="Select a patient">See why they are in the queue, their clinic records, and log what you did.</Empty>
              ) : (
                <>
                  <div className="detail-head">
                    <div>
                      <h2>{selected.patient.name}</h2>
                      <p className="muted small">Patient {selected.patient.id}, area {selected.patient.zipCode}{selected.patient.assignedClinic ? `, ${selected.patient.assignedClinic}` : ''}</p>
                    </div>
                    <PriorityTag value={selected.priority} long />
                  </div>
                  <div className="btn-row detail-links">
                    <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate(`/clinic/patients/${encodeURIComponent(selected.patient.id)}`)}>
                      Open full patient profile
                    </button>
                  </div>
                  <div className="chips-row">
                    {selected.patient.conditions.map((c) => <Chip key={c}>{conditionLabel(c)}</Chip>)}
                    {selected.patient.mobilityRestricted && <Chip tone="chip-warn">Limited mobility</Chip>}
                  </div>

                  <ScoreBreakdown scores={selected.scores} />
                  {selected.priorityRule && <p className="muted small priority-rule">Why {selected.priority}: {selected.priorityRule}</p>}

                  {visits && visits.upcoming.length > 0 && (
                    <>
                      <h3>Scheduled visit</h3>
                      {visits.upcoming.map((v) => (
                        <VisitCard key={v.id} visit={v} canAct={canAct} onChanged={(r) => { loadVisits(selected.patient.id); load(); if (r.item && !ACTIVE.includes(r.item.status)) setSelectedId(null); }} />
                      ))}
                    </>
                  )}

                  {canAct && ACTIONS[selected.status] && (
                    <div className="actions-box">
                      <label className="field">
                        <span>Follow-up note</span>
                        <textarea rows="2" value={note} onChange={(e) => setNote(e.target.value)} placeholder="e.g. Called caregiver, recheck BP in 30 minutes" />
                      </label>
                      <div className="btn-row">
                        {ACTIONS[selected.status].map(([status, label], idx) => (
                          <button key={status} type="button" className={`btn ${idx === 0 ? 'btn-primary' : status === 'dismissed' ? 'btn-quiet' : 'btn-secondary'}`} disabled={saving} onClick={() => act(status, label)}>{label}</button>
                        ))}
                      </div>
                      <p className="muted small">Status: {STATUS_LABEL[selected.status]}</p>
                    </div>
                  )}
                  {!canAct && <p className="note note-info">Administrators can view the queue. Only clinic staff can change a patient's status.</p>}

                  <h3>Why they're in the queue</h3>
                  {(() => {
                    const grouped = groupReasons(selected.reasons);
                    const shown = showAllReasons ? grouped : grouped.slice(0, 4);
                    return (
                      <>
                        <ol className="timeline">
                          {shown.map((r, idx) => (
                            <li key={`${r.at}-${idx}`} className={`timeline-item reason-${r.type}`}>
                              <div className="timeline-head">
                                <strong>{REASON_LABEL[r.type] || r.type}{r.count > 1 ? ` (${r.count} times)` : ''}</strong>
                                <time className="muted small" dateTime={r.at} title={dateTime(r.at)}>{relTime(r.at)}</time>
                              </div>
                              <p>{r.detail}</p>
                            </li>
                          ))}
                        </ol>
                        {grouped.length > 4 && (
                          <button type="button" className="btn btn-quiet btn-sm" onClick={() => setShowAllReasons(!showAllReasons)}>
                            {showAllReasons ? 'Show fewer' : `Show all ${grouped.length}`}
                          </button>
                        )}
                      </>
                    );
                  })()}

                  <h3>Recent visits</h3>
                  {!visits && <Loading label="Loading visits" />}
                  {visits && visits.recent.length === 0 && <p className="muted small">No completed visits in the last 30 days. A visit appears here once it is marked completed.</p>}
                  {visits && visits.recent.map((v) => <VisitCard key={v.id} visit={v} canAct={false} />)}

                  <h3>Clinic records</h3>
                  <EmrPanel state={emr} />
                </>
              )}
            </aside>
          </div>
        </>
      )}
      {scheduling && selected && (
        <ScheduleVisitDialog
          item={selected}
          existing={visits && visits.upcoming[0]}
          onClose={() => setScheduling(false)}
          onScheduled={() => { setScheduling(false); loadVisits(selected.patient.id); load(); }}
        />
      )}
    </>
  );
}

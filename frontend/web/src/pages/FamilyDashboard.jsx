import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader, SeverityBadge, Empty, ErrorNote, Loading, Chip } from '../components/ui';
import TrendChart from '../components/TrendChart';
import { CareToday } from '../components/care';
import { conditionLabel, relTime, dateTime, age, vitalOf, visitWhen, VISIT_TYPE_LABEL } from '../format';

const PERIODS = [7, 30];

function Reading({ label, value, unit, flagged }) {
  return (
    <div className={`reading ${flagged ? 'is-flagged' : ''}`}>
      <span className="reading-label">{label}</span>
      <span className="reading-value">{value ?? '–'}{value != null && unit && <small>{unit}</small>}</span>
      {flagged && <span className="reading-flag">Outside usual range</span>}
    </div>
  );
}

function deliveryText(delivery = []) {
  const sms = delivery.filter((d) => d.channel === 'sms');
  if (!sms.length) return 'Shown in the app';
  const n = (k, word = 'contact') => `${k} ${word}${k === 1 ? '' : 's'}`;
  const real = sms.filter((d) => ['sent', 'delivered'].includes(d.status)).length;
  const simulated = sms.filter((d) => d.status === 'simulated').length;
  const failed = sms.filter((d) => ['failed', 'undelivered'].includes(d.status)).length;
  const skipped = sms.filter((d) => d.status === 'skipped').length;
  const pending = sms.length - real - simulated - failed - skipped;
  const parts = [];
  if (real) parts.push(`Texted to ${n(real)}`);
  if (pending) parts.push(`sending to ${n(pending)}`);
  if (failed) parts.push(`text failed for ${n(failed)}`);
  if (skipped) parts.push(`${n(skipped, 'text')} held back (daily limit)`);
  if (simulated) parts.push(`${simulated} simulated (test number${simulated === 1 ? '' : 's'})`);
  const text = parts.join('; ');
  const out = text.charAt(0).toUpperCase() + text.slice(1);
  return failed || skipped ? `${out}; shown in the app` : out;
}

export default function FamilyDashboard({ user }) {
  const [patientId, setPatientId] = useState(user.patients[0] || '');
  const [days, setDays] = useState(30);
  const [history, setHistory] = useState(null);
  const [alerts, setAlerts] = useState(null);
  const [error, setError] = useState('');
  const [updatedAt, setUpdatedAt] = useState(null);
  const [extra, setExtra] = useState({ meds: [], visits: [] });

  useEffect(() => {
    if (!patientId) return;
    Promise.all([
      api(`/api/patients/${patientId}/medications`).catch(() => ({ medications: [] })),
      api(`/api/patients/${patientId}/visits?view=upcoming`).catch(() => ({ visits: [] })),
    ]).then(([m, v]) => setExtra({ meds: m.medications, visits: v.visits }));
  }, [patientId]);

  const load = useCallback(() => {
    if (!patientId) return Promise.resolve();
    return Promise.all([
      api(`/api/patients/${patientId}/history?days=${days}&limit=200`),
      api(`/api/alerts/notifications?patientId=${patientId}&limit=15`),
    ]).then(([h, n]) => {
      setHistory(h);
      setAlerts(n.notifications);
      setError('');
      setUpdatedAt(new Date());
    }).catch((e) => setError(e.message));
  }, [patientId, days]);

  useEffect(() => {
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, [load]);

  if (!user.patients.length) return <Empty title="No family member linked yet">Ask the health center to link your account to your relative.</Empty>;
  if (!history) return error ? <ErrorNote error={error} onRetry={load} /> : <Loading label="Loading your family member's health" />;

  const p = history.patient;
  const latest = history.checkins[0];
  const flagged = new Set((latest ? latest.anomalies : []).map((a) => vitalOf(a.code)).filter(Boolean));
  const chrono = [...history.checkins].reverse().map((c) => ({
    t: c.recordedAt,
    sys: c.vitals.systolic,
    dia: c.vitals.diastolic,
    hr: c.vitals.heartRate,
    flag: c.severity === 'high' || c.severity === 'critical',
  }));
  const t = history.trends;

  return (
    <>
      <PageHeader
        title={p.fullName}
        subtitle={[age(p.birthDate) && `${age(p.birthDate)} years old`, latest ? `last check-in ${relTime(latest.recordedAt)}` : 'no check-ins yet'].filter(Boolean).join(', ')}
      >
        {user.patients.length > 1 && (
          <select value={patientId} onChange={(e) => { setPatientId(e.target.value); setHistory(null); }} aria-label="Family member">
            {user.patients.map((id) => <option key={id}>{id}</option>)}
          </select>
        )}
        <span className="muted small" aria-live="polite">{updatedAt ? `Updated ${relTime(updatedAt)}` : ''}</span>
      </PageHeader>

      {(p.conditions.length > 0 || p.mobilityRestricted) && (
        <div className="chips-row">
          {p.conditions.map((c) => <Chip key={c}>{conditionLabel(c)}</Chip>)}
          {p.mobilityRestricted && <Chip tone="chip-warn">Limited mobility</Chip>}
        </div>
      )}
      <ErrorNote error={error} onRetry={load} />

      <section className={`panel latest ${latest ? `latest-${latest.severity}` : ''}`}>
        <div className="panel-head">
          <h2 className="panel-title">Latest reading</h2>
          {latest && <span className="muted small">{dateTime(latest.recordedAt)} <SeverityBadge value={latest.severity} /></span>}
        </div>
        {latest ? (
          <>
            <div className="readings">
              <Reading label="Blood pressure" value={latest.vitals.systolic ? `${latest.vitals.systolic}/${latest.vitals.diastolic}` : null} unit="mmHg" flagged={flagged.has('bp')} />
              <Reading label="Heart rate" value={latest.vitals.heartRate} unit="bpm" flagged={flagged.has('hr')} />
              <Reading label="Temperature" value={latest.vitals.temperatureC} unit="°C" flagged={flagged.has('temp')} />
              <Reading label="Oxygen" value={latest.vitals.spo2} unit="%" flagged={flagged.has('spo2')} />
            </div>
            <p className="latest-meds">
              {latest.medication.taken === false ? 'Medicines were missed in this check-in.' : 'Medicines taken.'}
              {latest.notes ? ` Caregiver's note: "${latest.notes}"` : ''}
            </p>
          </>
        ) : <Empty title="No check-ins yet">Readings appear here as soon as the caregiver records them.</Empty>}
      </section>

      <div className="layout-split layout-wide-left">
        <section className="panel">
          <div className="panel-head">
            <h2 className="panel-title">Trends</h2>
            <div className="tabs" role="group" aria-label="Period">
              {PERIODS.map((d) => <button key={d} type="button" className={`tab ${days === d ? 'is-on' : ''}`} aria-pressed={days === d} onClick={() => setDays(d)}>{d} days</button>)}
            </div>
          </div>
          <dl className="stats">
            <div><dt>Check-ins</dt><dd>{t.totalCheckins}</dd></div>
            <div><dt>Average blood pressure</dt><dd>{t.bloodPressure.avgSystolic ? `${t.bloodPressure.avgSystolic}/${t.bloodPressure.avgDiastolic}` : '–'}</dd></div>
            <div><dt>Days with missed medicines</dt><dd>{t.missedMedicationDays}</dd></div>
            <div><dt>Readings needing attention</dt><dd>{t.highSeverityCheckins}</dd></div>
          </dl>
          <h3 className="chart-title">Blood pressure</h3>
          <TrendChart points={chrono} unit="mmHg" band={[90, 140]} label="Blood pressure trend"
            series={[{ key: 'sys', label: 'Top number (systolic)', className: 's-primary' }, { key: 'dia', label: 'Bottom number (diastolic)', className: 's-secondary' }]} />
          <h3 className="chart-title">Heart rate</h3>
          <TrendChart points={chrono} unit="bpm" band={[60, 100]} label="Heart rate trend" series={[{ key: 'hr', label: 'Heart rate', className: 's-primary' }]} />
        </section>

        <div className="stack">
        {extra.visits.length > 0 && (
          <section className="panel visit-banner">
            <h2 className="panel-title">Next health center visit</h2>
            <p className="big-line">{visitWhen(extra.visits[0])}</p>
            <p>{VISIT_TYPE_LABEL[extra.visits[0].visitType]}: {extra.visits[0].destination}</p>
          </section>
        )}
        <section className="panel">
          <h2 className="panel-title">Alerts</h2>
          {alerts && alerts.length === 0 && <Empty title="No alerts">You'll get a text and see it here if a reading needs attention.</Empty>}
          <ol className="timeline">
            {(alerts || []).map((a) => (
              <li key={a.id} className={`timeline-item sev-line-${a.severity}`}>
                <div className="timeline-head">
                  <strong>{a.title}</strong>
                  <time className="muted small" dateTime={a.createdAt} title={dateTime(a.createdAt)}>{relTime(a.createdAt)}</time>
                </div>
                <p>{a.message}</p>
                <span className="muted small">{deliveryText(a.delivery)}</span>
              </li>
            ))}
          </ol>
        </section>
        {extra.meds.length > 0 && (
          <section className="panel">
            <h2 className="panel-title">Prescribed medicines</h2>
            <ul className="med-list">
              {extra.meds.map((m) => (
                <li key={m.id}><div><strong>{m.name}</strong> {m.dosage}<br /><span className="muted small">{m.frequency}{m.times.length ? ` at ${m.times.join(', ')}` : ''}</span></div></li>
              ))}
            </ul>
          </section>
        )}
        </div>
      </div>

      {patientId && (
        <section className="panel care-panel">
          <h2 className="panel-title">Caregiver duties today</h2>
          <p className="muted small">What the caregiver has done from the care plan the health center set up.</p>
          <CareToday patientId={patientId} />
        </section>
      )}
    </>
  );
}

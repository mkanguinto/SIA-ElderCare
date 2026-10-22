import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';
import { navigate } from '../router';
import { PageHeader, PriorityTag, StatusPill, SeverityBadge, Empty, ErrorNote, Loading, Chip } from '../components/ui';
import TrendChart from '../components/TrendChart';
import { VisitCard } from '../components/visits';
import { EmrPanel } from './ClinicQueue';
import { CarePlanEditor, CareToday } from '../components/care';
import { conditionLabel, age, bp, relTime, dateTime, ROLE_LABEL, STATUS_LABEL } from '../format';

const BLANK_MED = { name: '', dosage: '', frequency: 'Once daily', times: '08:00', instructions: '' };
const BLANK_CONTACT = { name: '', relation: 'family', phone: '', userId: '' };

function Section({ title, action, children }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="panel-title">{title}</h2>{action}</div>
      {children}
    </section>
  );
}

function Medications({ patientId, canEdit }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [adding, setAdding] = useState(false);
  const [form, setForm] = useState(BLANK_MED);
  const [errors, setErrors] = useState(null);

  const load = useCallback(() => api(`/api/patients/${patientId}/medications?includeInactive=true`).then(setData).catch((e) => setData({ error: e.message })), [patientId]);
  useEffect(() => { load(); }, [load]);

  async function add(e) {
    e.preventDefault();
    setErrors(null);
    try {
      const times = form.times.split(',').map((t) => t.trim()).filter(Boolean);
      await api(`/api/patients/${patientId}/medications`, { method: 'POST', body: { ...form, times, instructions: form.instructions || undefined } });
      toast({ tone: 'success', title: `${form.name} prescribed`, body: 'The caregiver sees it on their check-in screen.' });
      setForm(BLANK_MED);
      setAdding(false);
      load();
    } catch (err) {
      setErrors(err.details || [err.message]);
    }
  }

  async function stop(m) {
    try {
      await api(`/api/patients/${patientId}/medications/${m.id}`, { method: 'PATCH', body: { active: false } });
      toast({ tone: 'success', title: `${m.name} stopped` });
      load();
    } catch (err) {
      toast({ tone: 'error', title: 'Could not stop medicine', body: err.message });
    }
  }

  return (
    <Section title="Prescribed medicines" action={canEdit && !adding && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>Add medicine</button>}>
      {!data && <Loading />}
      {data && data.error && <p className="muted">{data.error}</p>}
      {data && data.medications && data.medications.length === 0 && <p className="muted">No medicines prescribed yet.</p>}
      {data && data.medications && data.medications.length > 0 && (
        <table className="table">
          <thead><tr><th>Medicine</th><th>Schedule</th><th>Instructions</th><th /></tr></thead>
          <tbody>
            {data.medications.map((m) => (
              <tr key={m.id} className={m.active ? '' : 'is-inactive'}>
                <td><strong>{m.name}</strong> {m.dosage}{!m.active && <span className="pill">Stopped</span>}</td>
                <td>{m.frequency}{m.times.length ? <><br /><span className="muted small">{m.times.join(', ')}</span></> : null}</td>
                <td className="small">{m.instructions || '–'}{m.prescribedBy && <><br /><span className="muted">{m.prescribedBy}</span></>}</td>
                <td>{canEdit && m.active && <button type="button" className="btn btn-quiet btn-sm" onClick={() => stop(m)}>Stop</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {adding && (
        <form className="inline-form" onSubmit={add} noValidate>
          <div className="form-grid">
            <label className="field"><span>Medicine</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} placeholder="Losartan" /></label>
            <label className="field"><span>Dose</span><input value={form.dosage} onChange={(e) => setForm({ ...form, dosage: e.target.value })} placeholder="50 mg" /></label>
            <label className="field"><span>How often</span><input value={form.frequency} onChange={(e) => setForm({ ...form, frequency: e.target.value })} /></label>
            <label className="field"><span>Times (24-hour, comma separated)</span><input value={form.times} onChange={(e) => setForm({ ...form, times: e.target.value })} placeholder="08:00, 20:00" /></label>
          </div>
          <label className="field"><span>Instructions (optional)</span><input value={form.instructions} onChange={(e) => setForm({ ...form, instructions: e.target.value })} placeholder="Take after breakfast" /></label>
          {errors && <div className="note note-error"><ul>{errors.map((m) => <li key={m}>{m}</li>)}</ul></div>}
          <div className="btn-row"><button className="btn btn-primary btn-sm">Save medicine</button><button type="button" className="btn btn-quiet btn-sm" onClick={() => { setAdding(false); setErrors(null); }}>Cancel</button></div>
        </form>
      )}
    </Section>
  );
}

function CareTeam({ patientId, canEdit }) {
  const toast = useToast();
  const [users, setUsers] = useState(null);
  const [contacts, setContacts] = useState(null);
  const [link, setLink] = useState('');
  const [form, setForm] = useState(BLANK_CONTACT);
  const [adding, setAdding] = useState(false);
  const [errors, setErrors] = useState(null);

  const load = useCallback(() => Promise.all([
    api('/api/directory/users?role=caregiver,family_member').then((r) => setUsers(r.users)),
    api(`/api/alerts/subscribers?patientId=${patientId}`).then(setContacts),
  ]).catch((e) => setErrors([e.message])), [patientId]);
  useEffect(() => { load(); }, [load]);

  const linked = (users || []).filter((u) => u.patients.includes(patientId));
  const unlinked = (users || []).filter((u) => !u.patients.includes(patientId));

  async function linkUser() {
    if (!link) return;
    try {
      await api(`/api/directory/users/${link}/patients`, { method: 'PUT', body: { add: [patientId] } });
      const u = users.find((x) => x.id === link);
      toast({ tone: 'success', title: `${u.name} can now see this patient`, body: 'They need to sign out and sign in again.' });
      setLink('');
      load();
    } catch (e) { toast({ tone: 'error', title: 'Could not link account', body: e.message }); }
  }
  async function unlinkUser(u) {
    try {
      await api(`/api/directory/users/${u.id}/patients`, { method: 'PUT', body: { remove: [patientId] } });
      toast({ tone: 'success', title: `${u.name} unlinked` });
      load();
    } catch (e) { toast({ tone: 'error', title: 'Could not unlink account', body: e.message }); }
  }
  async function addContact(e) {
    e.preventDefault();
    setErrors(null);
    try {
      await api('/api/alerts/subscribers', { method: 'POST', body: { patientId, ...form, userId: form.userId || undefined } });
      toast({ tone: 'success', title: `${form.name} will receive SMS alerts` });
      setForm(BLANK_CONTACT);
      setAdding(false);
      load();
    } catch (err) { setErrors(err.details || [err.message]); }
  }
  async function removeContact(c) {
    try {
      await api(`/api/alerts/subscribers/${c.id}`, { method: 'DELETE' });
      toast({ tone: 'success', title: `${c.name} will no longer get texts` });
      load();
    } catch (err) { toast({ tone: 'error', title: 'Could not remove contact', body: err.message }); }
  }

  const active = contacts ? contacts.subscribers.filter((c) => c.smsEnabled) : [];
  return (
    <Section title="Care team and SMS contacts">
      <h3 className="first">App accounts</h3>
      {!users && <Loading />}
      {users && linked.length === 0 && <p className="muted small">No caregiver or family account can see this patient yet.</p>}
      <ul className="plain-list">
        {linked.map((u) => (
          <li key={u.id}>
            <span><strong>{u.name}</strong> <span className="muted small">{ROLE_LABEL[u.role]}, {u.username}</span></span>
            {canEdit && <button type="button" className="btn btn-quiet btn-sm" onClick={() => unlinkUser(u)}>Unlink</button>}
          </li>
        ))}
      </ul>
      {canEdit && unlinked.length > 0 && (
        <div className="row link-row">
          <select value={link} onChange={(e) => setLink(e.target.value)} aria-label="Link an account">
            <option value="">Link a caregiver or family account…</option>
            {unlinked.map((u) => <option key={u.id} value={u.id}>{u.name} ({ROLE_LABEL[u.role]})</option>)}
          </select>
          <button type="button" className="btn btn-secondary btn-sm" disabled={!link} onClick={linkUser}>Link</button>
        </div>
      )}

      <h3>SMS alert contacts</h3>
      {contacts && contacts.sms && (
        <p className={`note ${contacts.sms.live ? 'note-info' : 'note-warn'} small`}>
          <span>SMS via {contacts.sms.provider === 'none' ? 'no provider' : contacts.sms.provider}: {contacts.sms.reason}</span>
        </p>
      )}
      {contacts && active.length === 0 && <p className="muted small">No one receives text alerts for this patient.</p>}
      <ul className="plain-list">
        {active.map((c) => (
          <li key={c.id}>
            <span><strong>{c.name}</strong> <span className="muted small">{c.relation}, {c.phone}</span> {c.receivesRealSms ? <span className="pill status-resolved">Real SMS</span> : <span className="pill">Simulated</span>}</span>
            {canEdit && <button type="button" className="btn btn-quiet btn-sm" onClick={() => removeContact(c)}>Remove</button>}
          </li>
        ))}
      </ul>
      {canEdit && !adding && <button type="button" className="btn btn-secondary btn-sm" onClick={() => setAdding(true)}>Add SMS contact</button>}
      {adding && (
        <form className="inline-form" onSubmit={addContact} noValidate>
          <div className="form-grid">
            <label className="field"><span>Name</span><input value={form.name} onChange={(e) => setForm({ ...form, name: e.target.value })} /></label>
            <label className="field"><span>Mobile number</span><input inputMode="tel" value={form.phone} onChange={(e) => setForm({ ...form, phone: e.target.value })} placeholder="09171234567" /></label>
            <label className="field"><span>Relation</span>
              <select value={form.relation} onChange={(e) => setForm({ ...form, relation: e.target.value })}>
                <option value="family">Family</option><option value="caregiver">Caregiver</option><option value="sponsor">Sponsor</option>
              </select>
            </label>
            {form.relation === 'caregiver' && (
              <label className="field"><span>Caregiver account (for SMS check-ins)</span>
                <select value={form.userId} onChange={(e) => setForm({ ...form, userId: e.target.value })}>
                  <option value="">Choose…</option>
                  {(users || []).filter((u) => u.role === 'caregiver').map((u) => <option key={u.id} value={u.id}>{u.name}</option>)}
                </select>
              </label>
            )}
          </div>
          {errors && <div className="note note-error"><ul>{errors.map((m) => <li key={m}>{m}</li>)}</ul></div>}
          <div className="btn-row"><button className="btn btn-primary btn-sm">Save contact</button><button type="button" className="btn btn-quiet btn-sm" onClick={() => { setAdding(false); setErrors(null); }}>Cancel</button></div>
        </form>
      )}
    </Section>
  );
}

export default function PatientProfile({ user, params }) {
  const patientId = params.id;
  const canEdit = user.role === 'clinic_staff';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => Promise.all([
    api(`/api/patients/${encodeURIComponent(patientId)}/history?days=30&limit=200`),
    api(`/api/clinic/queue?patientId=${encodeURIComponent(patientId)}`),
    api(`/api/clinic/queue/history?patientId=${encodeURIComponent(patientId)}&limit=20`),
    api(`/api/clinic/visits?patientId=${encodeURIComponent(patientId)}&view=all&limit=20`),
    api(`/api/clinic/patients/${encodeURIComponent(patientId)}/emr-history`).catch((e) => ({ error: e.status === 404 ? 'No record for this patient in the health center records system yet.' : e.message })),
  ]).then(([history, queue, cases, visits, emr]) => {
    setData({ history, active: queue.items[0] || null, cases: cases.cases, visits: visits.visits, emr });
    setError('');
  }).catch((e) => setError(e.status === 404 ? `Patient ${patientId} was not found.` : e.message)), [patientId]);
  useEffect(() => { load(); }, [load]);

  if (error) return <><PageHeader title="Patient profile" /><ErrorNote error={error} onRetry={load} /><button type="button" className="btn btn-secondary" onClick={() => navigate('/clinic')}>Back to risk queue</button></>;
  if (!data) return <Loading label="Loading patient profile" />;

  const p = data.history.patient;
  const latest = data.history.checkins[0];
  const chrono = [...data.history.checkins].reverse().map((c) => ({ t: c.recordedAt, sys: c.vitals.systolic, dia: c.vitals.diastolic, hr: c.vitals.heartRate, flag: ['high', 'critical'].includes(c.severity) }));
  const base = p.baseline || {};

  return (
    <>
      <PageHeader title={p.fullName} subtitle={[`Patient ${p.id}`, age(p.birthDate) && `${age(p.birthDate)} years old`, p.sex && { F: 'female', M: 'male', X: 'other' }[p.sex]].filter(Boolean).join(', ')}>
        <button type="button" className="btn btn-quiet" onClick={() => navigate('/clinic')}>Back to risk queue</button>
      </PageHeader>
      <div className="chips-row">
        {p.conditions.map((c) => <Chip key={c}>{conditionLabel(c)}</Chip>)}
        {p.mobilityRestricted && <Chip tone="chip-warn">Limited mobility</Chip>}
      </div>

      <div className="profile-grid">
        <section className="panel">
          <h2 className="panel-title">Details</h2>
          <dl className="facts">
            <div><dt>Address</dt><dd>{[p.addressLine, p.zipCode].filter(Boolean).join(', ') || '–'}</dd></div>
            <div><dt>Health center</dt><dd>{p.assignedClinic || '–'}</dd></div>
            <div><dt>Emergency contact</dt><dd>{p.emergencyContact ? `${p.emergencyContact.name || ''}${p.emergencyContact.relation ? ` (${p.emergencyContact.relation})` : ''} ${p.emergencyContact.phone || ''}` : '–'}</dd></div>
            <div><dt>Usual readings</dt><dd>{base.systolic ? `BP ${base.systolic}/${base.diastolic}` : ''}{base.heartRate ? `, HR ${base.heartRate}` : ''}{base.spo2 ? `, SpO₂ ${base.spo2}%` : ''}{!base.systolic && !base.heartRate ? '–' : ''}</dd></div>
            {p.notes && <div><dt>Notes</dt><dd>{p.notes}</dd></div>}
          </dl>
        </section>

        <section className={`panel case-card ${data.active ? `case-${data.active.priority}` : ''}`}>
          <h2 className="panel-title">Current case</h2>
          {!data.active ? <p className="muted">No open case. The patient appears in the risk queue when a check-in, missed check-in or weather alert needs attention.</p> : (
            <>
              <div className="row between"><span><PriorityTag value={data.active.priority} long /> <StatusPill value={data.active.status} /></span><span className="case-score">{data.active.scores.total}</span></div>
              {data.active.priorityRule && <p className="small">{data.active.priorityRule}</p>}
              <p className="muted small">Opened {relTime(data.active.createdAt)}, last update {relTime(data.active.lastEventAt)}</p>
              <button type="button" className="btn btn-secondary btn-sm" onClick={() => navigate(`/clinic?case=${data.active.id}`)}>Open in risk queue</button>
            </>
          )}
        </section>

        <section className="panel">
          <h2 className="panel-title">Latest check-in</h2>
          {!latest ? <p className="muted">No check-ins in the last 30 days.</p> : (
            <>
              <p><span className="big">{bp(latest.vitals)}</span> <SeverityBadge value={latest.severity} /></p>
              <p className="muted small">{[latest.vitals.heartRate && `${latest.vitals.heartRate} bpm`, latest.vitals.temperatureC && `${latest.vitals.temperatureC} °C`, latest.vitals.spo2 && `SpO₂ ${latest.vitals.spo2}%`].filter(Boolean).join(', ')}</p>
              <p className="muted small" title={dateTime(latest.recordedAt)}>{relTime(latest.recordedAt)}{latest.medication.taken === false ? ', medicines missed' : ''}</p>
            </>
          )}
        </section>
      </div>

      <div className="layout-split">
        <section className="panel">
          <h2 className="panel-title">Blood pressure, last 30 days</h2>
          <TrendChart points={chrono} unit="mmHg" band={[90, 140]} label="Blood pressure trend"
            series={[{ key: 'sys', label: 'Top number', className: 's-primary' }, { key: 'dia', label: 'Bottom number', className: 's-secondary' }]} />
          <h3>Recent check-ins</h3>
          {data.history.checkins.length === 0 ? <p className="muted small">None yet.</p> : (
            <table className="table">
              <thead><tr><th>When</th><th>BP</th><th>HR</th><th>Status</th></tr></thead>
              <tbody>{data.history.checkins.slice(0, 8).map((c) => (
                <tr key={c.id}><td title={dateTime(c.recordedAt)}>{relTime(c.recordedAt)}</td><td>{bp(c.vitals)}</td><td>{c.vitals.heartRate ?? '–'}</td><td><SeverityBadge value={c.severity} /></td></tr>
              ))}</tbody>
            </table>
          )}
        </section>
        <Medications patientId={p.id} canEdit={canEdit} />
      </div>

      <div className="layout-split">
        <section className="panel">
          <h2 className="panel-title">Visits</h2>
          {data.visits.length === 0 ? <Empty title="No visits yet">Schedule one from the patient's case in the risk queue.</Empty>
            : data.visits.map((v) => <VisitCard key={v.id} visit={v} canAct={canEdit} onChanged={load} />)}
        </section>
        <CareTeam patientId={p.id} canEdit={canEdit} />
      </div>

      <div className="layout-split">
        <section className="panel">
          <h2 className="panel-title">Care plan – caregiver duties</h2>
          <CarePlanEditor patientId={p.id} readOnly={!canEdit} />
        </section>
        <section className="panel">
          <h2 className="panel-title">Duties today</h2>
          <CareToday patientId={p.id} compact />
        </section>
      </div>

      <div className="layout-split">
        <section className="panel">
          <h2 className="panel-title">Resolved cases</h2>
          {data.cases.length === 0 ? <p className="muted">No resolved cases.</p> : (
            <ul className="plain-list">{data.cases.map((c) => (
              <li key={c.id}><span><strong>{STATUS_LABEL[c.status]}</strong> {relTime(c.resolvedAt)}{c.resolutionNotes ? `: ${c.resolutionNotes}` : ''}</span><PriorityTag value={c.priority} /></li>
            ))}</ul>
          )}
        </section>
        <section className="panel">
          <h2 className="panel-title">Health center records</h2>
          <EmrPanel state={data.emr} />
        </section>
      </div>
    </>
  );
}

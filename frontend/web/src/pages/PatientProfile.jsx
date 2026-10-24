import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';
import { PriorityTag, SeverityBadge, Empty, ErrorNote, Loading } from '../components/ui';
import TrendChart from '../components/TrendChart';
import { VisitCard } from '../components/visits';
import { EmrPanel } from './ClinicQueue';
import { CarePlanEditor, CareToday } from '../components/care';
import { bp, relTime, dateTime, ROLE_LABEL, STATUS_LABEL } from '../format';

// Nothing is filled in for the nurse: name, strength, schedule and times come from the prescription.
const BLANK_MED = { name: '', strength: '', dose: '', route: 'oral', frequency: '', times: '', foodInstructions: '', instructions: '',
  sourceType: 'physician_order', prescriber: '', facility: '', reference: '', sourceDate: '', verifyMethod: '', missedDose: '', changeReason: '' };
const RX_SOURCE = { physician_order: "Physician's order", partner_clinic: 'Partner clinic', hospital_discharge: 'Hospital discharge', prescription_document: 'Prescription document' };
const ROUTES = ['oral', 'sublingual', 'inhaled', 'topical', 'eye', 'ear', 'nasal', 'injection', 'patch', 'other'];
const today = () => new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Manila' }).format(new Date());
function medBody(f) {
  const source = { type: f.sourceType, prescriber: f.prescriber.trim(), ...(f.facility ? { facility: f.facility.trim() } : {}), ...(f.reference ? { reference: f.reference.trim() } : {}), ...(f.sourceDate ? { date: f.sourceDate } : {}) };
  return {
    name: f.name.trim(), strength: f.strength.trim(), ...(f.dose ? { dose: f.dose.trim() } : {}), route: f.route, frequency: f.frequency.trim(),
    times: f.times.split(/[,\s]+/).filter(Boolean), ...(f.foodInstructions ? { foodInstructions: f.foodInstructions.trim() } : {}), ...(f.instructions ? { instructions: f.instructions.trim() } : {}),
    source, ...(f.verifyMethod ? { verification: { method: f.verifyMethod, verifiedOn: today() } } : {}),
    ...(f.missedDose ? { missedDoseInstructions: f.missedDose.trim(), missedDoseSource: source } : {}),
    ...(f.changeReason ? { changeReason: f.changeReason.trim() } : {}),
  };
}

const BLANK_CONTACT = { name: '', relation: 'family', phone: '', userId: '' };

function Section({ title, action, children }) {
  return (
    <section className="panel">
      <div className="panel-head"><h2 className="panel-title">{title}</h2>{action}</div>
      {children}
    </section>
  );
}

export function Medications({ patientId, canEdit }) {
  const toast = useToast();
  const [data, setData] = useState(null);
  const [form, setForm] = useState(null); // {mode:'add'|'revise'|'stop', med?}
  const [errors, setErrors] = useState(null);

  const load = useCallback(() => api(`/api/patients/${patientId}/medications?includeInactive=true`).then(setData).catch((e) => setData({ error: e.message })), [patientId]);
  useEffect(() => { load(); }, [load]);
  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function submit(e) {
    e.preventDefault();
    setErrors(null);
    try {
      if (form.mode === 'add') await api(`/api/patients/${patientId}/medications`, { method: 'POST', body: medBody(form) });
      else if (form.mode === 'revise') await api(`/api/patients/${patientId}/medications/${form.med.id}/revisions`, { method: 'POST', body: medBody(form) });
      else await api(`/api/patients/${patientId}/medications/${form.med.id}/stop`, { method: 'POST', body: { reason: form.changeReason, source: medBody(form).source } });
      toast({ tone: 'success', title: form.mode === 'add' ? `${form.name} recorded` : form.mode === 'revise' ? `${form.name} changed (the old record is kept)` : `${form.med.name} stopped` });
      setForm(null);
      load();
    } catch (err) { setErrors(err.details || [err.message]); }
  }

  const meds = data && data.medications ? data.medications : [];
  const inUse = meds.filter((m) => m.active);
  const past = meds.filter((m) => !m.active);
  const open = (mode, m) => { setErrors(null); setForm(m ? { ...BLANK_MED, mode, med: m, name: m.name, strength: m.strength || m.dosage || '', dose: m.dose || '', route: m.route || 'oral', frequency: m.frequency, times: m.times.join(', '), foodInstructions: m.foodInstructions || '', instructions: m.instructions || '' } : { ...BLANK_MED, mode }); };
  return (
    <Section title="Prescribed medicines" action={canEdit && !form && <button type="button" className="btn btn-secondary btn-sm" onClick={() => open('add')}>Add medicine</button>}>
      <p className="muted small">Recorded from the prescriber's order. A change is a new record; the old one is kept. The app never suggests a dose, time or stop.</p>
      {!data && <Loading />}
      {data && data.error && <p className="muted">{data.error}</p>}
      {data && data.medications && inUse.length === 0 && <p className="muted">No medicines prescribed.</p>}
      {inUse.length > 0 && (
        <table className="table">
          <thead><tr><th>Medicine</th><th>Schedule</th><th>Source</th><th /></tr></thead>
          <tbody>
            {inUse.map((m) => (
              <tr key={m.id}>
                <td><strong>{m.name}</strong> {m.strength || m.dosage}{m.dose ? ` · ${m.dose}` : ''}{m.route ? ` · ${m.route}` : ''}
                  {(m.foodInstructions || m.instructions) && <><br /><span className="muted small">{[m.foodInstructions, m.instructions].filter(Boolean).join(' · ')}</span></>}
                  {m.missedDoseInstructions && <><br /><span className="small">Missed dose: {m.missedDoseInstructions}</span></>}</td>
                <td>{m.frequency}{m.times.length ? <><br /><span className="muted small">{m.times.join(', ')}</span></> : <><br /><span className="muted small">as needed / no set time</span></>}</td>
                <td className="small">{m.source ? <>{RX_SOURCE[m.source.type] || m.source.type}: {m.source.prescriber}{m.source.reference ? ` · ${m.source.reference}` : ''}</> : <span className="text-critical">Source not recorded</span>}
                  <br /><span className="muted">{m.verification ? `Verified ${m.verification.verifiedOn} (${m.verification.method.replace('_', ' ')})` : 'Not verified'}</span></td>
                <td>{canEdit && !form && <div className="btn-row"><button type="button" className="btn btn-quiet btn-sm" onClick={() => open('revise', m)}>Change</button><button type="button" className="btn btn-quiet btn-sm" onClick={() => open('stop', m)}>Stop</button></div>}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {past.length > 0 && (
        <details className="small"><summary>Stopped and earlier records ({past.length})</summary>
          <ul className="plain-list">{past.map((m) => <li key={m.id}><span><strong>{m.name}</strong> {m.strength || m.dosage} · {m.times.join(', ') || m.frequency} · {m.supersededById ? `changed (record ${m.supersededById})` : m.stopped ? `stopped: ${m.stopped.reason}` : 'ended'}{m.endDate ? ` · until ${m.endDate}` : ''}</span></li>)}</ul>
        </details>
      )}
      {form && (
        <form className="inline-form" onSubmit={submit} noValidate>
          <h3 className="duty-subhead">{form.mode === 'add' ? 'Record a prescription' : form.mode === 'revise' ? `Change ${form.med.name} (new record)` : `Stop ${form.med.name}`}</h3>
          {form.mode !== 'stop' && (
            <>
              <div className="form-grid">
                <label className="field"><span>Medicine</span><input value={form.name} onChange={set('name')} /></label>
                <label className="field"><span>Strength</span><input value={form.strength} onChange={set('strength')} placeholder="50 mg tablet" /></label>
                <label className="field"><span>Dose</span><input value={form.dose} onChange={set('dose')} placeholder="1 tablet" /></label>
                <label className="field"><span>Route</span><select value={form.route} onChange={set('route')}>{ROUTES.map((r) => <option key={r} value={r}>{r}</option>)}</select></label>
                <label className="field"><span>How often (as prescribed)</span><input value={form.frequency} onChange={set('frequency')} /></label>
                <label className="field"><span>Times (24-hour, comma separated)</span><input value={form.times} onChange={set('times')} placeholder="as on the prescription" /></label>
                <label className="field"><span>Food</span><input value={form.foodInstructions} onChange={set('foodInstructions')} placeholder="after meals" /></label>
                <label className="field"><span>Other instructions</span><input value={form.instructions} onChange={set('instructions')} /></label>
              </div>
              <label className="field"><span>If a dose is missed or refused (only if the prescriber said)</span><input value={form.missedDose} onChange={set('missedDose')} /></label>
            </>
          )}
          <div className="form-grid">
            <label className="field"><span>{form.mode === 'stop' ? 'Stop ordered by' : 'Source'}</span><select value={form.sourceType} onChange={set('sourceType')}>{Object.entries(RX_SOURCE).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="field"><span>Prescriber</span><input value={form.prescriber} onChange={set('prescriber')} placeholder="Dr. L. Reyes" /></label>
            <label className="field"><span>Facility</span><input value={form.facility} onChange={set('facility')} /></label>
            <label className="field"><span>Reference</span><input value={form.reference} onChange={set('reference')} placeholder="Rx no., discharge summary" /></label>
            <label className="field"><span>Date of the order</span><input type="date" value={form.sourceDate} onChange={set('sourceDate')} /></label>
            {form.mode !== 'stop' && <label className="field"><span>Checked against the source</span><select value={form.verifyMethod} onChange={set('verifyMethod')}><option value="">Not yet</option><option value="prescription_document">Prescription document</option><option value="written_order">Written order</option><option value="phone">By phone</option><option value="in_person">In person</option></select></label>}
          </div>
          {form.mode !== 'add' && <label className="field"><span>{form.mode === 'stop' ? 'Reason for stopping' : 'What changed and why'}</span><input value={form.changeReason} onChange={set('changeReason')} /></label>}
          {errors && <div className="note note-error"><ul>{errors.map((m) => <li key={m}>{m}</li>)}</ul></div>}
          <div className="btn-row"><button className="btn btn-primary btn-sm">{form.mode === 'add' ? 'Record' : form.mode === 'revise' ? 'Record the change' : 'Stop'}</button><button type="button" className="btn btn-quiet btn-sm" onClick={() => { setForm(null); setErrors(null); }}>Cancel</button></div>
        </form>
      )}
    </Section>
  );
}

export function CareTeam({ patientId, canEdit }) {
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

/**
 * The clinic records of one patient for the desktop console, shown beside the phone patient screen (which has
 * the summary, current case, reviews, care team and case actions): trends, medicines, visits, SMS contacts,
 * care plan, resolved cases and the legacy health-center record.
 */
export default function PatientRecords({ user, patientId }) {
  const canEdit = user.role === 'clinic_staff';
  const [data, setData] = useState(null);
  const [error, setError] = useState('');

  const load = useCallback(() => Promise.all([
    api(`/api/patients/${encodeURIComponent(patientId)}/history?days=30&limit=200`),
    api(`/api/clinic/queue/history?patientId=${encodeURIComponent(patientId)}&limit=20`),
    api(`/api/clinic/visits?patientId=${encodeURIComponent(patientId)}&view=all&limit=20`),
    api(`/api/clinic/patients/${encodeURIComponent(patientId)}/emr-history`).catch((e) => ({ error: e.status === 404 ? 'No record for this patient in the health center records system yet.' : e.message })),
  ]).then(([history, cases, visits, emr]) => {
    setData({ history, cases: cases.cases, visits: visits.visits, emr });
    setError('');
  }).catch((e) => setError(e.status === 404 ? `Patient ${patientId} was not found.` : e.message)), [patientId]);
  useEffect(() => { load(); }, [load]);

  if (error) return <ErrorNote error={error} onRetry={load} />;
  if (!data) return <Loading label="Loading clinic records" />;

  const p = data.history.patient;
  const chrono = [...data.history.checkins].reverse().map((c) => ({ t: c.recordedAt, sys: c.vitals.systolic, dia: c.vitals.diastolic, hr: c.vitals.heartRate, flag: ['high', 'critical'].includes(c.severity) }));

  return (
    <div className="ad-records">
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
      <section className="panel">
        <h2 className="panel-title">Visits</h2>
        {data.visits.length === 0 ? <Empty title="No visits yet">Schedule one from the case on the left.</Empty>
          : data.visits.map((v) => <VisitCard key={v.id} visit={v} canAct={canEdit} onChanged={load} />)}
      </section>
      <CareTeam patientId={p.id} canEdit={canEdit} />
      <section className="panel">
        <h2 className="panel-title">Care plan – caregiver duties</h2>
        <CarePlanEditor patientId={p.id} readOnly={!canEdit} />
      </section>
      <section className="panel">
        <h2 className="panel-title">Duties today</h2>
        <CareToday patientId={p.id} compact />
      </section>
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
  );
}

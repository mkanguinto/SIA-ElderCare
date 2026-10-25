// Nurse-led care plan (v3) on the desktop patient case: the version in use, the draft the nurse writes with the
// elder and the caregiver, the clinician's verification of instructions that need partner-clinic approval,
// activation (which supersedes the version in use), and the version history with every change.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { relTime } from '../format';
import Icon from '../mobile/icons';
import { Chip, manilaDay } from '../mobile/kit';
import { CarePlanEditor } from '../components/care';
import { SelectOther, listLabel } from '../components/ui';

const AREAS = { eating: 'Eating', meal_preparation: 'Meal preparation', fluids: 'Drinking', hygiene: 'Bathing / hygiene', oral_care: 'Oral care', dressing: 'Dressing',
  toileting: 'Toileting', mobility: 'Walking / mobility', transfers: 'Transfers (bed, chair)', communication: 'Communication', other: 'Other' };
const LEVELS = { independent: 'Independent', supervision: 'Supervision', some_help: 'Some help', full_help: 'Full help' };
const KINDS = { diet: 'Diet', fluids: 'Fluids', swallowing: 'Swallowing', skin_wound: 'Skin / wound care', restriction: 'Restriction', other: 'Other' };
const SPECIALISED = ['diet', 'fluids', 'swallowing', 'skin_wound'];
const SOURCES = { physician_order: "Physician's order", partner_clinic: 'Partner clinic', hospital_discharge: 'Hospital discharge', clinic_protocol: 'Clinic protocol', nurse_assessment: 'Nurse assessment' };
const METHODS = { in_person: 'In person', phone: 'By phone', written_order: 'Written order', referral_document: 'Referral document' };
const ACTION = { draft_created: 'Draft started', draft_updated: 'Draft edited', task_added: 'Task added', task_changed: 'Task changed', task_removed: 'Task removed',
  verified: 'Verified by a clinician', activated: 'Activated', superseded: 'Superseded', discarded: 'Draft discarded' };
const blankSource = { type: '', clinician: '', facility: '', reference: '', date: '' };
const clean = (o) => JSON.parse(JSON.stringify(o, (k, v) => (v === '' ? undefined : v)));
const sourceText = (s) => (s ? [listLabel(SOURCES, s.type, s.typeOther), s.clinician, s.facility, s.reference, s.date].filter(Boolean).join(' · ') : 'no source');

export default function CarePlanManager({ patientId, care }) {
  const [plan, setPlan] = useState(null);
  const [draft, setDraft] = useState(null);
  const [versions, setVersions] = useState(null);
  const [msg, setMsg] = useState(null);
  const load = useCallback(async () => {
    try {
      const p = await api(`/api/patients/${encodeURIComponent(patientId)}/care-plan`);
      setPlan(p);
      setDraft(p.draft ? await api(`/api/care-plan/versions/${p.draft.id}`) : null);
      setVersions(await api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/versions`).catch(() => null));
    } catch (e) { setPlan({ error: e.message }); }
  }, [patientId]);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, ok) => {
    setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); await load(); return true; } catch (e) { setMsg({ tone: 'critical', text: (e.details || [e.message]).join('. ') }); return false; }
  };

  if (!plan) return <section className="ad-panel"><p className="m-caption">Loading the care plan…</p></section>;
  if (plan.error) return <section className="ad-panel"><p className="m-error">{plan.error}</p></section>;
  const a = plan.active;
  return (
    <section className="ad-panel ad-span ad-plan">
      <div className="m-between">
        <h2>Care plan</h2>
        <div className="m-pills">
          {a ? <Chip tone="ok" icon="check">Version {a.version} in use</Chip> : <Chip tone="moderate" icon="alert">No plan in use</Chip>}
          {a && a.legacy && <Chip tone="moderate" icon="alert">Carried over, not yet reviewed</Chip>}
          {a && a.reviewDue && <Chip tone="high" icon="clock">Review due</Chip>}
          {draft && <Chip tone="info" icon="file">Draft version {draft.version}</Chip>}
        </div>
      </div>
      {msg && <p className={`m-banner tone-${msg.tone}`} role={msg.tone === 'critical' ? 'alert' : 'status'}>{msg.text}</p>}
      {a && <ActiveSummary v={a} />}
      {!draft && (
        <div className="ad-plan-start">
          <p className="m-muted">{a ? 'The plan in use does not change. Start a draft to write the next version; it takes effect when you activate it.' : 'Write the first plan with the elder and the caregiver.'}</p>
          <button type="button" className="m-btn is-brand ad-btn-auto" onClick={() => run(() => api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/drafts`, { method: 'POST', body: {} }), 'Draft started')}>
            <Icon name="plus" size={18} />{a ? `Start version ${(versions && versions.versions[0] ? versions.versions[0].version : a.version) + 1}` : 'Start the care plan'}</button>
        </div>
      )}
      {draft && <DraftEditor key={draft.id} draft={draft} care={care} run={run} patientId={patientId} reload={load} />}
      {!draft && a && <><h3 className="ad-label">Tasks in version {a.version}</h3><CarePlanEditor patientId={patientId} /></>}
      {versions && <History versions={versions} />}
    </section>
  );
}

function ActiveSummary({ v }) {
  const c = v.content || {};
  return (
    <div className="ad-plan-summary">
      <dl className="ad-facts">
        <div><dt>Effective</dt><dd>{v.effectiveDate || '—'}</dd><span className="m-sub">review by {v.reviewDate || '—'}</span></div>
        <div><dt>Responsible nurse</dt><dd>{v.responsibleNurseName || '—'}</dd><span className="m-sub">activated {v.activatedAt ? relTime(v.activatedAt) : '—'}</span></div>
        <div><dt>Verified by</dt><dd>{v.verification ? v.verification.clinicianName : v.legacy ? 'Not verified' : '—'}</dd>{v.verification && <span className="m-sub">{v.verification.clinicianRole} · {listLabel(METHODS, v.verification.method, v.verification.methodOther)} · {v.verification.verifiedOn}</span>}</div>
        <div><dt>Allergies</dt><dd>{!c.allergies ? 'Not recorded' : c.allergies.status === 'listed' ? c.allergies.items.map((i) => i.substance).join(', ') : c.allergies.status === 'none_known' ? 'None known' : 'Not assessed'}</dd></div>
      </dl>
      {(c.goals || c.preferences) && <p className="ad-plan-text"><strong>Goals:</strong> {c.goals || '—'}{c.preferences ? <><br /><strong>Preferences:</strong> {c.preferences}</> : null}</p>}
      {(c.clinicalInstructions || []).length > 0 && (
        <ul className="ad-instructions">{c.clinicalInstructions.map((ci, i) => <li key={i}><Chip tone={ci.partnerApproval === 'required' ? 'info' : ''} icon="file">{KINDS[ci.kind]}</Chip> {ci.text}<span className="m-sub">{sourceText(ci.source)}{ci.partnerApproval === 'required' ? ' · partner-clinic approval' : ''}</span></li>)}</ul>
      )}
      {c.contact && <p className="ad-plan-text"><strong>Clinic:</strong> {[c.contact.clinicName, c.contact.phone, c.contact.monitoringHours].filter(Boolean).join(' · ')}{c.contact.emergency ? <><br /><strong>Emergency:</strong> {c.contact.emergency.text}</> : null}</p>}
    </div>
  );
}

function DraftEditor({ draft, care, run, patientId, reload }) {
  const c = draft.content || {};
  const [f, setF] = useState(() => ({
    goals: c.goals || '', preferences: c.preferences || '', notes: c.notes || '',
    assistanceNeeds: c.assistanceNeeds || [],
    allergyStatus: c.allergies ? c.allergies.status : '', allergies: c.allergies ? c.allergies.items : [],
    clinicalInstructions: (c.clinicalInstructions || []).map((x) => ({ ...x, source: { ...blankSource, ...x.source } })),
    responsibilities: (c.caregiver && c.caregiver.responsibilities) || '', training: (c.caregiver && c.caregiver.trainingAndCapacity) || '', notFor: (c.caregiver && c.caregiver.notForCaregiver) || '',
    followUp: (c.monitoring && c.monitoring.followUp) || '',
    clinicName: (c.contact && c.contact.clinicName) || '', phone: (c.contact && c.contact.phone) || '', hours: (c.contact && c.contact.monitoringHours) || '',
    afterHours: (c.contact && c.contact.afterHours && c.contact.afterHours.text) || '', afterHoursSource: { ...blankSource, ...(c.contact && c.contact.afterHours && c.contact.afterHours.source) },
    emergency: (c.contact && c.contact.emergency && c.contact.emergency.text) || '', emergencySource: { ...blankSource, ...(c.contact && c.contact.emergency && c.contact.emergency.source) },
    responsibleNurseId: draft.responsibleNurseId || '', elderInvolved: draft.elderInvolved, caregiverInvolved: draft.caregiverInvolved, involvementNote: draft.involvementNote || '',
    effectiveDate: draft.effectiveDate || manilaDay(), reviewDate: draft.reviewDate || '', changeSummary: draft.changeSummary || '',
  }));
  const set = (k) => (e) => setF({ ...f, [k]: e.target.type === 'checkbox' ? e.target.checked : e.target.value });
  const members = (care && !care.error && care.members) || [];

  function body() {
    return clean({
      content: {
        goals: f.goals, preferences: f.preferences, notes: f.notes || null,
        assistanceNeeds: f.assistanceNeeds.filter((n) => n.area && n.level),
        ...(f.allergyStatus ? { allergies: { status: f.allergyStatus, items: f.allergyStatus === 'listed' ? f.allergies.filter((x) => x.substance) : [] } } : {}),
        clinicalInstructions: f.clinicalInstructions.map((x) => ({ kind: x.kind, text: x.text, source: clean(x.source), partnerApproval: SPECIALISED.includes(x.kind) ? 'required' : x.partnerApproval || 'required' })),
        caregiver: { responsibilities: f.responsibilities, trainingAndCapacity: f.training, notForCaregiver: f.notFor },
        monitoring: { followUp: f.followUp },
        contact: {
          clinicName: f.clinicName, phone: f.phone, monitoringHours: f.hours,
          ...(f.afterHours ? { afterHours: { text: f.afterHours, source: clean(f.afterHoursSource) } } : {}),
          ...(f.emergency ? { emergency: { text: f.emergency, source: clean(f.emergencySource) } } : {}),
        },
      },
      ...(f.responsibleNurseId ? { responsibleNurseId: f.responsibleNurseId } : {}),
      ...(typeof f.elderInvolved === 'boolean' ? { elderInvolved: f.elderInvolved } : {}),
      ...(typeof f.caregiverInvolved === 'boolean' ? { caregiverInvolved: f.caregiverInvolved } : {}),
      involvementNote: f.involvementNote || null, effectiveDate: f.effectiveDate || null, reviewDate: f.reviewDate || null, changeSummary: f.changeSummary || null,
    });
  }
  const save = () => run(() => api(`/api/care-plan/versions/${draft.id}`, { method: 'PATCH', body: body() }), 'Draft saved');
  const list = (k, i, v) => setF({ ...f, [k]: f[k].map((x, j) => (j === i ? { ...x, ...v } : x)) });

  return (
    <div className="ad-draft">
      <p className="m-banner tone-info"><Icon name="file" />Draft version {draft.version}. Caregivers keep following the plan in use until you activate this draft. Saved {relTime(draft.updatedAt)}.</p>
      <div className="ad-form-grid is-2">
        <label className="ad-field"><span>Care goals</span><textarea rows="2" value={f.goals} onChange={set('goals')} maxLength={2000} /></label>
        <label className="ad-field"><span>The elder's preferences</span><textarea rows="2" value={f.preferences} onChange={set('preferences')} maxLength={2000} placeholder="Routines, food they like, language, who they trust" /></label>
      </div>

      <h3 className="ad-label">Assistance needs</h3>
      {f.assistanceNeeds.map((n, i) => (
        <div key={i} className="ad-form-row">
          <label className="ad-field"><span>Area</span><SelectOther label="Area" value={n.area} onChange={(area) => list('assistanceNeeds', i, { area })} other={n.areaOther} onOther={(areaOther) => list('assistanceNeeds', i, { areaOther })} options={Object.entries(AREAS)} placeholder="Choose" /></label>
          <label className="ad-field"><span>Help needed</span><SelectOther label="Help needed" value={n.level} onChange={(level) => list('assistanceNeeds', i, { level })} other={n.levelOther} onOther={(levelOther) => list('assistanceNeeds', i, { levelOther })} options={Object.entries(LEVELS)} placeholder="Choose" /></label>
          <label className="ad-field"><span>Details</span><input value={n.details || ''} onChange={(e) => list('assistanceNeeds', i, { details: e.target.value })} maxLength={500} /></label>
          <button type="button" className="m-link" onClick={() => setF({ ...f, assistanceNeeds: f.assistanceNeeds.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      <button type="button" className="m-link ad-add" onClick={() => setF({ ...f, assistanceNeeds: [...f.assistanceNeeds, { area: '', level: '' }] })}>+ Add a need</button>

      <h3 className="ad-label">Allergies</h3>
      <div className="m-seg ad-seg" role="group" aria-label="Allergies">
        {[['none_known', 'None known'], ['listed', 'Has allergies'], ['not_assessed', 'Not assessed yet']].map(([k, l]) => <button key={k} type="button" aria-pressed={f.allergyStatus === k} onClick={() => setF({ ...f, allergyStatus: k, allergies: k === 'listed' && !f.allergies.length ? [{ substance: '' }] : f.allergies })}>{l}</button>)}
      </div>
      {f.allergyStatus === 'listed' && f.allergies.map((x, i) => (
        <div key={i} className="ad-form-row">
          <label className="ad-field"><span>Substance</span><input value={x.substance || ''} onChange={(e) => list('allergies', i, { substance: e.target.value })} /></label>
          <label className="ad-field"><span>Reaction</span><input value={x.reaction || ''} onChange={(e) => list('allergies', i, { reaction: e.target.value })} /></label>
          <label className="ad-field"><span>Recorded where</span><input value={x.source || ''} onChange={(e) => list('allergies', i, { source: e.target.value })} placeholder="RHU record, hospital discharge" /></label>
          <button type="button" className="m-link" onClick={() => setF({ ...f, allergies: f.allergies.filter((_, j) => j !== i) })}>Remove</button>
        </div>
      ))}
      {f.allergyStatus === 'listed' && <button type="button" className="m-link ad-add" onClick={() => setF({ ...f, allergies: [...f.allergies, { substance: '' }] })}>+ Add an allergy</button>}

      <h3 className="ad-label">Clinical instructions and restrictions</h3>
      <p className="m-caption">Diet, fluids, swallowing and skin / wound instructions need a clinical source and the partner clinic's approval. The app suggests none of them.</p>
      {f.clinicalInstructions.map((x, i) => (
        <div key={i} className="ad-instruction-edit">
          <div className="ad-form-row">
            <label className="ad-field is-narrow"><span>Kind</span><select value={x.kind} onChange={(e) => list('clinicalInstructions', i, { kind: e.target.value })}>{Object.entries(KINDS).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
            <label className="ad-field"><span>Instruction (as given by the source)</span><input value={x.text} onChange={(e) => list('clinicalInstructions', i, { text: e.target.value })} maxLength={1000} /></label>
            <button type="button" className="m-link" onClick={() => setF({ ...f, clinicalInstructions: f.clinicalInstructions.filter((_, j) => j !== i) })}>Remove</button>
          </div>
          <SourceFields value={x.source} onChange={(s) => list('clinicalInstructions', i, { source: s })} clinicalOnly={SPECIALISED.includes(x.kind)} />
          {!SPECIALISED.includes(x.kind) && <label className="check"><input type="checkbox" checked={x.partnerApproval !== 'not_required'} onChange={(e) => list('clinicalInstructions', i, { partnerApproval: e.target.checked ? 'required' : 'not_required' })} /> Needs partner-clinic approval</label>}
        </div>
      ))}
      <button type="button" className="m-link ad-add" onClick={() => setF({ ...f, clinicalInstructions: [...f.clinicalInstructions, { kind: 'diet', text: '', source: { ...blankSource }, partnerApproval: 'required' }] })}>+ Add an instruction</button>

      <h3 className="ad-label">Caregiver</h3>
      <div className="ad-form-grid">
        <label className="ad-field"><span>Responsibilities</span><textarea rows="2" value={f.responsibilities} onChange={set('responsibilities')} /></label>
        <label className="ad-field"><span>Training and capacity</span><textarea rows="2" value={f.training} onChange={set('training')} placeholder="What they were shown and can do safely" /></label>
        <label className="ad-field"><span>Not for the caregiver</span><textarea rows="2" value={f.notFor} onChange={set('notFor')} placeholder="Tasks only a nurse does" /></label>
      </div>

      <h3 className="ad-label">Monitoring, contact and emergencies</h3>
      <div className="ad-form-grid">
        <label className="ad-field"><span>Follow-up arrangements</span><input value={f.followUp} onChange={set('followUp')} placeholder="Nurse visit every 2 weeks" /></label>
        <label className="ad-field"><span>Clinic</span><input value={f.clinicName} onChange={set('clinicName')} /></label>
        <label className="ad-field"><span>Clinic phone</span><input value={f.phone} onChange={set('phone')} inputMode="tel" /></label>
        <label className="ad-field"><span>Monitoring hours</span><input value={f.hours} onChange={set('hours')} placeholder="Mon-Sat 8 AM-5 PM" /></label>
      </div>
      <div className="ad-form-grid is-2">
        <div><label className="ad-field"><span>After-hours instructions (approved)</span><textarea rows="2" value={f.afterHours} onChange={set('afterHours')} /></label><SourceFields value={f.afterHoursSource} onChange={(s) => setF({ ...f, afterHoursSource: s })} clinicalOnly /></div>
        <div><label className="ad-field"><span>Emergency instructions (approved)</span><textarea rows="2" value={f.emergency} onChange={set('emergency')} /></label><SourceFields value={f.emergencySource} onChange={(s) => setF({ ...f, emergencySource: s })} clinicalOnly /></div>
      </div>

      <h3 className="ad-label">Who, when</h3>
      <div className="ad-form-grid">
        <label className="ad-field"><span>Responsible nurse</span><select value={f.responsibleNurseId} onChange={set('responsibleNurseId')}><option value="">Choose</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
        <label className="ad-field"><span>Effective date</span><input type="date" value={f.effectiveDate} onChange={set('effectiveDate')} /></label>
        <label className="ad-field"><span>Review date</span><input type="date" value={f.reviewDate} onChange={set('reviewDate')} /></label>
      </div>
      <div className="ad-checks">
        <label className="check"><input type="checkbox" checked={f.elderInvolved === true} onChange={(e) => setF({ ...f, elderInvolved: e.target.checked })} /> Planned with the elder</label>
        <label className="check"><input type="checkbox" checked={f.caregiverInvolved === true} onChange={(e) => setF({ ...f, caregiverInvolved: e.target.checked })} /> Planned with the caregiver</label>
      </div>
      {(f.elderInvolved !== true || f.caregiverInvolved !== true) && <label className="ad-field"><span>If not, why</span><input value={f.involvementNote} onChange={set('involvementNote')} maxLength={500} /></label>}
      <label className="ad-field"><span>What changed in this version</span><input value={f.changeSummary} onChange={set('changeSummary')} maxLength={500} /></label>
      <div className="ad-actions"><button type="button" className="m-btn is-dark ad-btn-auto" onClick={save}>Save the draft</button></div>

      <h3 className="ad-label">Tasks in this draft</h3>
      <CarePlanEditor patientId={patientId} versionId={draft.id} onChanged={reload} />

      <Verify draft={draft} run={run} />
      <Activate draft={draft} run={run} />
    </div>
  );
}

function SourceFields({ value, onChange, clinicalOnly }) {
  const s = value || blankSource;
  const set = (k) => (e) => onChange({ ...s, [k]: e.target.value });
  return (
    <div className="ad-form-row ad-source">
      <label className="ad-field is-narrow"><span>Source</span><SelectOther label="Source" value={s.type} onChange={(type) => onChange({ ...s, type })} other={s.typeOther} onOther={(typeOther) => onChange({ ...s, typeOther })} options={Object.entries(SOURCES).filter(([k]) => !clinicalOnly || k !== 'nurse_assessment')} placeholder="Choose" /></label>
      <label className="ad-field"><span>Clinician</span><input value={s.clinician} onChange={set('clinician')} /></label>
      <label className="ad-field"><span>Facility</span><input value={s.facility} onChange={set('facility')} /></label>
      <label className="ad-field"><span>Reference</span><input value={s.reference} onChange={set('reference')} placeholder="Order no., protocol" /></label>
      <label className="ad-field is-narrow"><span>Date</span><input type="date" value={s.date} onChange={set('date')} /></label>
    </div>
  );
}

function Verify({ draft, run }) {
  const items = draft.needsApproval || [];
  const [v, setV] = useState({ clinicianName: '', clinicianRole: '', facility: '', method: '', reference: '', verifiedOn: manilaDay() });
  const set = (k) => (e) => setV({ ...v, [k]: e.target.value });
  if (!items.length) return null;
  return (
    <div className="ad-verify">
      <h3 className="ad-label">Partner-clinic approval</h3>
      <ul className="ad-instructions">{items.map((it, i) => <li key={i}><strong>{KINDS[it.kind] || (it.kind === 'afterHours' ? 'After hours' : it.kind === 'emergency' ? 'Emergency' : it.kind)}:</strong> {it.text}</li>)}</ul>
      {draft.verification ? (
        <p className="m-banner tone-ok"><Icon name="checkCircle" />Verified by {draft.verification.clinicianName} ({draft.verification.clinicianRole}), {listLabel(METHODS, draft.verification.method, draft.verification.methodOther)}, {draft.verification.verifiedOn}. Changing one of these instructions clears it.</p>
      ) : (
        <>
          <div className="ad-form-grid">
            <label className="ad-field"><span>Clinician</span><input value={v.clinicianName} onChange={set('clinicianName')} placeholder="Dr. L. Reyes" /></label>
            <label className="ad-field"><span>Role</span><input value={v.clinicianRole} onChange={set('clinicianRole')} placeholder="Physician, partner-clinic nurse" /></label>
            <label className="ad-field"><span>Facility</span><input value={v.facility} onChange={set('facility')} /></label>
            <label className="ad-field"><span>How</span><SelectOther label="How" value={v.method} onChange={(method) => setV({ ...v, method })} other={v.methodOther} onOther={(methodOther) => setV({ ...v, methodOther })} options={Object.entries(METHODS)} placeholder="Choose" /></label>
            <label className="ad-field"><span>Reference</span><input value={v.reference} onChange={set('reference')} /></label>
            <label className="ad-field"><span>Verified on</span><input type="date" value={v.verifiedOn} onChange={set('verifiedOn')} /></label>
          </div>
          <button type="button" className="m-btn ad-btn-auto" onClick={() => run(() => api(`/api/care-plan/versions/${draft.id}/verification`, { method: 'POST', body: clean(v) }), 'Verification recorded')}>Record the verification</button>
        </>
      )}
    </div>
  );
}

function Activate({ draft, run }) {
  const problems = draft.problems || [];
  const [reason, setReason] = useState('');
  return (
    <div className="ad-activate">
      <h3 className="ad-label">Activate</h3>
      {problems.length ? (
        <div className="m-banner tone-moderate" style={{ display: 'block' }}><strong>Before this draft can be used:</strong><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>
      ) : <p className="m-banner tone-ok"><Icon name="check" />Ready. Activating makes this the plan the caregiver follows; the version in use is kept as superseded.</p>}
      <div className="ad-actions">
        <button type="button" className="m-btn is-brand ad-btn-auto" disabled={problems.length > 0} onClick={() => window.confirm(`Activate version ${draft.version}? The caregiver will follow it from now on.`) && run(() => api(`/api/care-plan/versions/${draft.id}/activate`, { method: 'POST', body: {} }), `Version ${draft.version} is now in use`)}>Activate version {draft.version}</button>
        <input className="ad-select" value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason to discard the draft" aria-label="Reason to discard the draft" />
        <button type="button" className="m-link" disabled={reason.trim().length < 3} onClick={() => run(() => api(`/api/care-plan/versions/${draft.id}/discard`, { method: 'POST', body: { reason } }), 'Draft discarded (kept in the history)')}>Discard the draft</button>
      </div>
    </div>
  );
}

function History({ versions }) {
  const [open, setOpen] = useState(false);
  return (
    <details className="ad-history" open={open} onToggle={(e) => setOpen(e.target.open)}>
      <summary>Versions and change history ({versions.versions.length} version{versions.versions.length === 1 ? '' : 's'})</summary>
      <table className="ad-table is-boxed">
        <thead><tr><th>Version</th><th>Status</th><th>Effective</th><th>Change</th><th>Verified</th></tr></thead>
        <tbody>{versions.versions.map((v) => (
          <tr key={v.id}><td>v{v.version}</td><td><Chip tone={v.status === 'active' ? 'ok' : v.status === 'draft' ? 'info' : ''}>{v.status}</Chip></td><td>{v.effectiveDate || '—'}</td>
            <td>{v.changeSummary || '—'}{v.legacy ? ' (carried over)' : ''}</td><td>{v.verified ? 'Yes' : 'No'}</td></tr>
        ))}</tbody>
      </table>
      <ul className="ad-log">
        {versions.history.slice(0, 40).map((h) => <li key={h.id}><span>{relTime(h.at)}</span> {ACTION[h.action] || h.action}{h.details && h.details.title ? `: ${h.details.title}` : ''}{h.details && h.details.reason ? ` (${h.details.reason})` : ''} <span className="m-sub">{h.actorId}</span></li>)}
      </ul>
    </details>
  );
}

// The clinical part of an elder's profile, recorded by a nurse after the admin registers the elder: health
// conditions and limited mobility. Both feed the risk score from the next check-in on.
import React, { useState } from 'react';
import { api } from '../api';
import { conditionLabel } from '../format';
import Icon from '../mobile/icons';
import { Chip } from '../mobile/kit';

export const CONDITIONS = [
  ['hypertension', 'High blood pressure'],
  ['diabetes', 'Diabetes'],
  ['cardiovascular', 'Heart disease'],
  ['copd', 'Lung disease (COPD)'],
];
const slug = (t) => t.trim().toLowerCase().replace(/[\s-]+/g, '_');

/** className: 'ad-panel' on the computer, 'm-card' on the phone. */
export function HealthCard({ patient, canEdit, onSaved, className = 'ad-panel' }) {
  const [form, setForm] = useState(null); // {conditions, mobility, other}
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const conditions = patient.conditions || [];
  const open = () => { setError(''); setForm({ conditions: [...conditions], mobility: Boolean(patient.mobilityRestricted), other: '' }); };
  const toggle = (c) => setForm({ ...form, conditions: form.conditions.includes(c) ? form.conditions.filter((x) => x !== c) : [...form.conditions, c] });
  const addOther = () => {
    const c = slug(form.other);
    if (c.length >= 2 && !form.conditions.includes(c)) setForm({ ...form, conditions: [...form.conditions, c], other: '' });
  };

  async function save() {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/patients/${encodeURIComponent(patient.id)}/health`, { method: 'PATCH', body: { conditions: form.conditions, mobilityRestricted: form.mobility } });
      setForm(null);
      if (onSaved) onSaved(r.patient);
    } catch (e) { setError((e.details || [e.message]).join('. ')); } finally { setBusy(false); }
  }

  return (
    <section className={`${className} health-card`}>
      <div className="m-between">
        <h2 className={className === 'm-card' ? 'm-card-title' : undefined} style={{ marginBottom: 0 }}>Health conditions</h2>
        {canEdit && !form && <button type="button" className="m-link" onClick={open}>{conditions.length || patient.mobilityRestricted ? 'Edit' : 'Record'}</button>}
      </div>
      {!form && (
        <div className="m-pills" style={{ marginTop: '.75rem' }}>
          {conditions.map((c) => <Chip key={c} icon="heartPulse">{conditionLabel(c)}</Chip>)}
          {patient.mobilityRestricted && <Chip tone="moderate" icon="alert">Limited mobility</Chip>}
          {!conditions.length && !patient.mobilityRestricted && <span className="m-muted">None recorded yet. They count toward the risk score.</span>}
        </div>
      )}
      {form && (
        <div style={{ marginTop: '.75rem' }}>
          <div className="m-pills" role="group" aria-label="Health conditions">
            {[...CONDITIONS, ...form.conditions.filter((c) => !CONDITIONS.some(([k]) => k === c)).map((c) => [c, conditionLabel(c)])].map(([k, l]) => (
              <button key={k} type="button" className="m-pill" aria-pressed={form.conditions.includes(k)} onClick={() => toggle(k)}>{form.conditions.includes(k) && <Icon name="check" size={16} />}{l}</button>
            ))}
            <button type="button" className="m-pill" aria-pressed={form.mobility} onClick={() => setForm({ ...form, mobility: !form.mobility })}>{form.mobility && <Icon name="check" size={16} />}Limited mobility</button>
          </div>
          <div className="health-other">
            <input value={form.other} onChange={(e) => setForm({ ...form, other: e.target.value })} maxLength={40} placeholder="Other condition (type it)" aria-label="Other condition"
              onKeyDown={(e) => { if (e.key === 'Enter') { e.preventDefault(); addOther(); } }} />
            <button type="button" className="m-link" onClick={addOther} disabled={slug(form.other).length < 2}>Add</button>
          </div>
          {error && <p className="m-error" role="alert">{error}</p>}
          <div className="health-actions">
            <button type="button" className="m-btn is-dark ad-btn-auto" disabled={busy} onClick={save}>{busy ? 'Saving…' : 'Save'}</button>
            <button type="button" className="m-link" onClick={() => setForm(null)}>Cancel</button>
          </div>
        </div>
      )}
    </section>
  );
}

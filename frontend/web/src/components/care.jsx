// Care plan (Batch 4) building blocks shared by the caregiver, family and clinic screens.
import React, { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';
import { Empty, Loading, ErrorNote, SelectOther, listLabel } from './ui';
import { DUTY_CATEGORY_LABEL, DUTY_STATUS_LABEL, FREQUENCY_LABEL, WEEKDAY_SHORT, dutySchedule, relTime, dateTime } from '../format';

const slotLabel = (slot) => (slot === 'any' ? 'Any time' : slot);

/**
 * One day's duties. With `onChanged` the caregiver can tick off, skip (with a reason) and log as-needed
 * duties; without it the list is read-only (family, clinic).
 */
export function DutyChecklist({ checklist, onChanged }) {
  const toast = useToast();
  const [busy, setBusy] = useState(null);
  const [skipping, setSkipping] = useState(null);
  const [reason, setReason] = useState('');
  const editable = Boolean(onChanged);
  const isToday = checklist.date === checklist.today;

  async function complete(item, status, note) {
    const key = `${item.taskId}|${item.slot || 'log'}`;
    setBusy(key);
    try {
      await api(`/api/care/tasks/${item.taskId}/completions`, {
        method: 'POST',
        body: { date: checklist.date, ...(item.slot ? { slot: item.slot } : {}), status, ...(note ? { note } : {}) },
      });
      setSkipping(null);
      setReason('');
      toast({ title: status === 'skipped' ? `Marked “${item.title}” as skipped` : `“${item.title}” done`, tone: status === 'skipped' ? 'warning' : 'success' });
      onChanged();
    } catch (e) {
      toast({ title: e.message, tone: 'error' });
    } finally {
      setBusy(null);
    }
  }

  const { summary } = checklist;
  return (
    <>
      <dl className="stats stats-inline">
        <div><dt>Done</dt><dd>{summary.done} / {summary.total}</dd></div>
        <div><dt>{isToday ? 'Overdue' : 'Missed'}</dt><dd className={summary.overdue + summary.missed ? 'text-high' : ''}>{summary.overdue + summary.missed}</dd></div>
        <div><dt>Skipped</dt><dd>{summary.skipped}</dd></div>
      </dl>
      {checklist.items.length === 0 && <Empty title="Nothing scheduled">No duties are planned for this day.</Empty>}
      <ul className="duty-list">
        {checklist.items.map((item) => {
          const key = `${item.taskId}|${item.slot}`;
          const canAct = editable && ['pending', 'overdue', 'missed', 'skipped'].includes(item.status);
          return (
            <li key={key} className={`duty duty-${item.status}`}>
              <span className="duty-time">{slotLabel(item.slot)}</span>
              <div className="duty-main">
                <strong>{item.title}</strong>
                <span className="muted small">
                  {DUTY_CATEGORY_LABEL[item.category]}
                  {item.carriedOver && ` · was due ${item.dueDate}`}
                </span>
                {item.instructions && <span className="small">{item.instructions}</span>}
                {item.completion && (
                  <span className="muted small" title={dateTime(item.completion.completedAt)}>
                    {DUTY_STATUS_LABEL[item.completion.status]} {relTime(item.completion.completedAt)}{item.completion.note ? ` – ${item.completion.note}` : ''}
                  </span>
                )}
                {skipping === key && (
                  <form className="duty-skip" onSubmit={(e) => { e.preventDefault(); complete(item, 'skipped', reason.trim()); }}>
                    <label className="field">
                      <span>Why was it skipped?</span>
                      <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required autoFocus placeholder="e.g. patient was asleep" />
                    </label>
                    <div className="btn-row">
                      <button className="btn btn-secondary btn-sm" disabled={busy === key || reason.trim().length < 3}>Save as skipped</button>
                      <button type="button" className="btn btn-quiet btn-sm" onClick={() => setSkipping(null)}>Cancel</button>
                    </div>
                  </form>
                )}
              </div>
              <div className="duty-side">
                <span className={`pill duty-pill-${item.status}`}>{DUTY_STATUS_LABEL[item.status]}</span>
                {canAct && skipping !== key && (
                  <div className="btn-row">
                    <button type="button" className="btn btn-primary btn-sm" disabled={busy === key} onClick={() => complete(item, 'done')}>{busy === key ? 'Saving…' : 'Done'}</button>
                    {item.status !== 'skipped' && <button type="button" className="btn btn-quiet btn-sm" onClick={() => { setSkipping(key); setReason(''); }}>Skip</button>}
                  </div>
                )}
              </div>
            </li>
          );
        })}
      </ul>
      {checklist.asNeeded.length > 0 && (
        <>
          <h3 className="duty-subhead">As needed</h3>
          <ul className="duty-list">
            {checklist.asNeeded.map((t) => (
              <li key={t.taskId} className="duty">
                <span className="duty-time">–</span>
                <div className="duty-main">
                  <strong>{t.title}</strong>
                  <span className="muted small">{DUTY_CATEGORY_LABEL[t.category]}{t.loggedToday ? ` · logged ${t.loggedToday}× this day` : ''}</span>
                </div>
                {editable && (
                  <div className="duty-side">
                    <button type="button" className="btn btn-secondary btn-sm" disabled={busy === `${t.taskId}|log`} onClick={() => complete({ ...t, slot: null }, 'done')}>Log it</button>
                  </div>
                )}
              </li>
            ))}
          </ul>
        </>
      )}
    </>
  );
}

/** Adherence per category (done ÷ scheduled) as horizontal bars. */
export function AdherenceBars({ adherence }) {
  if (!adherence || !adherence.scheduled) return <p className="muted small">No scheduled duties in this period yet.</p>;
  return (
    <>
      <p className="adherence-total"><strong>{adherence.rate}%</strong> <span className="muted small">of {adherence.scheduled} scheduled duties done ({adherence.from} to {adherence.to})</span></p>
      <ul className="adherence">
        {adherence.categories.map((c) => (
          <li key={c.category}>
            <span className="small">{DUTY_CATEGORY_LABEL[c.category]}</span>
            <span className="adherence-track" role="img" aria-label={`${c.rate}% done`}>
              <span className={`adherence-fill ${c.rate < 60 ? 'is-low' : ''}`} style={{ width: `${c.rate}%` }} />
            </span>
            <span className="small adherence-num">{c.done}/{c.scheduled}</span>
          </li>
        ))}
      </ul>
    </>
  );
}

/** Today's checklist + this week's adherence for one patient (read-only or caregiver mode). */
export function CareToday({ patientId, editable = false, date, compact = false }) {
  const [checklist, setChecklist] = useState(null);
  const [history, setHistory] = useState(null);
  const [error, setError] = useState('');
  const load = () => Promise.all([
    api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/checklist${date ? `?date=${date}` : ''}`),
    api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/history?pageSize=1`),
  ]).then(([c, h]) => { setChecklist(c); setHistory(h); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { setChecklist(null); load(); }, [patientId, date]); // eslint-disable-line react-hooks/exhaustive-deps

  if (error) return <ErrorNote error={error} onRetry={load} />;
  if (!checklist) return <Loading label="Loading care duties" />;
  return (
    <div className={compact ? 'stack care-today' : 'layout-split care-today'}>
      <div><DutyChecklist checklist={checklist} onChanged={editable ? load : undefined} /></div>
      <div>
        <h3 className="duty-subhead">Last 7 days</h3>
        <AdherenceBars adherence={history && history.adherence} />
      </div>
    </div>
  );
}

// Times are chosen from the list in half-hour steps, shown with AM / PM; stored as 24-hour "HH:MM".
const TIME_OPTIONS = Array.from({ length: 48 }, (_, i) => `${String(Math.floor(i / 2)).padStart(2, '0')}:${i % 2 ? '30' : '00'}`);
const timeLabel = (t) => { const [h, m] = t.split(':').map(Number); return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`; };
export const cleanTimes = (times) => [...new Set(times.filter((t) => /^\d\d:\d\d$/.test(t)))].sort();

/**
 * One dropdown per time, "+ Add another time" for the next one. A time already chosen in another row cannot
 * be chosen again. `value` is an array of "HH:MM" ('' = not chosen yet).
 */
export function TimesPicker({ label, value, onChange, emptyLabel = 'Choose a time', hint }) {
  const rows = value.length ? value : [''];
  const setAt = (i, t) => onChange(rows.map((x, j) => (j === i ? t : x)));
  return (
    <fieldset className="field times-picker">
      <legend>{label}</legend>
      {hint && <span className="muted small">{hint}</span>}
      {rows.map((t, i) => {
        const taken = new Set(rows.filter((_, j) => j !== i));
        // "Other time": any minute (e.g. 07:15), typed in a time box; "other" while it is still empty.
        const custom = t === 'other' || (t && !TIME_OPTIONS.includes(t));
        return (
          <div key={i} className="times-row">
            <select value={custom ? 'other' : t} onChange={(e) => setAt(i, e.target.value)} aria-label={`${label}, time ${i + 1}`}>
              <option value="">{i === 0 ? emptyLabel : 'Choose a time'}</option>
              {TIME_OPTIONS.map((o) => <option key={o} value={o} disabled={taken.has(o)}>{timeLabel(o)}{taken.has(o) ? ' (already chosen)' : ''}</option>)}
              <option value="other">Other time…</option>
            </select>
            {custom && <input type="time" value={t === 'other' ? '' : t} onChange={(e) => setAt(i, e.target.value || 'other')} aria-label={`${label}, time ${i + 1}: other time`}
              className={taken.has(t) ? 'is-invalid' : ''} />}
            {i > 0 && <button type="button" className="btn btn-quiet btn-sm" onClick={() => onChange(rows.filter((_, j) => j !== i))} aria-label={`Remove time ${i + 1}`}>Remove</button>}
          </div>
        );
      })}
      {rows.some((t, i) => t && t !== 'other' && rows.indexOf(t) !== i) && <span className="small text-critical" role="alert">The same time is chosen twice.</span>}
      {rows[rows.length - 1] && rows[rows.length - 1] !== 'other' && rows.length < 6 && (
        <button type="button" className="btn btn-secondary btn-sm times-add" onClick={() => onChange([...rows, ''])}>+ Add another time</button>
      )}
    </fieldset>
  );
}

// No default time: times are agreed with the elder and the caregiver and chosen by the nurse.
const EMPTY_TASK = { category: 'physical_medical', title: '', instructions: '', frequency: 'daily', times: [], daysOfWeek: [], dueDate: '', kind: 'task', measurement: '', specialised: false, sourceType: '', sourceTypeOther: '', sourceWho: '', sourceRef: '' };
const MEASUREMENT_LABEL = { bp: 'Blood pressure', heart_rate: 'Heart rate', temperature: 'Temperature', spo2: 'Oxygen (SpO2)', blood_glucose: 'Blood sugar' };
const SOURCE_LABEL = { physician_order: "Physician's order", partner_clinic: 'Partner clinic', hospital_discharge: 'Hospital discharge', clinic_protocol: 'Clinic protocol' };

function toBody(f) {
  const body = { category: f.category, title: f.title.trim(), frequency: f.frequency, instructions: f.instructions.trim() || null };
  const times = cleanTimes(f.times);
  if (['daily', 'weekly'].includes(f.frequency)) body.times = times;
  if (f.frequency === 'weekly') body.daysOfWeek = f.daysOfWeek;
  if (f.frequency === 'once') body.dueDate = f.dueDate;
  body.kind = f.kind || 'task';
  body.measurement = f.kind === 'measurement' ? f.measurement || null : null;
  body.specialised = Boolean(f.specialised);
  body.source = f.specialised || f.sourceType
    ? { type: f.sourceType || undefined, ...(f.sourceType === 'other' ? { typeOther: f.sourceTypeOther.trim() } : {}), ...(f.sourceWho ? { clinician: f.sourceWho.trim() } : {}), ...(f.sourceRef ? { reference: f.sourceRef.trim() } : {}) }
    : null;
  return body;
}

/**
 * The task list of a care plan. With `versionId` (a draft) the nurse adds, edits and retires the draft's tasks;
 * without it the tasks of the plan in use are listed read-only (they change only through a new draft).
 */
export function CarePlanEditor({ patientId, versionId = null, readOnly = !versionId, showGoals = false, onChanged }) {
  const toast = useToast();
  const [plan, setPlan] = useState(null);
  const [catalog, setCatalog] = useState(null);
  const [error, setError] = useState('');
  const [form, setForm] = useState(null); // null = closed; {id?} = editing
  const [goals, setGoals] = useState(null);
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState([]);
  const formRef = useRef(null);
  // The form opens where the nurse clicked (under the task, or below the list for a new one): bring it into view.
  useEffect(() => { if (formRef.current) formRef.current.scrollIntoView({ block: 'nearest', behavior: 'smooth' }); }, [form && form.id, Boolean(form)]); // eslint-disable-line react-hooks/exhaustive-deps

  const load = () => (versionId
    ? api(`/api/care-plan/versions/${versionId}`).then((v) => ({ plan: { goals: v.content.goals, notes: v.content.notes }, tasks: v.tasks }))
    : api(`/api/patients/${encodeURIComponent(patientId)}/care-plan`))
    .then((p) => { setPlan(p); setGoals(null); setError(''); }).catch((e) => setError(e.message));
  useEffect(() => { load(); api('/api/care/categories').then((c) => setCatalog(c.categories)).catch(() => setCatalog([])); }, [patientId, versionId]); // eslint-disable-line react-hooks/exhaustive-deps

  const set = (k) => (e) => setForm({ ...form, [k]: e.target.value });

  async function saveTask(e) {
    e.preventDefault();
    setBusy(true);
    setProblems([]);
    try {
      const body = toBody(form);
      if (form.id) await api(`/api/care/tasks/${form.id}`, { method: 'PATCH', body });
      else await api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/tasks`, { method: 'POST', body });
      toast({ title: form.id ? 'Task updated in the draft' : 'Task added to the draft', tone: 'success' });
      setForm(null);
      load();
      if (onChanged) onChanged();
    } catch (err) {
      setProblems(err.details || [err.message]);
    } finally {
      setBusy(false);
    }
  }

  async function retire(t) {
    if (!window.confirm(`Remove “${t.title}” from the care plan? Its history is kept.`)) return;
    try {
      await api(`/api/care/tasks/${t.id}`, { method: 'DELETE' });
      toast({ title: 'Task removed from the draft', tone: 'success' });
      load();
      if (onChanged) onChanged();
    } catch (err) {
      toast({ title: err.message, tone: 'error' });
    }
  }

  async function saveGoals(e) {
    e.preventDefault();
    try {
      await api(`/api/patients/${encodeURIComponent(patientId)}/care-plan`, { method: 'PUT', body: goals });
      toast({ title: 'Care plan goals saved', tone: 'success' });
      load();
    } catch (err) {
      toast({ title: err.message, tone: 'error' });
    }
  }

  if (error) return <ErrorNote error={error} onRetry={load} />;
  if (!plan) return <Loading label="Loading care plan" />;
  const suggestions = (catalog || []).find((c) => form && c.code === form.category);
  const taskForm = form && (
    <form ref={formRef} className="inline-form duty-form" onSubmit={saveTask} noValidate>
      <h3 className="duty-subhead">{form.id ? 'Edit duty' : 'New duty'}</h3>
      {problems.length > 0 && <div className="note note-error" role="alert"><ul>{problems.map((p) => <li key={p}>{p}</li>)}</ul></div>}
      <div className="form-grid">
        <label className="field"><span>Category</span>
          <select value={form.category} onChange={set('category')}>
            {Object.entries(DUTY_CATEGORY_LABEL).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </label>
        <label className="field"><span>How often</span>
          <select value={form.frequency} onChange={set('frequency')}>
            {Object.entries(FREQUENCY_LABEL).map(([code, label]) => <option key={code} value={code}>{label}</option>)}
          </select>
        </label>
      </div>
      {!form.id && suggestions && (
        <div className="chips-row" aria-label="Suggestions">
          {suggestions.suggestions.map((s) => (
            <button key={s.title} type="button" className="chip chip-btn" onClick={() => setForm({ ...form, title: s.title, frequency: s.frequency, kind: s.kind || 'task', measurement: s.measurement || '', specialised: Boolean(s.specialised) })}>{s.title}</button>
          ))}
        </div>
      )}
      <label className="field"><span>Duty</span><input value={form.title} onChange={set('title')} maxLength={160} required /></label>
      <label className="field"><span>Instructions (optional)</span><input value={form.instructions} onChange={set('instructions')} maxLength={1000} /></label>
      <div className="form-grid">
        <label className="field"><span>Type</span>
          <select value={form.kind} onChange={set('kind')}><option value="task">Task (done / not done)</option><option value="measurement">Reading (value, not measured, no device)</option></select></label>
        {form.kind === 'measurement' && (
          <label className="field"><span>Reading</span>
            <select value={form.measurement} onChange={set('measurement')}><option value="">Choose</option>{Object.entries(MEASUREMENT_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
        )}
      </div>
      <label className="check"><input type="checkbox" checked={form.specialised} onChange={(e) => setForm({ ...form, specialised: e.target.checked })} /> Specialised care (e.g. wound care, a therapeutic diet): needs a clinical source</label>
      {form.specialised && (
        <div className="form-grid">
          <label className="field"><span>Source</span><SelectOther label="Source" value={form.sourceType} onChange={(sourceType) => setForm({ ...form, sourceType })} other={form.sourceTypeOther} onOther={(sourceTypeOther) => setForm({ ...form, sourceTypeOther })} options={Object.entries(SOURCE_LABEL)} placeholder="Choose" /></label>
          <label className="field"><span>Clinician or facility</span><input value={form.sourceWho} onChange={set('sourceWho')} maxLength={120} placeholder="Dr. L. Reyes" /></label>
          <label className="field"><span>Reference (order, protocol)</span><input value={form.sourceRef} onChange={set('sourceRef')} maxLength={160} /></label>
        </div>
      )}
      {['daily', 'weekly'].includes(form.frequency) && (
        <TimesPicker label={`Times${form.frequency === 'weekly' ? ' (optional)' : ''}`} value={form.times} onChange={(times) => setForm({ ...form, times })} />
      )}
      {form.frequency === 'weekly' && (
        <fieldset className="checks">
          <legend>Days</legend>
          {WEEKDAY_SHORT.map((d, i) => (
            <label key={d} className={`check ${form.daysOfWeek.includes(i) ? 'is-on' : ''}`}>
              <input type="checkbox" checked={form.daysOfWeek.includes(i)} onChange={(e) => setForm({ ...form, daysOfWeek: e.target.checked ? [...form.daysOfWeek, i] : form.daysOfWeek.filter((x) => x !== i) })} />
              {d}
            </label>
          ))}
        </fieldset>
      )}
      {form.frequency === 'once' && <label className="field"><span>Due date</span><input type="date" value={form.dueDate} onChange={set('dueDate')} /></label>}
      <div className="btn-row form-actions">
        <button className="btn btn-primary" disabled={busy}>{busy ? 'Saving…' : form.id ? 'Save changes' : 'Add task'}</button>
        <button type="button" className="btn btn-quiet" onClick={() => setForm(null)}>Cancel</button>
      </div>
    </form>
  );

  return (
    <>
      {showGoals && (goals ? (
        <form onSubmit={saveGoals} className="inline-form">
          <label className="field"><span>Goals</span><textarea rows="2" maxLength={2000} value={goals.goals} onChange={(e) => setGoals({ ...goals, goals: e.target.value })} /></label>
          <label className="field"><span>Notes for the caregiver</span><textarea rows="2" maxLength={2000} value={goals.notes} onChange={(e) => setGoals({ ...goals, notes: e.target.value })} /></label>
          <div className="btn-row"><button className="btn btn-primary btn-sm">Save</button><button type="button" className="btn btn-quiet btn-sm" onClick={() => setGoals(null)}>Cancel</button></div>
        </form>
      ) : (
        <div className="care-goals">
          <p><strong>Goals:</strong> {(plan.plan && plan.plan.goals) || <span className="muted">none yet</span>}</p>
          {plan.plan && plan.plan.notes && <p className="small"><strong>Notes:</strong> {plan.plan.notes}</p>}
          {!readOnly && <button type="button" className="btn btn-quiet btn-sm" onClick={() => setGoals({ goals: (plan.plan && plan.plan.goals) || '', notes: (plan.plan && plan.plan.notes) || '' })}>Edit goals and notes</button>}
        </div>
      ))}

      {plan.tasks.filter((t) => t.active).length === 0 && <Empty title="No tasks yet">{readOnly ? 'Start a draft of the plan to add tasks.' : 'Add the tasks agreed with the elder and the caregiver. Medicines come from the prescription records.'}</Empty>}
      <ul className="duty-list">
        {plan.tasks.filter((t) => t.active).map((t) => (form && form.id === t.id ? (
          <li key={t.id} className="duty is-editing">{taskForm}</li>
        ) : (
          <li key={t.id} className="duty">
            <div className="duty-main">
              <strong>{t.title}</strong>
              <span className="muted small">{DUTY_CATEGORY_LABEL[t.category]} · {dutySchedule(t)}{t.kind === 'measurement' ? ` · reading: ${MEASUREMENT_LABEL[t.measurement] || t.measurement}` : ''}</span>
              {t.instructions && <span className="small">{t.instructions}</span>}
              {t.specialised && <span className="small">Specialised · source: {t.source ? [listLabel(SOURCE_LABEL, t.source.type, t.source.typeOther), t.source.clinician, t.source.reference].filter(Boolean).join(', ') : 'missing'}</span>}
            </div>
            {!readOnly && <div className="duty-side btn-row">
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => setForm({ id: t.id, category: t.category, title: t.title, instructions: t.instructions || '', frequency: t.frequency, times: [...t.times], daysOfWeek: t.daysOfWeek, dueDate: t.dueDate || '',
                kind: t.kind || 'task', measurement: t.measurement || '', specialised: Boolean(t.specialised), sourceType: (t.source && t.source.type) || '', sourceTypeOther: (t.source && t.source.typeOther) || '', sourceWho: (t.source && t.source.clinician) || '', sourceRef: (t.source && t.source.reference) || '' })}>Edit</button>
              <button type="button" className="btn btn-quiet btn-sm" onClick={() => retire(t)}>Remove</button>
            </div>}
          </li>
        )))}
      </ul>

      {!form && !readOnly && <button type="button" className="btn btn-secondary" onClick={() => { setForm(EMPTY_TASK); setProblems([]); }}>Add a task</button>}
      {form && !form.id && taskForm}
    </>
  );
}

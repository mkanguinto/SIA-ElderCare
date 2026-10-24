// Today's Care Tasks (care plan v3) on the phone. The caregiver reports, for the elder's active plan only:
// medicine doses (Taken / Not taken / Unknown), tasks (Done / Not done / Not applicable) and readings (a reading,
// Not measured, No device), with optional reasons, and can always report a concern. Nothing is preselected and a
// missing report is shown as missing, never as done. The family sees the same day read-only.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { DUTY_CATEGORY_LABEL } from '../format';
import Icon from './icons';
import { Chip, Loader, useT, usePrefs, manilaDay, hhmm, useMobileToast } from './kit';
import { PatientPicker } from './figma';
import { SLOTS, slotOf } from './data';

const STATUS = {
  done: ['ok', 'check', 'Done', 'Tapos'],
  not_done: ['moderate', 'x', 'Not done', 'Hindi nagawa'],
  not_applicable: ['info', 'checkCircle', 'Not applicable', 'Hindi kailangan'],
  skipped: ['moderate', 'x', 'Not done', 'Hindi nagawa'],
  pending: ['info', 'clock', 'To do', 'Gagawin'],
  overdue: ['high', 'alert', 'No report yet', 'Wala pang ulat'],
  missed: ['critical', 'alert', 'No report', 'Walang ulat'],
};
const DOSE = {
  taken: ['ok', 'check', 'Taken', 'Nainom'],
  not_taken: ['moderate', 'x', 'Not taken', 'Hindi nainom'],
  unknown: ['info', 'alert', 'Unknown', 'Hindi tiyak'],
  not_reported: ['info', 'clock', 'No report yet', 'Wala pang ulat'],
};
const MEASURE_FIELDS = {
  bp: [['systolic', 'Top number', 'Itaas'], ['diastolic', 'Bottom number', 'Ibaba']],
  heart_rate: [['value', 'Heart rate (bpm)', 'Pulso (bpm)']],
  temperature: [['value', 'Temperature (°C)', 'Temperatura (°C)']],
  spo2: [['value', 'Oxygen (%)', 'Oxygen (%)']],
  blood_glucose: [['value', 'Blood sugar (mg/dL)', 'Asukal (mg/dL)']],
};
// A reading goes in as a check-in too, so the usual alert rules see it.
const CHECKIN_VITALS = { bp: (r) => ({ systolic: r.systolic, diastolic: r.diastolic }), heart_rate: (r) => ({ heartRate: r.value }),
  temperature: (r) => ({ temperatureC: r.value }), spo2: (r) => ({ spo2: r.value }), blood_glucose: (r) => ({ bloodGlucose: r.value }) };
const CONCERNS = [
  ['health_change', 'Change in health or behaviour', 'Pagbabago sa kalusugan'], ['fall', 'Fall or near fall', 'Natumba o muntik'],
  ['medicine', 'Medicine problem', 'Problema sa gamot'], ['eating_drinking', 'Eating, drinking or swallowing', 'Pagkain, pag-inom o paglunok'],
  ['skin', 'Skin, wound or pressure area', 'Balat o sugat'], ['mobility', 'Moving or walking', 'Paggalaw o paglakad'],
  ['mood', 'Mood, confusion or sleep', 'Kalooban, pagkalito o tulog'], ['equipment', 'Equipment or supplies', 'Gamit o supply'],
  ['caregiver_capacity', 'I cannot do a task safely', 'Hindi ko kayang gawin nang ligtas'], ['other', 'Something else', 'Iba pa'],
];
const DAYS_BACK = 7;
const medLabel = (m) => [m.name, m.strength || m.dosage, m.dose, m.route].filter(Boolean).join(' · ');

export function useChecklist(patientId, date) {
  const [state, setState] = useState(null);
  const load = useCallback(() => (patientId
    ? Promise.all([
      api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/checklist${date ? `?date=${date}` : ''}`),
      api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/history?pageSize=1`).catch(() => null),
      api(`/api/patients/${encodeURIComponent(patientId)}/care-plan`).catch(() => null),
    ]).then(([checklist, history, plan]) => setState({ checklist, adherence: history && history.adherence, plan: plan && plan.plan, active: plan && (plan.active || plan.summary) }))
      .catch((e) => setState({ error: e.message }))
    : Promise.resolve()), [patientId, date]);
  useEffect(() => { setState(null); load(); }, [load]);
  return [state, load];
}

/** Compact "3 of 5 done" card with the next few tasks (family Today, caregiver Home). */
export function DutiesSummary({ patientId, to, LinkComponent }) {
  const tr = useT();
  const [state] = useChecklist(patientId);
  if (!state || state.error || !state.checklist.summary.total) return null;
  const { summary, items } = state.checklist;
  const next = items.filter((i) => !['done', 'not_applicable'].includes(i.status)).slice(0, 3);
  return (
    <section className="m-card">
      <div className="m-between">
        <h3 className="m-card-title" style={{ marginBottom: 0 }}>{tr(`${summary.done} of ${summary.total} tasks done`, `${summary.done} sa ${summary.total} gawain tapos`)}</h3>
        {to && <LinkComponent to={to} className="m-link">{tr('See all', 'Lahat')}</LinkComponent>}
      </div>
      <div className="m-bar" style={{ margin: '.6rem 0 .25rem' }}><span style={{ width: `${(summary.done / summary.total) * 100}%` }} /></div>
      {next.length > 0 && (
        <ul className="m-steps-list" style={{ marginTop: '.5rem' }}>
          {next.map((i) => {
            const [tone, icon, en, fil] = STATUS[i.status] || STATUS.pending;
            return (
              <li key={`${i.taskId}|${i.slot}`}>
                <div className="m-grow"><strong style={{ fontSize: '.9375rem' }}>{i.title}</strong><span className="m-sub">{i.slot && i.slot !== 'any' ? hhmm(i.slot) : tr('Any time', 'Kahit kailan')}</span></div>
                <Chip tone={tone} icon={icon}>{tr(en, fil)}</Chip>
              </li>
            );
          })}
        </ul>
      )}
    </section>
  );
}

/** Today's Care Tasks for one elder. `editable` = caregiver; the family view is read-only. */
export function DutiesScreen({ patients, editable }) {
  const tr = useT();
  const { lang } = usePrefs();
  const [toast, setToast] = useMobileToast();
  const [patientId, setPatientId] = useState(patients[0] && patients[0].id);
  const days = Array.from({ length: editable ? DAYS_BACK + 1 : 1 }, (_, i) => manilaDay(Date.now() - i * 86400000));
  const [date, setDate] = useState(days[0]);
  const [state, reload] = useChecklist(patientId, date);
  const [concernOpen, setConcernOpen] = useState(false);
  const version = state && state.checklist && state.checklist.planVersion;

  /** What every report says about where it came from: the plan version shown and when it was recorded. */
  const meta = () => ({ date, ...(version ? { planVersion: version.version } : {}), recordedAt: new Date().toISOString() });
  async function send(path, body, done) {
    try {
      await api(path, { method: 'POST', body: { ...meta(), ...body } });
      setToast(done);
      reload();
      return true;
    } catch (e) { setToast((e.details || [e.message]).join('. ')); return false; }
  }

  const dayLabel = (d, i) => (i === 0 ? tr('Today', 'Ngayon') : i === 1 ? tr('Yesterday', 'Kahapon')
    : new Date(`${d}T12:00:00+08:00`).toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', timeZone: 'Asia/Manila' }));
  const cl = state && state.checklist;
  const meds = cl && cl.medicines;

  return (
    <>
      {toast}
      {patients[0] && patients[0].fullName && (
        <>
          <h2 className="m-label">{tr('Patient', 'Pasyente')}</h2>
          <PatientPicker patients={patients.map((p) => ({ id: p.id, name: p.fullName }))} value={patientId} onChange={setPatientId} />
        </>
      )}
      {editable && (
        <button type="button" className="m-btn m-concern-btn" onClick={() => setConcernOpen(true)}><Icon name="alert" size={20} />{tr('Report a concern', 'Mag-ulat ng alalahanin')}</button>
      )}
      {concernOpen && <ConcernForm patientId={patientId} active={state && state.active} onClose={() => setConcernOpen(false)} onSent={(id) => { setConcernOpen(false); setToast(tr(`Concern ${id} sent to the clinic. A nurse will follow up.`, `Naipadala ang ${id}. Susundan ito ng nars.`)); }} />}
      <h2 className="m-label">{tr('Date', 'Petsa')}</h2>
      {editable && (
        <div className="m-pills m-scroll-x" role="radiogroup" aria-label={tr('Day', 'Araw')} style={{ marginBottom: '.75rem' }}>
          {days.map((d, i) => <button key={d} type="button" role="radio" aria-checked={d === date} aria-pressed={d === date} className="m-pill" onClick={() => setDate(d)}>{dayLabel(d, i)}</button>)}
        </div>
      )}
      {!state && <Loader />}
      {state && state.error && <p className="m-error">{state.error}</p>}
      {cl && (
        <>
          <section className="m-hero m-duty-hero">
            <p className="m-caption" style={{ color: 'var(--text-brand)' }}>{new Date(`${date}T12:00:00+08:00`).toLocaleDateString(lang === 'fil' ? 'fil-PH' : 'en-PH', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' })}</p>
            <h2>{tr(`${cl.summary.done} of ${cl.summary.total} tasks done`, `${cl.summary.done} sa ${cl.summary.total} gawain tapos`)}</h2>
            <div className="m-duty-bar"><span style={{ width: `${cl.summary.total ? (cl.summary.done / cl.summary.total) * 100 : 0}%` }} /></div>
            <p className="m-caption m-plan-version">
              {version ? tr(`Care plan version ${version.version}`, `Care plan bersyon ${version.version}`) : tr('No active care plan yet', 'Wala pang care plan')}
              {state.active && state.active.legacy ? tr(' · not yet reviewed by the nurse', ' · hindi pa nasusuri ng nars') : ''}
              {cl.summary.overdue + cl.summary.missed ? tr(` · ${cl.summary.overdue + cl.summary.missed} without a report`, ` · ${cl.summary.overdue + cl.summary.missed} walang ulat`) : ''}
            </p>
          </section>

          {meds && (meds.doses || meds.summary) && (
            <section>
              <h3 className="m-label">{tr('Medicines', 'Gamot')}</h3>
              {meds.error && <p className="m-error">{tr('The medicine list could not be loaded. Follow the paper prescription and report later.', 'Hindi ma-load ang listahan ng gamot.')}</p>}
              {editable && meds.doses && meds.doses.length > 0 && <p className="m-caption" style={{ marginBottom: '.5rem' }}>{tr('Report what you saw. Your report is not proof the dose was taken; the nurse reviews it.', 'Iulat ang nakita mo. Susuriin ito ng nars.')}</p>}
              {!editable && meds.summary && <p className="m-muted">{tr(`${meds.summary.taken} of ${meds.summary.total} doses reported taken${meds.summary.notReported ? ` · ${meds.summary.notReported} not reported yet` : ''}`, `${meds.summary.taken} sa ${meds.summary.total} dosis ang naiulat na nainom`)}</p>}
              <div className="m-stack">
                {(meds.doses || []).map((d) => <DoseCard key={`${d.medication.id}|${d.slot}`} dose={d} editable={editable} patientId={patientId} send={send} />)}
              </div>
              {(meds.asNeeded || []).length > 0 && <p className="m-caption" style={{ marginTop: '.5rem' }}>{tr('As needed:', 'Kung kailangan:')} {meds.asNeeded.map((a) => medLabel(a.medication)).join('; ')}</p>}
            </section>
          )}

          {!cl.items.length && <div className="m-note">{tr('No tasks planned for this day.', 'Walang gawain sa araw na ito.')}</div>}
          {[...SLOTS, { key: 'any', en: 'Any time', fil: 'Kahit kailan' }].map((slot) => {
            const list = cl.items.filter((item) => (item.slot && item.slot !== 'any' ? slotOf(item.slot) : 'any') === slot.key);
            if (!list.length) return null;
            return (
              <section key={slot.key}>
                <h3 className="m-label">{lang === 'fil' ? slot.fil : slot.en}</h3>
                <div className="m-stack">{list.map((item) => <TaskCard key={`${item.taskId}|${item.slot}`} item={item} editable={editable} patientId={patientId} send={send} />)}</div>
              </section>
            );
          })}
          {cl.asNeeded.length > 0 && (
            <>
              <h2 className="m-section-title">{tr('As needed', 'Kung kailangan')}</h2>
              <div className="m-stack">
                {cl.asNeeded.map((t) => (
                  <div key={t.taskId} className="m-card m-row" style={{ marginTop: 0 }}>
                    <div className="m-grow"><strong>{t.title}</strong><span className="m-sub" style={{ display: 'block', fontSize: '.8125rem', color: 'var(--text-secondary)' }}>{DUTY_CATEGORY_LABEL[t.category]}{t.loggedToday ? tr(` · logged ${t.loggedToday}×`, ` · ${t.loggedToday}× naitala`) : ''}</span></div>
                    {editable && <button type="button" className="m-btn" style={{ minHeight: '2.75rem' }} onClick={() => send(`/api/care/tasks/${t.taskId}/completions`, { status: 'done' }, tr(`"${t.title}" logged`, `Naitala ang "${t.title}"`))}>{tr('Log it', 'Itala')}</button>}
                  </div>
                ))}
              </div>
            </>
          )}
          {state.plan && (state.plan.goals || state.plan.notes) && (
            <div className="m-note" style={{ marginTop: '1rem' }}>
              {state.plan.goals && <><strong>{tr('Goals', 'Layunin')}</strong>{state.plan.goals}</>}
              {state.plan.notes && <p style={{ marginTop: '.35rem' }}>{state.plan.notes}</p>}
            </div>
          )}
          <Adherence adherence={state.adherence} />
        </>
      )}
    </>
  );
}

/** One medicine dose: Taken / Not taken / Unknown, with an optional time or reason. */
function DoseCard({ dose, editable, patientId, send }) {
  const tr = useT();
  const [choice, setChoice] = useState(null);
  const [time, setTime] = useState('');
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const m = dose.medication;
  const [tone, icon, en, fil] = DOSE[dose.status] || DOSE.not_reported;
  const open = editable && (dose.status === 'not_reported' || choice !== null);
  async function save(status) {
    setBusy(true);
    const actualTime = status === 'taken' && time ? new Date(`${manilaDay()}T${time}:00+08:00`).toISOString() : undefined;
    const ok = await send(`/api/patients/${encodeURIComponent(patientId)}/medication-reports`,
      { medicationId: m.id, slot: dose.slot, status, ...(actualTime ? { actualTime } : {}), ...(reason.trim() ? { reason: reason.trim() } : {}) },
      tr(`${m.name} ${hhmm(dose.slot)}: ${DOSE[status][2].toLowerCase()}`, `${m.name}: naiulat`));
    setBusy(false);
    if (ok) { setChoice(null); setTime(''); setReason(''); }
  }
  return (
    <div className="m-card" style={{ marginTop: 0 }}>
      <div className="m-row" style={{ alignItems: 'flex-start' }}>
        <div className="m-grow">
          <p className="m-caption" style={{ fontWeight: 700 }}>{hhmm(dose.slot)}</p>
          <strong style={{ display: 'block', marginTop: '.15rem' }}>{medLabel(m)}</strong>
          {(m.foodInstructions || m.instructions) && <p className="m-muted" style={{ fontSize: '.875rem', marginTop: '.2rem' }}>{[m.foodInstructions, m.instructions].filter(Boolean).join(' · ')}</p>}
          {dose.report && dose.report.reason && <p className="m-caption">“{dose.report.reason}”</p>}
          {dose.report && dose.report.reportedForPrevious && <p className="m-caption">{tr('Reported before the prescription was changed today', 'Naiulat bago binago ang reseta ngayon')}</p>}
        </div>
        <Chip tone={tone} icon={icon}>{tr(en, fil)}</Chip>
      </div>
      {m.missedDoseInstructions && ['not_taken', 'unknown'].includes(choice || dose.status) && (
        <p className="m-banner tone-info" style={{ marginTop: '.6rem' }}><Icon name="file" />{tr('Doctor\'s instruction for a missed dose: ', 'Bilin ng doktor kapag nakaligtaan: ')}{m.missedDoseInstructions}</p>
      )}
      {editable && !open && <button type="button" className="m-link" style={{ marginTop: '.4rem' }} onClick={() => setChoice('')}>{tr('Change the report', 'Baguhin ang ulat')}</button>}
      {open && (
        <div className="m-stack" style={{ marginTop: '.75rem', gap: '.5rem' }}>
          <div className="m-choice3" role="group" aria-label={tr(`${m.name} at ${hhmm(dose.slot)}`, `${m.name}`)}>
            {['taken', 'not_taken', 'unknown'].map((s) => <button key={s} type="button" className="m-btn" aria-pressed={choice === s} onClick={() => setChoice(s)}>{tr(DOSE[s][2], DOSE[s][3])}</button>)}
          </div>
          {choice === 'taken' && <label className="m-field"><span>{tr('Time it was taken (optional)', 'Oras na ininom (opsyonal)')}</span><input type="time" value={time} onChange={(e) => setTime(e.target.value)} /></label>}
          {['not_taken', 'unknown'].includes(choice) && <label className="m-field"><span>{tr('Why? (optional)', 'Bakit? (opsyonal)')}</span><input value={reason} maxLength={300} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. refused, asleep, ran out', 'hal. ayaw, tulog, naubos')} /></label>}
          {choice && <button type="button" className="m-btn is-dark" disabled={busy} onClick={() => save(choice)}>{busy ? tr('Saving…', 'Sine-save…') : tr('Save', 'I-save')}</button>}
        </div>
      )}
    </div>
  );
}

/** One task: Done / Not done / Not applicable (with an optional reason), or a reading for a measurement task. */
function TaskCard({ item, editable, patientId, send }) {
  const tr = useT();
  const [choice, setChoice] = useState(null);
  const [reason, setReason] = useState('');
  const [reading, setReading] = useState({});
  const [busy, setBusy] = useState(false);
  const [tone, icon, en, fil] = STATUS[item.status] || STATUS.pending;
  const reported = Boolean(item.completion);
  const open = editable && (!reported || choice !== null);
  const isMeasure = item.kind === 'measurement';
  const fields = isMeasure ? MEASURE_FIELDS[item.measurement] || [] : [];
  const path = `/api/care/tasks/${item.taskId}/completions`;
  const base = { ...(item.slot ? { slot: item.slot } : {}) };
  async function save(status) {
    setBusy(true);
    let body;
    if (isMeasure) {
      if (status === 'recorded') {
        const r = Object.fromEntries(fields.map(([k]) => [k, Number(reading[k])]));
        let checkinId;
        try {
          const c = await api('/api/checkins', { method: 'POST', body: { patientId, vitals: CHECKIN_VITALS[item.measurement](r) } });
          checkinId = c.checkin && c.checkin.id;
        } catch { /* the reading is still kept with the task */ }
        body = { ...base, measurementStatus: 'recorded', reading: r, ...(checkinId ? { checkinId } : {}) };
      } else body = { ...base, measurementStatus: status, ...(reason.trim() ? { note: reason.trim() } : {}) };
    } else body = { ...base, status, ...(reason.trim() ? { note: reason.trim() } : {}) };
    const ok = await send(path, body, tr(`"${item.title}" saved`, `Naitala ang "${item.title}"`));
    setBusy(false);
    if (ok) { setChoice(null); setReason(''); setReading({}); }
  }
  const options = isMeasure ? [['recorded', 'Enter reading', 'Ilagay ang sukat'], ['not_measured', 'Not measured', 'Hindi nasukat'], ['no_device', 'No device', 'Walang gamit']]
    : [['done', 'Done', 'Tapos'], ['not_done', 'Not done', 'Hindi nagawa'], ['not_applicable', 'Not applicable', 'Hindi kailangan']];
  const readingOk = fields.length && fields.every(([k]) => reading[k] !== undefined && reading[k] !== '' && Number.isFinite(Number(reading[k])));
  const c = item.completion;
  return (
    <div className="m-card" style={{ marginTop: 0 }}>
      <div className="m-row" style={{ alignItems: 'flex-start' }}>
        <div className="m-grow">
          <p className="m-caption" style={{ fontWeight: 700 }}>{item.slot && item.slot !== 'any' ? hhmm(item.slot) : tr('Any time', 'Kahit kailan')} · {DUTY_CATEGORY_LABEL[item.category]}</p>
          <strong style={{ fontSize: '1.0625rem', display: 'block', marginTop: '.15rem' }}>{item.title}</strong>
          {item.instructions && <p className="m-muted" style={{ fontSize: '.875rem', marginTop: '.25rem' }}>{item.instructions}</p>}
          {item.carriedOver && <p className="m-caption">{tr(`Was due ${item.dueDate}`, `Dapat noong ${item.dueDate}`)}</p>}
          {c && c.reading && <p className="m-caption">{tr('Reading', 'Sukat')}: {Object.values(c.reading).join('/')}</p>}
          {c && c.measurementStatus && c.measurementStatus !== 'recorded' && <p className="m-caption">{c.measurementStatus === 'no_device' ? tr('No device', 'Walang gamit') : tr('Not measured', 'Hindi nasukat')}</p>}
          {c && c.note && <p className="m-caption">“{c.note}”</p>}
          {c && c.reportedUnderVersion && <p className="m-caption">{tr('Reported under the earlier plan version', 'Naiulat sa naunang bersyon')}</p>}
        </div>
        <Chip tone={tone} icon={icon}>{tr(en, fil)}</Chip>
      </div>
      {editable && !open && <button type="button" className="m-link" style={{ marginTop: '.4rem' }} onClick={() => setChoice('')}>{tr('Change the report', 'Baguhin ang ulat')}</button>}
      {open && (
        <div className="m-stack" style={{ marginTop: '.75rem', gap: '.5rem' }}>
          <div className="m-choice3" role="group" aria-label={item.title}>
            {options.map(([k, e2, f2]) => <button key={k} type="button" className="m-btn" aria-pressed={choice === k} onClick={() => setChoice(k)}>{tr(e2, f2)}</button>)}
          </div>
          {choice === 'recorded' && (
            <div className="m-grid-2">
              {fields.map(([k, e2, f2]) => <label key={k} className="m-field"><span>{tr(e2, f2)}</span><input inputMode="decimal" value={reading[k] ?? ''} onChange={(e) => setReading({ ...reading, [k]: e.target.value })} /></label>)}
            </div>
          )}
          {choice && choice !== 'done' && choice !== 'recorded' && (
            <label className="m-field"><span>{tr('Reason (optional)', 'Dahilan (opsyonal)')}</span><input value={reason} maxLength={500} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. elder was asleep', 'hal. tulog ang pasyente')} /></label>
          )}
          {choice && <button type="button" className="m-btn is-dark" disabled={busy || (choice === 'recorded' && !readingOk)} onClick={() => save(choice)}>{busy ? tr('Saving…', 'Sine-save…') : tr('Save', 'I-save')}</button>}
        </div>
      )}
    </div>
  );
}

/** "Report a concern": goes to the clinic as a concern a nurse resolves. Emergency instructions are shown first. */
function ConcernForm({ patientId, active, onClose, onSent }) {
  const tr = useT();
  const [category, setCategory] = useState('');
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const contact = active && active.content ? active.content.contact : active && active.contact;
  const emergency = contact && (contact.emergency && contact.emergency.text ? contact.emergency.text : contact.emergency);
  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/patients/${encodeURIComponent(patientId)}/concerns`, { method: 'POST', body: { category, description: text.trim() } });
      onSent(r.id);
    } catch (err) { setError((err.details || [err.message]).join('. ')); } finally { setBusy(false); }
  }
  return (
    <form className="m-card m-stack" onSubmit={submit} style={{ marginTop: '.75rem' }}>
      <div className="m-between"><h2 className="m-card-title" style={{ marginBottom: 0 }}>{tr('Report a concern', 'Mag-ulat ng alalahanin')}</h2><button type="button" className="m-link" onClick={onClose}>{tr('Close', 'Isara')}</button></div>
      <p className="m-banner tone-critical"><Icon name="alert" />{emergency || tr('In an emergency call 911 first.', 'Kung emergency, tumawag muna sa 911.')}</p>
      <label className="m-field"><span>{tr('What is it about?', 'Tungkol saan?')}</span>
        <select value={category} onChange={(e) => setCategory(e.target.value)} required>
          <option value="">{tr('Choose', 'Pumili')}</option>
          {CONCERNS.map(([k, e2, f2]) => <option key={k} value={k}>{tr(e2, f2)}</option>)}
        </select></label>
      <label className="m-field"><span>{tr('What happened?', 'Ano ang nangyari?')}</span>
        <textarea rows="3" value={text} onChange={(e) => setText(e.target.value)} minLength={3} maxLength={1000} required /></label>
      {error && <p className="m-error" role="alert">{error}</p>}
      <button className="m-btn is-dark" disabled={busy || !category || text.trim().length < 3}>{busy ? tr('Sending…', 'Ipinapadala…') : tr('Send to the clinic', 'Ipadala sa klinika')}</button>
    </form>
  );
}

function Adherence({ adherence }) {
  const tr = useT();
  if (!adherence || !adherence.scheduled) return null;
  return (
    <section className="m-card" style={{ marginTop: '1rem' }}>
      <div className="m-between"><h3 className="m-card-title" style={{ marginBottom: 0 }}>{tr('Last 7 days', 'Nakaraang 7 araw')}</h3><strong style={{ fontSize: '1.25rem' }}>{adherence.rate}%</strong></div>
      <p className="m-caption">{tr(`of ${adherence.scheduled} scheduled tasks done`, `ng ${adherence.scheduled} gawain ang natapos`)}</p>
      {adherence.categories.map((c) => (
        <div key={c.category} style={{ marginTop: '.6rem' }}>
          <div className="m-between" style={{ fontSize: '.875rem' }}><span className="m-muted">{DUTY_CATEGORY_LABEL[c.category]}</span><span>{c.done}/{c.scheduled}</span></div>
          <div className="m-score-bar" style={{ margin: '.3rem 0 0' }}><span style={{ width: `${c.rate}%`, background: c.rate < 60 ? 'var(--accent-high)' : 'var(--bg-primary)' }} /></div>
        </div>
      ))}
    </section>
  );
}

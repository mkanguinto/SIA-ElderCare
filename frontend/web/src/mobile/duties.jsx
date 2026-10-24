// Care duties from the care plan (Batch 4) on the phone: the caregiver ticks them off (done / skip with reason /
// log an as-needed duty, up to 7 days late); the family sees the same checklist read-only.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { DUTY_CATEGORY_LABEL } from '../format';
import Icon from './icons';
import { Chip, Loader, useT, usePrefs, manilaDay, hhmm, useMobileToast } from './kit';
import { PatientPicker } from './figma';
import { SLOTS, slotOf } from './data';

const STATUS = {
  done: ['ok', 'check', 'Done', 'Tapos'],
  skipped: ['moderate', 'x', 'Skipped', 'Nilaktawan'],
  pending: ['info', 'clock', 'To do', 'Gagawin'],
  overdue: ['high', 'alert', 'Overdue', 'Huli na'],
  missed: ['critical', 'alert', 'Missed', 'Hindi nagawa'],
};
const DAYS_BACK = 7;

export function useChecklist(patientId, date) {
  const [state, setState] = useState(null);
  const load = useCallback(() => (patientId
    ? Promise.all([
      api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/checklist${date ? `?date=${date}` : ''}`),
      api(`/api/patients/${encodeURIComponent(patientId)}/care-plan/history?pageSize=1`).catch(() => null),
      api(`/api/patients/${encodeURIComponent(patientId)}/care-plan`).catch(() => null),
    ]).then(([checklist, history, plan]) => setState({ checklist, adherence: history && history.adherence, plan: plan && plan.plan }))
      .catch((e) => setState({ error: e.message }))
    : Promise.resolve()), [patientId, date]);
  useEffect(() => { setState(null); load(); }, [load]);
  return [state, load];
}

/** Compact "3 of 5 done" card with the next few duties (family Today, caregiver Home). */
export function DutiesSummary({ patientId, to, LinkComponent }) {
  const tr = useT();
  const [state] = useChecklist(patientId);
  if (!state || state.error || !state.checklist.summary.total) return null;
  const { summary, items } = state.checklist;
  const next = items.filter((i) => i.status !== 'done').slice(0, 3);
  return (
    <section className="m-card">
      <div className="m-between">
        <h3 className="m-card-title" style={{ marginBottom: 0 }}>{tr(`${summary.done} of ${summary.total} duties done`, `${summary.done} sa ${summary.total} gawain tapos`)}</h3>
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

/** Full checklist for one patient. `editable` = caregiver. */
export function DutiesScreen({ patients, editable }) {
  const tr = useT();
  const { lang } = usePrefs();
  const [toast, setToast] = useMobileToast();
  const [patientId, setPatientId] = useState(patients[0] && patients[0].id);
  const days = Array.from({ length: editable ? DAYS_BACK + 1 : 1 }, (_, i) => manilaDay(Date.now() - i * 86400000));
  const [date, setDate] = useState(days[0]);
  const [state, reload] = useChecklist(patientId, date);
  const [busy, setBusy] = useState(null);
  const [skipping, setSkipping] = useState(null);
  const [reason, setReason] = useState('');

  async function complete(item, status, note) {
    const key = `${item.taskId}|${item.slot || 'log'}`;
    setBusy(key);
    try {
      await api(`/api/care/tasks/${item.taskId}/completions`, {
        method: 'POST',
        body: { date, ...(item.slot ? { slot: item.slot } : {}), status, ...(note ? { note } : {}) },
      });
      setSkipping(null);
      setReason('');
      setToast(status === 'skipped' ? tr(`"${item.title}" skipped`, `Nilaktawan ang "${item.title}"`) : tr(`"${item.title}" done`, `Tapos ang "${item.title}"`));
      reload();
    } catch (e) { setToast(e.message); } finally { setBusy(null); }
  }

  const dayLabel = (d, i) => (i === 0 ? tr('Today', 'Ngayon') : i === 1 ? tr('Yesterday', 'Kahapon')
    : new Date(`${d}T12:00:00+08:00`).toLocaleDateString('en-PH', { weekday: 'short', day: 'numeric', timeZone: 'Asia/Manila' }));

  return (
    <>
      {toast}
      {patients[0] && patients[0].fullName && (
        <>
          <h2 className="m-label">{tr('Patient', 'Pasyente')}</h2>
          <PatientPicker patients={patients.map((p) => ({ id: p.id, name: p.fullName }))} value={patientId} onChange={setPatientId} />
        </>
      )}
      <h2 className="m-label">{tr('Date', 'Petsa')}</h2>
      {editable && (
        <div className="m-pills m-scroll-x" role="radiogroup" aria-label={tr('Day', 'Araw')} style={{ marginBottom: '.75rem' }}>
          {days.map((d, i) => <button key={d} type="button" role="radio" aria-checked={d === date} aria-pressed={d === date} className="m-pill" onClick={() => setDate(d)}>{dayLabel(d, i)}</button>)}
        </div>
      )}
      {!state && <Loader />}
      {state && state.error && <p className="m-error">{state.error}</p>}
      {state && state.checklist && (
        <>
          <section className="m-hero m-duty-hero">
            <p className="m-caption" style={{ color: 'var(--text-brand)' }}>{new Date(`${date}T12:00:00+08:00`).toLocaleDateString(lang === 'fil' ? 'fil-PH' : 'en-PH', { weekday: 'long', month: 'long', day: 'numeric', timeZone: 'Asia/Manila' })}</p>
            <h2>{tr(`${state.checklist.summary.done} of ${state.checklist.summary.total} duties done`, `${state.checklist.summary.done} sa ${state.checklist.summary.total} gawain tapos`)}</h2>
            <div className="m-duty-bar"><span style={{ width: `${state.checklist.summary.total ? (state.checklist.summary.done / state.checklist.summary.total) * 100 : 0}%` }} /></div>
            {(state.checklist.summary.overdue + state.checklist.summary.missed + state.checklist.summary.skipped) > 0 && (
              <p className="m-caption" style={{ marginTop: '.5rem' }}>{[
                state.checklist.summary.overdue + state.checklist.summary.missed ? tr(`${state.checklist.summary.overdue + state.checklist.summary.missed} ${date === days[0] ? 'overdue' : 'missed'}`, `${state.checklist.summary.overdue + state.checklist.summary.missed} huli`) : '',
                state.checklist.summary.skipped ? tr(`${state.checklist.summary.skipped} skipped`, `${state.checklist.summary.skipped} nilaktawan`) : '',
              ].filter(Boolean).join(' · ')}</p>
            )}
          </section>
          {!state.checklist.items.length && <div className="m-note">{tr('No duties planned for this day.', 'Walang gawain sa araw na ito.')}</div>}
          {[...SLOTS, { key: 'any', en: 'Any time', fil: 'Kahit kailan' }].map((slot) => {
            const list = state.checklist.items.filter((item) => (item.slot && item.slot !== 'any' ? slotOf(item.slot) : 'any') === slot.key);
            if (!list.length) return null;
            return (
          <section key={slot.key}>
          <h3 className="m-label">{lang === 'fil' ? slot.fil : slot.en}</h3>
          <div className="m-stack">
            {list.map((item) => {
              const key = `${item.taskId}|${item.slot}`;
              const [tone, icon, en, fil] = STATUS[item.status] || STATUS.pending;
              const canAct = editable && ['pending', 'overdue', 'missed', 'skipped'].includes(item.status);
              return (
                <div key={key} className="m-card" style={{ marginTop: 0 }}>
                  <div className="m-row" style={{ alignItems: 'flex-start' }}>
                    <div className="m-grow">
                      <p className="m-caption" style={{ fontWeight: 700 }}>{item.slot && item.slot !== 'any' ? hhmm(item.slot) : tr('Any time', 'Kahit kailan')} · {DUTY_CATEGORY_LABEL[item.category]}</p>
                      <strong style={{ fontSize: '1.0625rem', display: 'block', marginTop: '.15rem' }}>{item.title}</strong>
                      {item.instructions && <p className="m-muted" style={{ fontSize: '.875rem', marginTop: '.25rem' }}>{item.instructions}</p>}
                      {item.carriedOver && <p className="m-caption">{tr(`Was due ${item.dueDate}`, `Dapat noong ${item.dueDate}`)}</p>}
                      {item.completion && item.completion.note && <p className="m-caption">“{item.completion.note}”</p>}
                    </div>
                    <Chip tone={tone} icon={icon}>{tr(en, fil)}</Chip>
                  </div>
                  {canAct && skipping !== key && (
                    <div className="m-grid-2" style={{ marginTop: '.75rem' }}>
                      <button type="button" className="m-btn is-dark" disabled={busy === key} onClick={() => complete(item, 'done')}><Icon name="check" size={18} />{busy === key ? tr('Saving…', 'Sine-save…') : tr('Done', 'Tapos na')}</button>
                      {item.status !== 'skipped' ? <button type="button" className="m-btn" onClick={() => { setSkipping(key); setReason(''); }}>{tr('Skip', 'Laktawan')}</button> : <span />}
                    </div>
                  )}
                  {skipping === key && (
                    <form className="m-stack" style={{ marginTop: '.75rem' }} onSubmit={(e) => { e.preventDefault(); complete(item, 'skipped', reason.trim()); }}>
                      <label className="m-field"><span>{tr('Why was it skipped?', 'Bakit nilaktawan?')}</span>
                        <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={3} maxLength={500} required autoFocus placeholder={tr('e.g. patient was asleep', 'hal. tulog ang pasyente')} /></label>
                      <div className="m-grid-2">
                        <button className="m-btn is-dark" disabled={busy === key || reason.trim().length < 3}>{tr('Save', 'I-save')}</button>
                        <button type="button" className="m-btn" onClick={() => setSkipping(null)}>{tr('Cancel', 'Kanselahin')}</button>
                      </div>
                    </form>
                  )}
                </div>
              );
            })}
          </div>
          </section>
            );
          })}
          {state.checklist.asNeeded.length > 0 && (
            <>
              <h2 className="m-section-title">{tr('As needed', 'Kung kailangan')}</h2>
              <div className="m-stack">
                {state.checklist.asNeeded.map((t) => (
                  <div key={t.taskId} className="m-card m-row" style={{ marginTop: 0 }}>
                    <div className="m-grow"><strong>{t.title}</strong><span className="m-sub" style={{ display: 'block', fontSize: '.8125rem', color: 'var(--text-secondary)' }}>{DUTY_CATEGORY_LABEL[t.category]}{t.loggedToday ? tr(` · logged ${t.loggedToday}×`, ` · ${t.loggedToday}× naitala`) : ''}</span></div>
                    {editable && <button type="button" className="m-btn" style={{ minHeight: '2.75rem' }} disabled={busy === `${t.taskId}|log`} onClick={() => complete({ ...t, slot: null }, 'done')}>{tr('Log it', 'Itala')}</button>}
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

function Adherence({ adherence }) {
  const tr = useT();
  if (!adherence || !adherence.scheduled) return null;
  return (
    <section className="m-card" style={{ marginTop: '1rem' }}>
      <div className="m-between"><h3 className="m-card-title" style={{ marginBottom: 0 }}>{tr('Last 7 days', 'Nakaraang 7 araw')}</h3><strong style={{ fontSize: '1.25rem' }}>{adherence.rate}%</strong></div>
      <p className="m-caption">{tr(`of ${adherence.scheduled} scheduled duties done`, `ng ${adherence.scheduled} gawain ang natapos`)}</p>
      {adherence.categories.map((c) => (
        <div key={c.category} style={{ marginTop: '.6rem' }}>
          <div className="m-between" style={{ fontSize: '.875rem' }}><span className="m-muted">{DUTY_CATEGORY_LABEL[c.category]}</span><span>{c.done}/{c.scheduled}</span></div>
          <div className="m-score-bar" style={{ margin: '.3rem 0 0' }}><span style={{ width: `${c.rate}%`, background: c.rate < 60 ? 'var(--accent-high)' : 'var(--bg-primary)' }} /></div>
        </div>
      ))}
    </section>
  );
}

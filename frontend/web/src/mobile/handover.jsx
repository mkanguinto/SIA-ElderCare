// Care team, case ownership and nurse handover on the nurse's phone (Batch 2).
// A case moves to another nurse only when that nurse accepts the handover; until then it stays with the
// outgoing nurse. Duty status is set here by the nurse and has nothing to do with signing in or out.
import React, { useCallback, useEffect, useState } from 'react';
import { api, clearDraft } from '../api';
import { Link, navigate } from '../router';
import { relTime } from '../format';
import Icon from './icons';
import { useRestoredDraft, useKeepDraft, DraftNotice } from './drafts';
import { TopBar, Cta, Chip, Banner, Loader, useT, useMobileToast, isToday, clock, manilaDay, toneFor, PRIORITY_TONE } from './kit';

const BASE = '/m/nurse';
const base = () => (window.location.pathname.startsWith('/clinic') ? '/clinic' : BASE);
const when = (ts) => (isToday(ts) ? clock(ts) : `${new Date(ts).toLocaleDateString('en-PH', { month: 'short', day: 'numeric', timeZone: 'Asia/Manila' })} ${clock(ts)}`);
const avatar = (name = '') => name.replace(/^(Lola|Lolo) /, '').split(' ').slice(0, 2).map((w) => w[0]).join('');

/** Pending handovers for me: {incoming, outgoing}. Polls so an accepted / declined handover shows up. */
export function usePendingHandovers(pollMs = 30000) {
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/api/clinic/queue/pending-handovers').then(setData).catch((e) => setData({ error: e.message })), []);
  useEffect(() => {
    load();
    const t = setInterval(load, pollMs);
    return () => clearInterval(t);
  }, [load, pollMs]);
  return [data, load];
}

export function useMyCases() {
  const [data, setData] = useState(null);
  const load = useCallback(() => api('/api/clinic/my-cases').then(setData).catch((e) => setData({ error: e.message })), []);
  useEffect(() => { load(); }, [load]);
  return [data, load];
}

/* ------------------------------ duty (separate from login) ------------------------------ */
export function DutyToggle({ user }) {
  const tr = useT();
  const [onDuty, setOnDuty] = useState(null);
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    api('/api/clinic/duty').then((r) => {
      const mine = r.nurses.find((n) => n.id === user.id);
      setOnDuty(mine ? mine.onDuty : false);
    }).catch(() => {});
  }, [user.id]);
  const value = onDuty;
  if (value === null) return null;
  async function toggle() {
    setBusy(true);
    try {
      const r = await api('/api/clinic/duty/me', { method: 'PUT', body: { onDuty: !value } });
      setOnDuty(r.onDuty);
      setNote(r.warning ? tr(`${r.warning} Hand them over to a nurse on duty.`, `May hawak ka pang ${r.cases} kaso. Hindi ito naipapasa sa pag-off duty. Ipasa sa nars na naka-duty.`) : '');
    } catch (e) { setNote(e.message); } finally { setBusy(false); }
  }
  return (
    <div style={{ marginTop: '.75rem' }}>
      <button type="button" className={`m-duty ${value ? 'is-on' : ''}`} onClick={toggle} disabled={busy} aria-pressed={value}>
        <span className="m-duty-dot" aria-hidden="true" />
        <span className="m-grow"><strong>{value ? tr('On duty', 'Naka-duty') : tr('Off duty', 'Hindi naka-duty')}</strong>
          <span className="m-sub">{value ? tr('Tap when your shift ends. Your cases stay with you until you hand them over.', 'Pindutin kapag tapos na ang shift.') : tr('Tap when your shift starts', 'Pindutin kapag nagsimula ang shift')}</span></span>
      </button>
      {note && <p className="m-caption" role="status" style={{ marginTop: '.4rem', color: 'var(--text-high)' }}>{note}</p>}
    </div>
  );
}

/* ------------------------------ handover card ------------------------------ */
function HandoverCard({ h, mode, onDone }) {
  const tr = useT();
  const [declining, setDeclining] = useState(false);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function act(op, body = {}) {
    setBusy(true);
    setError('');
    try {
      await api(`/api/clinic/handover/${h.id}/${op}`, { method: 'POST', body });
      onDone(op);
    } catch (e) { setError((e.details || [e.message]).join('. ')); setBusy(false); }
  }
  const other = mode === 'incoming' ? h.fromNurse : h.toNurse;
  return (
    <article className="m-card" style={{ marginTop: 0 }}>
      <div className="m-between" style={{ alignItems: 'flex-start' }}>
        <div className="m-grow">
          <Link to={`${base()}/patients/${h.patient.id}`} className="m-link" style={{ padding: 0 }}>{h.patient.name}</Link>
          <span className="m-caption" style={{ display: 'block' }}>{mode === 'incoming' ? tr(`From ${other.name} · ${relTime(h.createdAt)}`, `Mula kay ${other.name} · ${relTime(h.createdAt)}`) : tr(`To ${other.name} · waiting for acceptance`, `Kay ${other.name} · hinihintay ang pagtanggap`)}</span>
        </div>
        {h.priority && <Chip tone={PRIORITY_TONE[h.priority]} icon="alert">{h.priority}</Chip>}
      </div>
      <dl className="m-handover">
        <dt>{tr('Concern', 'Alalahanin')}</dt><dd>{h.concern}</dd>
        <dt>{tr('Action taken', 'Ginawa na')}</dt><dd>{h.actionTaken}</dd>
        <dt>{tr('Still to do', 'Gagawin pa')}</dt><dd><strong>{h.pendingAction}</strong></dd>
        <dt>{tr('Due', 'Takdang oras')}</dt><dd className={h.overdue ? 'is-overdue' : ''}>{when(h.dueTime)}{h.overdue ? tr(' · overdue', ' · lampas na') : ''}</dd>
      </dl>
      {mode === 'incoming' && !declining && (
        <div className="m-grid-2" style={{ marginTop: '.75rem' }}>
          <button type="button" className="m-btn" disabled={busy} onClick={() => setDeclining(true)}>{tr('Decline', 'Tanggihan')}</button>
          <button type="button" className="m-btn is-dark" disabled={busy} onClick={() => act('accept')}><Icon name="check" size={18} />{tr('Accept case', 'Tanggapin')}</button>
        </div>
      )}
      {mode === 'incoming' && declining && (
        <form className="m-stack" style={{ marginTop: '.75rem' }} onSubmit={(e) => { e.preventDefault(); act('decline', { note: reason }); }}>
          <label className="m-field"><span>{tr('Why are you declining?', 'Bakit tinatanggihan?')}</span>
            <textarea rows="2" maxLength={500} minLength={3} required value={reason} onChange={(e) => setReason(e.target.value)} placeholder={tr('e.g. Off duty from 2 PM, ask Carla', 'hal. Off duty mula 2 PM')} autoFocus /></label>
          <div className="m-grid-2">
            <button type="button" className="m-btn" onClick={() => setDeclining(false)}>{tr('Back', 'Bumalik')}</button>
            <button type="submit" className="m-btn is-dark" disabled={busy || reason.trim().length < 3}>{tr('Decline', 'Tanggihan')}</button>
          </div>
          <p className="m-caption">{tr(`The case stays with ${h.fromNurse.name}.`, `Mananatili kay ${h.fromNurse.name} ang kaso.`)}</p>
        </form>
      )}
      {mode === 'outgoing' && (
        <button type="button" className="m-btn is-block" style={{ marginTop: '.75rem' }} disabled={busy} onClick={() => act('cancel')}>{tr('Cancel handover', 'Kanselahin')}</button>
      )}
      {error && <p className="m-error" role="alert">{error}</p>}
    </article>
  );
}

/** Queue tab "Handover": handovers waiting for me (accept / decline) and mine waiting for the other nurse. */
export function PendingHandovers({ data, reload, onMoved }) {
  const tr = useT();
  const [toast, setToast] = useMobileToast();
  if (!data) return <Loader />;
  if (data.error) return <p className="m-error">{data.error}</p>;
  const done = (op) => {
    setToast({ accept: tr('Case accepted. It is now in My cases.', 'Natanggap ang kaso.'), decline: tr('Handover declined. The case stays with the other nurse.', 'Tinanggihan.'), cancel: tr('Handover cancelled. You still hold the case.', 'Kinansela.') }[op]);
    reload();
    if (op === 'accept' && onMoved) onMoved();
  };
  return (
    <>
      {toast}
      <h2 className="m-section-title">{tr('Waiting for you', 'Naghihintay sa iyo')}</h2>
      <div className="m-stack">
        {data.incoming.map((h) => <HandoverCard key={h.id} h={h} mode="incoming" onDone={done} />)}
        {!data.incoming.length && <div className="m-note"><strong>{tr('No handovers waiting', 'Walang naghihintay')}</strong>{tr('When a nurse hands a case to you it appears here. It becomes yours only when you accept it.', 'Lalabas dito ang ipinasang kaso. Magiging iyo lamang ito kapag tinanggap mo.')}</div>}
      </div>
      {data.outgoing.length > 0 && (
        <>
          <h2 className="m-section-title">{tr('Sent by you, not accepted yet', 'Ipinasa mo, hindi pa tinatanggap')}</h2>
          <p className="m-caption" style={{ marginBottom: '.5rem' }}>{tr('You still hold these cases until the other nurse accepts.', 'Sa iyo pa rin ang mga kasong ito hanggang tanggapin.')}</p>
          <div className="m-stack">{data.outgoing.map((h) => <HandoverCard key={h.id} h={h} mode="outgoing" onDone={done} />)}</div>
        </>
      )}
    </>
  );
}

/** Queue tab "My cases": elders whose case I hold. */
export function MyCases({ data, reasonLine }) {
  const tr = useT();
  if (!data) return <Loader />;
  if (data.error) return <p className="m-error">{data.error}</p>;
  return (
    <div className="m-stack">
      {data.cases.map((c) => (
        <Link key={c.patient.id} to={`${base()}/patients/${c.patient.id}`} className="m-list-row">
          <span className={`m-avatar ${toneFor(c.patient.name)}`} aria-hidden="true">{avatar(c.patient.name)}</span>
          <span className="m-grow">
            <strong>{c.patient.name}</strong>
            <span className="m-sub">{c.item ? reasonLine(c.item) : tr('No open case · monitoring as planned', 'Walang bukas na kaso')}</span>
            {c.item && <Chip tone={PRIORITY_TONE[c.item.priority]} icon="alert">{c.item.priority} · {tr('score', 'score')} {c.item.scores.total}</Chip>}
            {c.pendingHandover && <Chip tone="moderate" icon="swap">{tr(`Handing over to ${c.pendingHandover.toNurse.name}`, `Ipinapasa kay ${c.pendingHandover.toNurse.name}`)}</Chip>}
            <span className="m-sub" style={{ marginTop: '.35rem', marginBottom: 0 }}>{[c.careTeam.name, c.monitoringPlan && c.monitoringPlan.name].filter(Boolean).join(' · ')}</span>
          </span>
          <Icon name="chevron" />
        </Link>
      ))}
      {!data.cases.length && <div className="m-note"><strong>{tr('You hold no cases', 'Wala kang hawak na kaso')}</strong>{tr('Cases come to you when the admin assigns an elder to you or when you accept a handover.', 'Darating ang kaso kapag itinalaga o tinanggap mo ang handover.')}</div>}
    </div>
  );
}

/* ------------------------------ patient: care team + chain ------------------------------ */
/** Care-team card on the patient screen: who holds the case, the team, and the handover chain. */
export function CareTeamCard({ user, patientId, care }) {
  const tr = useT();
  if (!care) return null;
  if (care.error) return <section className="m-card"><p className="m-muted">{care.error}</p></section>;
  const mine = care.caseNurse && care.caseNurse.id === user.id;
  const pending = care.handovers.find((h) => h.status === 'pending');
  const STATUS_WORD = { accepted: ['Accepted', 'Tinanggap'], declined: ['Declined', 'Tinanggihan'], cancelled: ['Cancelled', 'Kinansela'], pending: ['Waiting', 'Naghihintay'] };
  return (
    <section className="m-card">
      <div className="m-between"><h2 className="m-card-title" style={{ marginBottom: 0 }}>{tr('Care team', 'Care team')}</h2>{care.monitoringPlan && <Chip tone="info">{care.monitoringPlan.name}</Chip>}</div>
      <p className="m-caption">{care.careTeam ? care.careTeam.name : ''}{care.monitoringPlan ? tr(` · review within ${care.monitoringPlan.reviewWithinHours} h`, ` · suriin sa loob ng ${care.monitoringPlan.reviewWithinHours} oras`) : ''}</p>
      <ul className="m-team">
        {care.members.map((m) => (
          <li key={m.id}>
            <span className={`m-duty-dot ${m.onDuty ? 'is-on' : ''}`} title={m.onDuty ? tr('On duty', 'Naka-duty') : tr('Off duty', 'Hindi naka-duty')} />
            <span className="m-grow">{m.name}{m.id === user.id ? tr(' (you)', ' (ikaw)') : ''}<span className="m-sub">{[m.teamRole === 'lead' ? tr('Team lead', 'Team lead') : null, m.onDuty ? tr('On duty', 'Naka-duty') : tr('Off duty', 'Hindi naka-duty')].filter(Boolean).join(' · ')}</span></span>
            {care.caseNurse && care.caseNurse.id === m.id && <Chip tone="ok" icon="user">{tr('Holds the case', 'May hawak')}</Chip>}
          </li>
        ))}
      </ul>
      {pending && <Banner tone="moderate" icon="swap">{tr(`Handover to ${pending.toNurse.name} is waiting for acceptance. ${pending.fromNurse.name} holds the case until then.`, `Hinihintay ang pagtanggap ni ${pending.toNurse.name}.`)}</Banner>}
      {mine && !pending && <Cta onClick={() => navigate(`${base()}/patients/${patientId}/handover`)}>{tr('Hand over this case', 'Ipasa ang kaso')}</Cta>}
      {care.handovers.length > 0 && (
        <details className="m-chain" style={{ marginTop: '.75rem' }}>
          <summary>{tr(`Handover history (${care.handovers.length})`, `Kasaysayan ng handover (${care.handovers.length})`)}</summary>
          {care.handovers.length > 5 && <p className="m-caption">{tr('Latest 5, newest first', 'Pinakabagong 5')}</p>}
          <ol>
            {care.handovers.slice(0, 5).map((h) => (
              <li key={h.id}>
                <strong>{h.fromNurse.name} → {h.toNurse.name}</strong> · {tr(...STATUS_WORD[h.status])}
                <span className="m-sub">{tr(`Sent ${when(h.createdAt)}`, `Ipinasa ${when(h.createdAt)}`)}{h.respondedAt ? tr(` · answered ${when(h.respondedAt)}`, ` · sinagot ${when(h.respondedAt)}`) : ''}</span>
                <span className="m-sub">{h.pendingAction}{h.responseNote ? ` · “${h.responseNote}”` : ''}</span>
              </li>
            ))}
          </ol>
        </details>
      )}
    </section>
  );
}

/* ------------------------------ handover form ------------------------------ */
const DUE_OPTIONS = [[2, 'In 2 hours', 'Sa loob ng 2 oras'], [4, 'In 4 hours', 'Sa loob ng 4 oras'], [12, 'In 12 hours', 'Sa loob ng 12 oras'], [24, 'Tomorrow', 'Bukas']];

export function HandoverForm({ user, patientId }) {
  const tr = useT();
  const [care, setCare] = useState(null);
  const [item, setItem] = useState(undefined);
  const draft = useRestoredDraft(`handover:${patientId}`);
  const d = draft ? draft.data : {};
  const [to, setTo] = useState(d.to || null);
  const [concern, setConcern] = useState(d.concern || '');
  const [actionTaken, setActionTaken] = useState(d.actionTaken || '');
  const [pendingAction, setPendingAction] = useState(d.pendingAction || '');
  const [dueIn, setDueIn] = useState(d.dueIn || 4);
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState(false);
  // The concern is pre-filled from the queue; only what the nurse wrote is worth keeping as a draft.
  useKeepDraft(`handover:${patientId}`, { to, concern, actionTaken, pendingAction, dueIn }, !done && Boolean(actionTaken.trim() || pendingAction.trim()));
  useEffect(() => {
    api(`/api/clinic/patients/${encodeURIComponent(patientId)}/care`).then(setCare).catch((e) => setCare({ error: e.message }));
    api(`/api/clinic/queue?patientId=${encodeURIComponent(patientId)}`).then((r) => {
      const it = r.items[0] || null;
      setItem(it);
      if (it && !d.concern) setConcern(it.reasons.slice(0, 2).map((x) => x.detail).join('; ').slice(0, 300));
    }).catch(() => setItem(null));
  }, [patientId]);
  const back = `${base()}/patients/${patientId}`;
  if (!care || item === undefined) return <><TopBar title={tr('Hand over case', 'Ipasa ang kaso')} back={back} /><Loader /></>;
  if (care.error) return <><TopBar title={tr('Hand over case', 'Ipasa ang kaso')} back={back} /><p className="m-error">{care.error}</p></>;
  const others = care.members.filter((m) => m.id !== user.id);
  const dueTime = new Date(Date.now() + dueIn * 3600000);
  const ready = to && concern.trim().length >= 3 && actionTaken.trim().length >= 3 && pendingAction.trim().length >= 3;

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api('/api/clinic/handover', { method: 'POST', body: { patientId, toNurseId: to, concern, actionTaken, pendingAction, dueTime: dueTime.toISOString() } });
      setDone(true);
      clearDraft(`handover:${patientId}`);
      navigate(`${base()}?tab=handover`);
    } catch (err) { setError((err.details || [err.message]).join('. ')); setBusy(false); }
  }
  return (
    <>
      <TopBar title={tr('Hand over case', 'Ipasa ang kaso')} back={back} />
      <form className="m-stack" onSubmit={submit}>
        <div className="m-card m-row" style={{ padding: '.875rem 1rem', marginTop: 0 }}>
          <span className={`m-avatar ${toneFor(care.patient.name)}`} aria-hidden="true" style={{ width: '2.5rem', height: '2.5rem', fontSize: '.875rem' }}>{avatar(care.patient.name)}</span>
          <div><strong>{care.patient.name}</strong><p className="m-caption">{care.careTeam.name}{item ? ` · ${item.priority}` : ''}</p></div>
        </div>
        <DraftNotice draft={draft} onDiscard={() => { setTo(null); setActionTaken(''); setPendingAction(''); setDueIn(4); }} />
        <Banner tone="info" icon="swap">{tr('You keep the case until the other nurse accepts it.', 'Sa iyo pa rin ang kaso hanggang tanggapin ito ng ibang nars.')}</Banner>
        <fieldset className="m-fieldset"><legend>{tr('Hand over to', 'Ipasa kay')}</legend>
          <div className="m-stack" style={{ gap: '.5rem' }}>
            {others.map((m) => (
              <button key={m.id} type="button" className={`m-choice ${to === m.id ? 'is-on' : ''}`} aria-pressed={to === m.id} onClick={() => setTo(m.id)}>
                <span className={`m-duty-dot ${m.onDuty ? 'is-on' : ''}`} aria-hidden="true" />
                <span className="m-grow"><strong>{m.name}</strong><span className="m-sub">{m.onDuty ? tr('On duty', 'Naka-duty') : tr('Off duty: may not see it soon', 'Hindi naka-duty')}</span></span>
                {to === m.id && <Icon name="check" size={18} />}
              </button>
            ))}
            {!others.length && <div className="m-note">{tr('There is no other nurse on this care team. Ask the admin to add one.', 'Walang ibang nars sa team.')}</div>}
          </div>
        </fieldset>
        <label className="m-field"><span>{tr('Concern', 'Alalahanin')}</span><textarea rows="2" maxLength={1000} value={concern} onChange={(e) => setConcern(e.target.value)} placeholder={tr('What is worrying about this elder now?', 'Ano ang inaalala?')} /></label>
        <label className="m-field"><span>{tr('Action taken', 'Ginawa na')}</span><textarea rows="2" maxLength={1000} value={actionTaken} onChange={(e) => setActionTaken(e.target.value)} placeholder={tr('e.g. Called the caregiver, advised rest', 'hal. Tinawagan ang tagapag-alaga')} /></label>
        <label className="m-field"><span>{tr('Still to do', 'Gagawin pa')}</span><textarea rows="2" maxLength={1000} value={pendingAction} onChange={(e) => setPendingAction(e.target.value)} placeholder={tr('e.g. Recheck BP at 6 PM and call back', 'hal. Sukatin muli ang BP')} /></label>
        <fieldset className="m-fieldset"><legend>{tr('Due', 'Takdang oras')}</legend>
          <div className="m-pills">{DUE_OPTIONS.map(([h, en, fil]) => <button key={h} type="button" className="m-pill" aria-pressed={dueIn === h} onClick={() => setDueIn(h)}>{tr(en, fil)}</button>)}</div>
          <p className="m-caption" style={{ marginTop: '.4rem' }}>{manilaDay(dueTime) === manilaDay() ? tr(`Today ${clock(dueTime)}`, `Ngayon ${clock(dueTime)}`) : when(dueTime)}</p>
        </fieldset>
        {error && <p className="m-error" role="alert">{error}</p>}
        <Cta type="submit" disabled={busy || !ready}>{busy ? tr('Sending…', 'Ipinapadala…') : tr('Send handover', 'Ipadala')}</Cta>
      </form>
    </>
  );
}

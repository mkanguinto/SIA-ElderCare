// Contacting the clinic, with proof. Family members and caregivers pick why they are contacting the clinic, then
// call the clinic number or send a message (optionally "please call me back"). Every contact gets a reference
// (CR-000012) and a timeline: sent -> clinic phone notified by SMS -> seen by a nurse -> the nurse's reply.
// A call started here is recorded as "call started": the app cannot tell whether it connected.
// Nurses answer in Messages (/m/nurse/messages).
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { relTime } from '../format';
import { Link } from '../router';
import Icon from './icons';
import { TopBar, Chip, Banner, Loader, useT, clock, isToday } from './kit';

const STATUS = {
  sent: ['moderate', 'clock', 'Sent, not seen yet', 'Naipadala, hindi pa nakikita'],
  seen: ['info', 'check', 'Seen by a nurse', 'Nakita ng nars'],
  answered: ['ok', 'check', 'Answered', 'Sinagot'],
  closed: ['ok', 'check', 'Closed', 'Sarado'],
};
// What the SMS notice to the clinic phone did. Simulated / failed / not set up are never shown as sent.
const NOTICE = {
  delivered: 'delivered to the clinic phone',
  sent: 'sent to the clinic phone (no delivery report yet)',
  queued: 'waiting to be sent to the clinic phone',
  simulated: 'NOT sent to the clinic phone (SMS is simulated)',
  failed: 'NOT sent to the clinic phone (SMS failed)',
  not_configured: 'NOT sent (the clinic phone number is not set up)',
  unknown: 'delivery to the clinic phone is unknown',
};
const at = (ts) => (isToday(ts) ? clock(ts) : `${relTime(ts)}, ${clock(ts)}`);

function useClinicInfo() {
  const [info, setInfo] = useState(null);
  useEffect(() => { api('/api/clinic/contact-info').then(setInfo).catch(() => setInfo({ phone: null, reasons: [] })); }, []);
  return info;
}

/** One line per step, in words, for the family and the nurse. */
function stepText(e, mine) {
  const who = mine && e.actor.id === mine ? 'You' : e.actor.name || e.actor.id;
  switch (e.event) {
    case 'requested': return `${who} sent a message${e.details.callback ? ' asking for a call back' : ''}`;
    case 'call_started': return `${who} started a call to the clinic from the app (the app cannot tell if it connected)`;
    case 'clinic_notified': return `SMS notice ${NOTICE[e.details.delivery] || e.details.delivery}${e.details.note && ['simulated', 'failed'].includes(e.details.delivery) ? `: ${e.details.note}` : ''}`;
    case 'seen': return `Seen by ${who}`;
    case 'answered': return `${who} replied: "${e.details.reply}"`;
    case 'closed': return `Closed by ${who}: "${e.details.note}"`;
    default: return e.event;
  }
}

export function ContactTimeline({ r, mine }) {
  return (
    <ol className="m-contact-steps">
      {(r.events || []).map((e, i) => {
        const bad = e.event === 'clinic_notified' && ['simulated', 'failed', 'not_configured'].includes(e.details.delivery);
        return <li key={i} className={bad ? 'is-bad' : ''}><span className="m-caption">{at(e.at)}</span><span>{stepText(e, mine)}</span></li>;
      })}
    </ol>
  );
}

export function ContactCard({ r, mine, children }) {
  const tr = useT();
  const [tone, icon, en, fil] = STATUS[r.status];
  return (
    <article className="m-card" style={{ marginTop: 0 }}>
      <div className="m-between" style={{ alignItems: 'flex-start' }}>
        <div className="m-grow">
          <strong style={{ display: 'block' }}>{r.reasonLabel}</strong>
          <span className="m-caption">{r.id} · {r.channel === 'call' ? tr('Call', 'Tawag') : tr('Message', 'Mensahe')} · {at(r.createdAt)}</span>
        </div>
        <Chip tone={tone} icon={icon}>{tr(en, fil)}</Chip>
      </div>
      {r.message && <p style={{ marginTop: '.4rem' }}>“{r.message}”</p>}
      {r.reply && <div className="m-note" style={{ marginTop: '.5rem' }}><strong>{r.reply.by.name}</strong>{r.reply.text}</div>}
      <ContactTimeline r={r} mine={mine} />
      {children}
    </article>
  );
}

/** Family / caregiver: call or message the clinic, and see every earlier contact with its proof. */
export function ContactClinic({ user, patients, back }) {
  const tr = useT();
  const info = useClinicInfo();
  const [patientId, setPatientId] = useState(() => new URLSearchParams(window.location.search).get('patient') || patients[0].id);
  const [reason, setReason] = useState(null);
  const [message, setMessage] = useState('');
  const [callback, setCallback] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [list, setList] = useState(null);
  const load = useCallback(() => api(`/api/patients/${patientId}/clinic-contact`).then((r) => setList(r.requests)).catch((e) => setList({ error: e.message })), [patientId]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);

  async function send(channel) {
    setBusy(true);
    setError('');
    try {
      const r = await api(`/api/patients/${patientId}/clinic-contact`, { method: 'POST', body: { channel, reason, message: message.trim() || undefined, callback: channel === 'message' && callback } });
      setDone(r.request);
      setMessage('');
      setReason(null);
      load();
      if (channel === 'call' && info && info.tel) window.location.href = `tel:${info.tel}`;
    } catch (e) { setError((e.details || [e.message]).join('. ')); } finally { setBusy(false); }
  }

  if (!info) return <><TopBar title={tr('Contact the clinic', 'Makipag-ugnayan sa klinika')} back={back} /><Loader /></>;
  return (
    <>
      <TopBar title={tr('Contact the clinic', 'Makipag-ugnayan sa klinika')} back={back} />
      <section className="m-card" style={{ marginTop: 0 }}>
        <p className="m-eyebrow">{info.name}</p>
        {info.phone
          ? <p style={{ fontSize: '1.75rem', fontWeight: 800, letterSpacing: '.02em', margin: '.2rem 0' }}><a href={`tel:${info.tel}`} style={{ color: 'inherit', textDecoration: 'none' }}>{info.phone}</a></p>
          : <p className="m-muted" style={{ margin: '.3rem 0' }}>{tr('The clinic phone number is not set up yet. Send a message: the nurses see it in their app.', 'Wala pang numero ng klinika. Magpadala ng mensahe.')}</p>}
        <p className="m-caption">{info.hours} · {tr('For an emergency call 911.', 'Kung emergency, tumawag sa 911.')}</p>
      </section>

      {done && (
        <Banner tone="ok" icon="check" role="status">
          {tr(`Recorded as ${done.id} at ${clock(done.createdAt)}.`, `Naitala bilang ${done.id}.`)} {done.channel === 'call' ? tr('Your call was logged as started.', 'Naitala ang tawag.') : tr('A nurse will see it in the clinic app.', 'Makikita ito ng nars.')}
          {done.clinicNotice && <span className="m-sub">{tr('SMS notice', 'SMS')} {NOTICE[done.clinicNotice.delivery] || done.clinicNotice.delivery}.</span>}
        </Banner>
      )}

      <h2 className="m-section-title">{tr('What is it about?', 'Tungkol saan?')}</h2>
      {patients.length > 1 && (
        <div className="m-pills" role="radiogroup" aria-label={tr('Elder', 'Pasyente')} style={{ marginBottom: '.75rem' }}>
          {patients.map((p) => <button key={p.id} type="button" className="m-pill" role="radio" aria-checked={p.id === patientId} aria-pressed={p.id === patientId} onClick={() => setPatientId(p.id)}>{p.name}</button>)}
        </div>
      )}
      <div className="m-pills" role="radiogroup" aria-label={tr('Reason', 'Dahilan')}>
        {info.reasons.map((x) => <button key={x.key} type="button" className="m-pill" role="radio" aria-checked={reason === x.key} aria-pressed={reason === x.key} onClick={() => setReason(x.key)}>{x.label}</button>)}
      </div>
      <label className="m-field" style={{ marginTop: '.75rem' }}><span>{tr('Message (optional)', 'Mensahe (opsyonal)')}</span>
        <textarea rows="3" maxLength={1000} value={message} onChange={(e) => setMessage(e.target.value)} placeholder={tr('e.g. Lola felt dizzy after lunch. When should we recheck her BP?', 'hal. Nahilo si Lola pagkatapos kumain.')} /></label>
      <label className={`m-check ${callback ? 'is-on' : ''}`} style={{ marginTop: '.5rem' }}>
        <input type="checkbox" checked={callback} onChange={() => setCallback(!callback)} />
        <span className="m-grow"><strong>{tr('Please call me back', 'Pakitawagan ako')}</strong></span>
        <span className="m-box" aria-hidden="true"><Icon name="check" size={18} strokeWidth={3} /></span>
      </label>
      {error && <p className="m-error" role="alert">{error}</p>}
      <div className="m-grid-2" style={{ marginTop: '.75rem' }}>
        <button type="button" className="m-btn" disabled={busy || !reason || !info.phone} onClick={() => send('call')} title={info.phone ? undefined : 'No clinic number yet'}><Icon name="phone" size={18} />{tr('Call now', 'Tumawag')}</button>
        <button type="button" className="m-btn is-dark" disabled={busy || !reason} onClick={() => send('message')}><Icon name="message" size={18} />{busy ? tr('Sending…', 'Ipinapadala…') : tr('Send message', 'Ipadala')}</button>
      </div>
      {!reason && <p className="m-caption" style={{ marginTop: '.4rem' }}>{tr('Choose a reason first.', 'Pumili muna ng dahilan.')}</p>}

      <h2 className="m-section-title">{tr('Your contacts with the clinic', 'Mga pakikipag-ugnayan')}</h2>
      {!list && <Loader />}
      {list && list.error && <p className="m-error">{list.error}</p>}
      {Array.isArray(list) && !list.length && <div className="m-note">{tr('None yet.', 'Wala pa.')}</div>}
      {Array.isArray(list) && <div className="m-stack">{list.map((r) => <ContactCard key={r.id} r={r} mine={user.id} />)}</div>}
    </>
  );
}

/** Nurse: messages and calls from families and caregivers. Mark seen, reply, or close with a note. */
export function ClinicMessages({ user }) {
  const tr = useT();
  const [all, setAll] = useState(false);
  const [data, setData] = useState(null);
  const load = useCallback(() => api(`/api/clinic/contact-requests${all ? '?status=all' : ''}`).then(setData).catch((e) => setData({ error: e.message })), [all]);
  useEffect(() => {
    load();
    const t = setInterval(load, 15000);
    return () => clearInterval(t);
  }, [load]);
  return (
    <>
      <TopBar title={tr('Messages from families', 'Mga mensahe')} back={window.location.pathname.startsWith('/clinic') ? '/clinic' : '/m/nurse'} />
      <div className="m-seg" role="group" aria-label={tr('Show', 'Ipakita')}>
        <button type="button" aria-pressed={!all} onClick={() => setAll(false)}>{tr('Open', 'Bukas')}{data && typeof data.open === 'number' ? ` (${data.open})` : ''}</button>
        <button type="button" aria-pressed={all} onClick={() => setAll(true)}>{tr('All', 'Lahat')}</button>
      </div>
      {!data && <Loader />}
      {data && data.error && <p className="m-error">{data.error}</p>}
      {data && data.requests && !data.requests.length && <div className="m-note" style={{ marginTop: '1rem' }}>{tr('No open messages.', 'Walang bukas na mensahe.')}</div>}
      {data && data.requests && <div className="m-stack" style={{ marginTop: '1rem' }}>{data.requests.map((r) => <InboxItem key={r.id} r={r} user={user} reload={load} />)}</div>}
    </>
  );
}

function InboxItem({ r, user, reload }) {
  const tr = useT();
  const [mode, setMode] = useState(null); // reply | close
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const step = async (op, body) => {
    setBusy(true);
    setError('');
    try { await api(`/api/clinic/contact-requests/${r.id}/${op}`, { method: 'POST', body }); setMode(null); setText(''); reload(); } catch (e) { setError((e.details || [e.message]).join('. ')); } finally { setBusy(false); }
  };
  const open = ['sent', 'seen'].includes(r.status);
  return (
    <ContactCard r={r} mine={user.id}>
      <p className="m-caption" style={{ marginTop: '.3rem' }}>
        {r.patient.name} · {r.from.name} ({r.from.role === 'caregiver' ? tr('caregiver', 'tagapag-alaga') : tr('family', 'pamilya')}){r.callback ? ` · ${tr('wants a call back', 'gustong tawagan')}` : ''}{r.caseNurse ? ` · ${tr('case nurse', 'nars')} ${r.caseNurse.name}` : ''}
      </p>
      {error && <p className="m-error" role="alert">{error}</p>}
      {open && !mode && (
        <div className="m-grid-2" style={{ marginTop: '.6rem' }}>
          {r.status === 'sent'
            ? <button type="button" className="m-btn" disabled={busy} onClick={() => step('seen')}><Icon name="eye" size={18} />{tr('Mark seen', 'Nakita')}</button>
            : <button type="button" className="m-btn" disabled={busy} onClick={() => setMode('close')}>{tr('Close with a note', 'Isara')}</button>}
          <button type="button" className="m-btn is-dark" disabled={busy} onClick={() => setMode('reply')}><Icon name="message" size={18} />{tr('Reply', 'Sumagot')}</button>
        </div>
      )}
      {mode && (
        <form className="m-stack" style={{ marginTop: '.6rem' }} onSubmit={(e) => { e.preventDefault(); step(mode, mode === 'reply' ? { reply: text } : { note: text }); }}>
          <label className="m-field"><span>{mode === 'reply' ? tr('Reply (the family sees it)', 'Sagot') : tr('Note (e.g. Called back, all fine)', 'Tala')}</span>
            <textarea rows="2" maxLength={1000} value={text} onChange={(e) => setText(e.target.value)} autoFocus /></label>
          <div className="m-grid-2">
            <button type="button" className="m-btn" onClick={() => { setMode(null); setText(''); }}>{tr('Cancel', 'Kanselahin')}</button>
            <button className="m-btn is-dark" disabled={busy || text.trim().length < 3}>{busy ? tr('Saving…', 'Sine-save…') : mode === 'reply' ? tr('Send reply', 'Ipadala') : tr('Close', 'Isara')}</button>
          </div>
        </form>
      )}
    </ContactCard>
  );
}

/** Small "N new messages from families" link for the nurse queue. */
export function MessagesBanner() {
  const tr = useT();
  const [n, setN] = useState(null);
  useEffect(() => {
    const load = () => api('/api/clinic/contact-requests').then((d) => setN(d)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  if (!n || !n.open) return null;
  return (
    <Link to={window.location.pathname.startsWith('/clinic') ? '/clinic/messages' : '/m/nurse/messages'} style={{ textDecoration: 'none', display: 'block', marginBottom: '.75rem' }}>
      <Banner tone={n.unseen ? 'warning' : 'info'} icon="message">
        <strong>{n.unseen ? tr(`${n.unseen} new message${n.unseen === 1 ? '' : 's'} from families`, `${n.unseen} bagong mensahe`) : tr(`${n.open} open message${n.open === 1 ? '' : 's'} from families`, `${n.open} bukas na mensahe`)}</strong> · {tr('Open Messages', 'Buksan')}
      </Banner>
    </Link>
  );
}

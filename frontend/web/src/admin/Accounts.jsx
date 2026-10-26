// Admin: accounts and the account audit log (Batch 3a). The admin creates accounts and sends activation codes
// and password-reset links, which go only to the user's phone by SMS - the admin never sees a code, a link or a
// password. Every action here is written to the audit log with who did it and when.
// SMS status is shown as it is: a simulated message is "NOT sent", and only a delivery report from the network
// counts as "Delivered". Nurse and admin accounts belong to a staff identity (ST-001): one person who is both
// admin and nurse has two separate accounts with the same staff ID.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ROLE_LABEL, initials, relTime } from '../format';
import { Chip, toneFor } from '../mobile/kit';
import Icon from '../mobile/icons';

const ROLE_NAME = { caregiver: 'Caregiver', family_member: 'Family (view only)', clinic_staff: 'Nurse', system_admin: 'Health center admin' };
const STATUS_CHIP = { active: ['ok', 'check', 'Active'], pending_activation: ['moderate', 'clock', 'Waiting for activation'], disabled: ['critical', 'x', 'Disabled'] };
const ACTION_LABEL = {
  account_created: 'Account created', activation_code_sent: 'Activation code sent', account_activated: 'Account activated', activation_failed: 'Activation failed',
  password_reset_sent: 'Password-reset code sent', password_reset_completed: 'Password changed (reset code)', password_reset_failed: 'Password reset failed',
  sms_delivery_update: 'SMS delivery update',
  account_disabled: 'Account disabled', account_enabled: 'Account enabled', login: 'Signed in', login_failed: 'Sign-in failed', logout: 'Signed out',
  session_locked: 'Locked (inactivity)', session_unlocked: 'Unlocked', session_revoked: 'Session ended by admin', sessions_revoked_all: 'Signed out everywhere by admin',
  patients_linked: 'Elders linked',
};
// Audit chips: what went well (green), what needs a look (orange), the rest (blue).
const actionTone = (a) => (/failed|locked|disabled|revoked/.test(a) ? 'high' : /^(login|account_activated|account_enabled|password_reset_completed|session_unlocked|account_created)$/.test(a) ? 'ok' : 'info');
const when = (ts) => new Date(ts).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

// Only 'delivered' is shown as received. simulated / failed say plainly that nothing reached the person.
const DELIVERY = {
  simulated: ['critical', 'x', 'NOT sent (simulated)'],
  failed: ['critical', 'x', 'NOT sent (failed)'],
  queued: ['moderate', 'clock', 'Waiting for the SMS phone'],
  sent: ['info', 'message', 'Sent, not confirmed'],
  delivered: ['ok', 'check', 'Reported delivered'],
  unknown: ['moderate', 'alert', 'Delivery unknown'],
};
const FOLLOW = ['queued', 'sent', 'unknown'];
const WHAT = { activation: 'activation code', password_reset: 'password-reset code' };

/** One sentence about a code or link: where it went and what is known about its delivery. */
function smsText(s, name) {
  const what = WHAT[s.purpose] || 'message';
  const until = s.expiresAt ? ` It works until ${when(s.expiresAt)}.` : '';
  switch (s.delivery) {
    case 'simulated': return `The ${what} was NOT sent: SMS is simulated (${s.note || 'dry-run'}). ${name} will not receive it.`;
    case 'failed': return `The ${what} was NOT sent: ${s.note || 'the SMS failed'}. Fix the problem, then send a new one.`;
    case 'queued': {
      // TextBee hands each text to the Android phone running its app; an offline or sleeping phone holds it.
      const mins = s.sentAt ? Math.round((Date.now() - new Date(s.sentAt)) / 60000) : 0;
      return `The ${what} for ${s.sentTo} is waiting for the clinic's SMS phone to send it. Not delivered yet.${mins >= 2
        ? ` It has waited ${mins} minutes: the SMS phone is probably offline or asleep. Open the TextBee app on it (charging, battery saver off), then use Resend if it still does not go.`
        : ''}${until}`;
    }
    case 'sent': return `The ${what} left the clinic's SMS phone for ${s.sentTo}${s.deliveryUpdatedAt ? ` at ${when(s.deliveryUpdatedAt)}` : ''}. No delivery report yet, so ask ${name} whether it arrived.${until}`;
    // The network's report can say delivered even when a filter dropped the text: only the person using the code proves it arrived.
    case 'delivered': return `The SMS phone reports the ${what} delivered to ${s.sentTo}${s.deliveryUpdatedAt ? ` (${when(s.deliveryUpdatedAt)})` : ''}. It is confirmed only when ${name} uses it.${until}`;
    default: return `Delivery of the ${what} to ${s.sentTo} is unknown. Ask ${name} whether it arrived.${until}`;
  }
}
const smsTone = (s) => (s.delivery === 'delivered' ? 'ok' : ['simulated', 'failed'].includes(s.delivery) ? 'critical' : 'info');

/** lead: a team-lead nurse in the nurse console - caregiver and family accounts only, no session controls. */
export function Accounts({ Head, lead = false }) {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [tracking, setTracking] = useState(null); // { accountId, name, first }
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('all');
  const load = useCallback(() => api('/api/admin/accounts').then(setData).catch((e) => setData({ error: e.message })), []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, text) => {
    setMsg(null);
    try {
      const r = await fn();
      if (text) setMsg({ tone: 'ok', text: typeof text === 'function' ? text(r) : text });
      await load();
      return r;
    } catch (e) { setMsg({ tone: 'critical', text: e.message }); return null; }
  };
  /** After sending a code or link: show what happened and keep following the SMS until it is final. */
  const sent = (account, s) => setTracking({ accountId: account.id, name: account.name, first: s });
  const rows = data && data.accounts ? data.accounts.filter((a) => filter === 'all' || a.status === filter) : [];
  const others = (a) => (a.staffId && data.staff ? (data.staff.find((p) => p.staffId === a.staffId) || { accounts: [] }).accounts.filter((x) => x.id !== a.id) : []);
  return (
    <>
      <Head title="Accounts" sub={lead ? 'Create caregiver and family accounts and send their activation codes by SMS. You never see a code or password; every action is in the audit log.'
        : 'Create accounts and send activation and password-reset codes by SMS. You never see a code or password; every action is in the audit log.'} />
      <SmsCheck />
      {msg && <p className={`m-banner tone-${msg.tone}`} role={msg.tone === 'critical' ? 'alert' : 'status'} style={{ marginBottom: '1rem' }}>{msg.text}</p>}
      {tracking && <DeliveryTracker key={`${tracking.accountId}-${tracking.first.sentAt}`} t={tracking} onFinal={load} onClose={() => setTracking(null)} />}
      <NewAccount lead={lead} staff={(data && data.staff) || []} onCreate={async (body) => {
        const r = await run(() => api('/api/admin/accounts', { method: 'POST', body }), (x) => `${x.account.name} (${x.account.username}${x.account.staffId ? `, staff ${x.account.staffId}` : ''}) created.`);
        if (r) sent(r.account, r.activation);
        return Boolean(r);
      }} />
      <section className="ad-panel">
        <div className="m-between">
          <h2>All accounts{data && data.total ? ` (${data.total})` : ''}</h2>
          <div className="m-seg ad-seg" role="group" aria-label="Show">
            {[['all', 'All'], ['pending_activation', 'Waiting'], ['active', 'Active'], ['disabled', 'Disabled']].map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
        </div>
        {!data && <p>Loading…</p>}
        {data && data.error && <p className="m-error">{data.error}</p>}
        {data && data.accounts && (
          <table className="ad-table is-boxed">
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Sessions</th><th>Actions</th></tr></thead>
            <tbody>
              {rows.map((a) => {
                const label = ROLE_NAME[a.role] || ROLE_LABEL[a.role];
                const [st, si, sl] = STATUS_CHIP[a.status];
                const linked = others(a);
                const dv = a.activation && DELIVERY[a.activation.delivery];
                return (
                  <React.Fragment key={a.id}>
                    <tr>
                      <td><div className="ad-user"><span className={`m-avatar ${toneFor(a.name)}`} aria-hidden="true">{initials(a.name)}</span><div><strong>{a.name}</strong>
                        <span className="m-sub">{a.username} · {a.id}{a.staffId ? ` · staff ${a.staffId}` : ''}{a.phone ? ` · ${a.phone}` : ''}</span>
                        {linked.length > 0 && <span className="m-sub">Same person: {linked.map((x) => `${x.username} (${x.role === 'system_admin' ? 'admin' : 'nurse'})`).join(', ')}</span>}</div></div></td>
                      <td>{label}{a.patients.length > 0 && <span className="m-sub">{a.patients.join(' · ')}</span>}</td>
                      <td><Chip tone={st} icon={si}>{sl}</Chip>
                        {a.activation && <span className="m-sub">Code {a.activation.state === 'ok' ? `valid until ${when(a.activation.expiresAt)}` : a.activation.state}</span>}
                        {dv && <span className="m-sub"><Chip tone={dv[0]} icon={dv[1]}>{dv[2]}</Chip></span>}
                        {a.disabledReason && <span className="m-sub">{a.disabledReason}</span>}</td>
                      <td>{a.lastLoginAt ? relTime(a.lastLoginAt) : '—'}</td>
                      <td>{a.sessions}</td>
                      <td><button type="button" className="m-link" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Close' : 'Manage'}</button></td>
                    </tr>
                    {open === a.id && <tr><td colSpan={6}><Manage a={a} run={run} sent={sent} lead={lead} /></td></tr>}
                  </React.Fragment>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    </>
  );
}

/** Is real SMS ready? Says plainly when codes would not reach anyone. */
function SmsCheck() {
  const [c, setC] = useState(null);
  const check = useCallback(() => { setC(null); api('/api/admin/sms-check').then(setC).catch((e) => setC({ ready: false, problems: [e.message] })); }, []);
  useEffect(() => { check(); }, [check]);
  const d = c && c.gateway && c.gateway.device;
  // The phone reports in while the TextBee app runs; a long silence means texts will wait in the queue.
  const silentMin = d && d.lastSeenAt ? Math.round((Date.now() - new Date(d.lastSeenAt)) / 60000) : null;
  const asleep = c && c.ready && silentMin !== null && silentMin > 30;
  const tone = !c ? 'info' : c.ready && !asleep ? 'ok' : c.ready ? 'moderate' : 'high';
  return (
    <section className={`m-banner tone-${tone} ad-sms`} aria-live="polite">
      <Icon name={c && c.ready ? 'checkCircle' : 'alert'} />
      <div className="m-grow">
        <strong>{!c ? 'Checking SMS…' : c.ready ? 'SMS is live: codes and links are really sent' : 'SMS is NOT ready: codes and links may not reach anyone'}</strong>
        {c && c.problems && c.problems.map((p) => <p key={p}>{p}</p>)}
        {asleep && <p><strong>The SMS phone has not been online for {silentMin >= 90 ? `${Math.round(silentMin / 60)} hours` : `${silentMin} minutes`}.</strong> New codes will wait until it is: open the TextBee app on it (keep it charging, battery saver off) before creating accounts.</p>}
        {c && c.mode && (
          <p className="ad-sms-detail">
            {c.mode.reason}{c.mode.live && c.mode.allowlistSize ? ' (other numbers are simulated, not sent)' : ''}
            {d ? ` · SMS phone ${d.model || ''} ${d.enabled ? 'enabled' : 'disabled'}, last online ${d.lastSeenAt ? relTime(d.lastSeenAt) : 'unknown'}` : ''}
            {typeof c.sentToday === 'number' ? ` · ${c.sentToday} of ${c.dailyLimit} texts used today` : ''}
          </p>
        )}
      </div>
      <button type="button" className="m-btn ad-btn-auto" onClick={check}>Check again</button>
    </section>
  );
}

/** Follows a code or link after it was sent, until it is delivered, failed, or 3 minutes pass. */
function DeliveryTracker({ t, onFinal, onClose }) {
  const [s, setS] = useState(t.first);
  const [tries, setTries] = useState(0);
  const following = FOLLOW.includes(s.delivery) && tries < 36;
  useEffect(() => {
    if (!following) return undefined;
    const timer = setTimeout(async () => {
      try {
        const r = await api(`/api/admin/accounts/${t.accountId}/messages`);
        const next = r[s.purpose === 'password_reset' ? 'passwordReset' : 'activation'];
        if (next) { setS(next); if (!FOLLOW.includes(next.delivery)) onFinal(); }
      } catch { /* try again on the next tick */ }
      setTries((n) => n + 1);
    }, 5000);
    return () => clearTimeout(timer);
  }, [following, tries, s.purpose, t.accountId, onFinal]);
  const [tone, icon, label] = DELIVERY[s.delivery] || DELIVERY.unknown;
  return (
    <div className={`m-banner tone-${smsTone(s)}`} role={smsTone(s) === 'critical' ? 'alert' : 'status'} style={{ marginBottom: '1rem', display: 'block' }}>
      <div className="m-between"><Chip tone={tone} icon={icon}>{label}</Chip><button type="button" className="m-link" onClick={onClose}>Dismiss</button></div>
      <p style={{ margin: '.4rem 0 0' }}>{smsText(s, t.name)}</p>
      {following && <p className="m-caption">Checking with the SMS provider every 5 seconds…</p>}
    </div>
  );
}

function Manage({ a, run, sent, lead }) {
  const [sessions, setSessions] = useState(null);
  const [reason, setReason] = useState('');
  // Sessions are the admin's (a team lead looks after codes, resets and disabling).
  const loadSessions = useCallback(() => (lead ? Promise.resolve() : api(`/api/admin/accounts/${a.id}/sessions`).then((r) => setSessions(r.sessions)).catch(() => setSessions([]))), [a.id, lead]);
  useEffect(() => { loadSessions(); }, [loadSessions]);
  const post = (path, body) => api(`/api/admin/accounts/${a.id}/${path}`, { method: 'POST', body });
  const send = async (path, key) => { const r = await run(() => post(path)); if (r) sent(a, r[key]); };
  return (
    <div className="ad-manage">
      <div className="ad-inline-form" style={{ marginTop: 0 }}>
        {a.status === 'pending_activation' && <button type="button" className="m-btn" onClick={() => send('activation-code', 'activation')}>Send a new activation code</button>}
        {a.status === 'active' && <button type="button" className="m-btn" onClick={() => window.confirm(`Send ${a.name} a password-reset code by SMS?`) && send('password-reset', 'passwordReset')}>Send password-reset code</button>}
        {a.status === 'disabled'
          ? <button type="button" className="m-btn" onClick={() => run(() => post('enable'), `${a.name} enabled`)}>Enable account</button>
          : (
            <>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for disabling (required)" aria-label="Reason for disabling" />
              <button type="button" className="m-btn" disabled={reason.trim().length < 3} onClick={() => run(() => post('disable', { reason }), `${a.name} disabled and signed out everywhere`)}>Disable</button>
            </>
          )}
      </div>
      {!lead && <h3 style={{ fontSize: '.9375rem', margin: '1rem 0 .25rem' }}>Active sessions</h3>}
      {!lead && !sessions && <p className="m-caption">Loading…</p>}
      {sessions && !sessions.length && <p className="m-caption">Not signed in anywhere.</p>}
      {sessions && sessions.length > 0 && (
        <ul className="ad-members" style={{ margin: '.25rem 0 0' }}>
          {sessions.map((s) => (
            <li key={s.id}>
              <span className="m-grow"><strong>{s.deviceClass === 'phone' ? 'Phone' : 'Computer'}</strong>{s.locked ? ' · locked' : ''}
                <span className="m-sub">Signed in {relTime(s.startedAt)} · last active {relTime(s.lastSeenAt)}{s.userAgent ? ` · ${s.userAgent.slice(0, 60)}` : ''}</span></span>
              <button type="button" className="m-link" onClick={() => run(() => api(`/api/admin/accounts/${a.id}/sessions/${s.id}`, { method: 'DELETE' }), 'Session ended').then(loadSessions)}>End session</button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

const ROLES = [['caregiver', 'Caregiver'], ['clinic_staff', 'Nurse'], ['system_admin', 'Health center admin'], ['family_member', 'Family member (link via verification)']];
const STAFF = ['clinic_staff', 'system_admin'];
function NewAccount({ staff, onCreate, lead }) {
  const blank = { role: 'caregiver', staffId: '', name: '', username: '', phone: '' };
  const [f, setF] = useState(blank);
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  const isStaff = STAFF.includes(f.role);
  // People who could get an account with this role (they do not have one yet).
  const people = isStaff ? staff.filter((p) => !p.accounts.some((x) => x.role === f.role)) : [];
  const person = f.staffId && staff.find((p) => p.staffId === f.staffId);
  return (
    <section className="ad-panel">
      <h2>New account</h2>
      <p className="m-caption">The person gets an SMS with their username and an activation code (valid 24 hours) and chooses their own password. Elders are linked afterwards: caregivers in Care teams → Link &amp; Assignments, family members by a nurse after family verification.
        A nurse who is also an admin gets a second, separate account linked to the same staff ID: separate password and sessions, one person in the audit log.</p>
      <form onSubmit={async (e) => {
        e.preventDefault();
        const ok = await onCreate({
          role: f.role, name: (person ? person.name : f.name).trim(), username: f.username.trim(), phone: f.phone.trim(),
          ...(isStaff && f.staffId ? { staffId: f.staffId } : {}),
        });
        if (ok) setF({ ...blank, role: f.role });
      }}>
        <div className="ad-form-grid">
          <label className="ad-field"><span>Role</span><select value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, staffId: '' })}>{ROLES.filter(([k]) => !lead || !STAFF.includes(k)).map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select></label>
          {isStaff && (
            <label className="ad-field"><span>Staff member</span>
              <select value={f.staffId} onChange={set('staffId')}>
                <option value="">New staff member (new staff ID)</option>
                {people.map((p) => <option key={p.staffId} value={p.staffId}>Same person as {p.name} ({p.staffId}, {p.accounts.map((x) => x.username).join(', ')})</option>)}
              </select></label>
          )}
          <label className="ad-field"><span>Full name</span><input value={person ? person.name : f.name} onChange={set('name')} readOnly={Boolean(person)} minLength={2} required /></label>
          <label className="ad-field"><span>Username</span><input value={f.username} onChange={set('username')} placeholder={f.role === 'system_admin' ? 'admin.ana' : 'caregiver.liza'} pattern="[A-Za-z][A-Za-z0-9._\-]{2,39}" required /></label>
          <label className="ad-field"><span>Mobile number</span><input value={f.phone} onChange={set('phone')} placeholder="0917 123 4567" inputMode="tel" required /></label>
        </div>
        <button type="submit" className="m-btn is-dark ad-btn-auto">Create and send code</button>
      </form>
    </section>
  );
}

export function AuditLog({ Head }) {
  const [data, setData] = useState(null);
  const [action, setAction] = useState('');
  const [staffId, setStaffId] = useState('');
  const [staff, setStaff] = useState([]);
  useEffect(() => { api('/api/admin/accounts').then((r) => setStaff(r.staff || [])).catch(() => {}); }, []);
  useEffect(() => {
    setData(null);
    api(`/api/admin/audit?limit=200${action ? `&action=${action}` : ''}${staffId ? `&staffId=${staffId}` : ''}`).then(setData).catch((e) => setData({ error: e.message }));
  }, [action, staffId]);
  return (
    <>
      <Head title="Audit log" sub="Every account action - creation, activation, sign-ins, password resets, disabling, session changes, SMS delivery - with who did it, when and from where. Codes, links and passwords are never recorded." />
      <section className="ad-panel">
        <div className="m-between">
          <h2>Account actions</h2>
          <div className="m-row" style={{ gap: '.5rem', flexWrap: 'wrap' }}>
            <select value={staffId} onChange={(e) => setStaffId(e.target.value)} aria-label="Filter by staff member" className="ad-select">
              <option value="">All people</option>
              {staff.map((p) => <option key={p.staffId} value={p.staffId}>{p.name} ({p.staffId}, {p.accounts.length} account{p.accounts.length === 1 ? '' : 's'})</option>)}
            </select>
            <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action" className="ad-select">
              <option value="">All actions</option>
              {Object.entries(ACTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
            </select>
          </div>
        </div>
        {!data && <p>Loading…</p>}
        {data && data.error && <p className="m-error">{data.error}</p>}
        {data && data.entries && (
          <table className="ad-table is-boxed">
            <thead><tr><th>When</th><th>What</th><th>By</th><th>Account</th><th>Details</th></tr></thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td title={new Date(e.at).toISOString()}>{when(e.at)}</td>
                  <td><Chip tone={actionTone(e.action)} icon={actionTone(e.action) === 'ok' ? 'check' : actionTone(e.action) === 'high' ? 'alert' : 'bell'}>{ACTION_LABEL[e.action] || e.action}</Chip></td>
                  <td><strong>{e.actorId}</strong><span className="m-sub">{[e.actorStaffId && `staff ${e.actorStaffId}`, e.actorRole && e.actorRole.replace('_', ' '), e.ip].filter(Boolean).join(' · ')}</span></td>
                  <td>{e.targetId || '—'}{e.targetStaffId && <span className="m-sub">staff {e.targetStaffId}</span>}</td>
                  <td className="ad-details">{Object.entries(e.details || {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        {data && data.entries && !data.entries.length && <p className="m-caption">Nothing yet.</p>}
      </section>
    </>
  );
}

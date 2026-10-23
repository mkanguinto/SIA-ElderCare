// Admin: accounts and the account audit log (Batch 3a). The admin creates accounts and sends activation codes
// and password-reset links, which go only to the user's phone by SMS - the admin never sees a code, a link or a
// password. Every action here is written to the audit log with who did it and when.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { ROLE_LABEL, initials, relTime } from '../format';
import { Chip, toneFor } from '../mobile/kit';

const ROLE_CHIP = { caregiver: ['ok', 'check', 'Caregiver'], family_member: ['info', 'bell', 'Family (view only)'], clinic_staff: ['ok', 'check', 'Nurse'], system_admin: ['', 'checkCircle', 'System admin'] };
const STATUS_CHIP = { active: ['ok', 'check', 'Active'], pending_activation: ['moderate', 'clock', 'Waiting for activation'], disabled: ['critical', 'x', 'Disabled'] };
const ACTION_LABEL = {
  account_created: 'Account created', activation_code_sent: 'Activation code sent', account_activated: 'Account activated', activation_failed: 'Activation failed',
  password_reset_sent: 'Password-reset link sent', password_reset_completed: 'Password changed (reset link)', password_reset_failed: 'Password reset failed',
  account_disabled: 'Account disabled', account_enabled: 'Account enabled', login: 'Signed in', login_failed: 'Sign-in failed', logout: 'Signed out',
  session_locked: 'Locked (inactivity)', session_unlocked: 'Unlocked', session_revoked: 'Session ended by admin', sessions_revoked_all: 'Signed out everywhere by admin',
  patients_linked: 'Elders linked',
};
const when = (ts) => new Date(ts).toLocaleString('en-PH', { timeZone: 'Asia/Manila', month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

export function Accounts({ Head }) {
  const [data, setData] = useState(null);
  const [msg, setMsg] = useState(null);
  const [open, setOpen] = useState(null);
  const [filter, setFilter] = useState('all');
  const load = useCallback(() => api('/api/admin/accounts').then(setData).catch((e) => setData({ error: e.message })), []);
  useEffect(() => { load(); }, [load]);
  const run = async (fn, text) => {
    setMsg(null);
    try { const r = await fn(); setMsg({ tone: 'ok', text: typeof text === 'function' ? text(r) : text }); await load(); } catch (e) { setMsg({ tone: 'critical', text: e.message }); }
  };
  const sms = (s) => `${s.delivery === 'sent' ? 'Sent' : s.delivery === 'simulated' ? 'Simulated (SMS dry-run / number not allow-listed)' : 'NOT sent'} to ${s.sentTo}, valid until ${when(s.expiresAt)}.`;
  const rows = data && data.accounts ? data.accounts.filter((a) => filter === 'all' || a.status === filter) : [];
  return (
    <>
      <Head title="Accounts" sub="Create accounts and send activation codes and password-reset links by SMS. You never see a code, link or password; every action is in the audit log." />
      {msg && <p className={`m-banner tone-${msg.tone}`} role={msg.tone === 'critical' ? 'alert' : 'status'} style={{ marginBottom: '1rem' }}>{msg.text}</p>}
      <NewAccount onCreate={(body) => run(() => api('/api/admin/accounts', { method: 'POST', body }), (r) => `${r.account.name} (${r.account.username}) created. Activation code: ${sms(r.activation)}`)} />
      <section className="ad-panel">
        <div className="m-between">
          <h2>All accounts{data && data.total ? ` (${data.total})` : ''}</h2>
          <div className="m-seg" role="group" aria-label="Show" style={{ width: '30rem', maxWidth: '100%' }}>
            {[['all', 'All'], ['pending_activation', 'Waiting'], ['active', 'Active'], ['disabled', 'Disabled']].map(([k, l]) => <button key={k} type="button" aria-pressed={filter === k} onClick={() => setFilter(k)}>{l}</button>)}
          </div>
        </div>
        {!data && <p>Loading…</p>}
        {data && data.error && <p className="m-error">{data.error}</p>}
        {data && data.accounts && (
          <table className="ad-table">
            <thead><tr><th>Name</th><th>Role</th><th>Status</th><th>Last sign-in</th><th>Sessions</th><th><span className="m-sr">Actions</span></th></tr></thead>
            <tbody>
              {rows.map((a) => {
                const [tone, icon, label] = ROLE_CHIP[a.role] || ['', 'user', ROLE_LABEL[a.role]];
                const [st, si, sl] = STATUS_CHIP[a.status];
                return (
                  <React.Fragment key={a.id}>
                    <tr>
                      <td><div className="ad-user"><span className={`m-avatar ${toneFor(a.name)}`} aria-hidden="true">{initials(a.name)}</span><div><strong>{a.name}</strong><span className="m-sub">{a.username} · {a.id}{a.phone ? ` · ${a.phone}` : ''}</span></div></div></td>
                      <td><Chip tone={tone} icon={icon}>{label}</Chip>{a.patients.length > 0 && <span className="m-sub">{a.patients.join(' · ')}</span>}</td>
                      <td><Chip tone={st} icon={si}>{sl}</Chip>
                        {a.activation && <span className="m-sub">Code {a.activation.state === 'ok' ? `valid until ${when(a.activation.expiresAt)}` : a.activation.state}{a.activation.delivery === 'failed' ? ' · SMS failed' : ''}</span>}
                        {a.disabledReason && <span className="m-sub">{a.disabledReason}</span>}</td>
                      <td>{a.lastLoginAt ? relTime(a.lastLoginAt) : '—'}</td>
                      <td>{a.sessions}</td>
                      <td><button type="button" className="m-link" aria-expanded={open === a.id} onClick={() => setOpen(open === a.id ? null : a.id)}>{open === a.id ? 'Close' : 'Manage'}</button></td>
                    </tr>
                    {open === a.id && <tr><td colSpan={6}><Manage a={a} run={run} sms={sms} /></td></tr>}
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

function Manage({ a, run, sms }) {
  const [sessions, setSessions] = useState(null);
  const [reason, setReason] = useState('');
  const loadSessions = useCallback(() => api(`/api/admin/accounts/${a.id}/sessions`).then((r) => setSessions(r.sessions)).catch(() => setSessions([])), [a.id]);
  useEffect(() => { loadSessions(); }, [loadSessions]);
  const post = (path, body) => api(`/api/admin/accounts/${a.id}/${path}`, { method: 'POST', body });
  return (
    <div className="ad-manage">
      <div className="ad-inline-form" style={{ marginTop: 0 }}>
        {a.status === 'pending_activation' && <button type="button" className="m-btn" onClick={() => run(() => post('activation-code'), (r) => `New activation code for ${a.name}: ${sms(r.activation)} The old code no longer works.`)}>Send a new activation code</button>}
        {a.status === 'active' && <button type="button" className="m-btn" onClick={() => window.confirm(`Send ${a.name} a password-reset link by SMS?`) && run(() => post('password-reset'), (r) => `Password-reset link for ${a.name}: ${sms(r.passwordReset)}`)}>Send password-reset link</button>}
        {a.status === 'disabled'
          ? <button type="button" className="m-btn" onClick={() => run(() => post('enable'), `${a.name} enabled`)}>Enable account</button>
          : (
            <>
              <input value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Reason for disabling (required)" aria-label="Reason for disabling" />
              <button type="button" className="m-btn" disabled={reason.trim().length < 3} onClick={() => run(() => post('disable', { reason }), `${a.name} disabled and signed out everywhere`)}>Disable</button>
            </>
          )}
      </div>
      <h3 style={{ fontSize: '.9375rem', margin: '1rem 0 .25rem' }}>Active sessions</h3>
      {!sessions && <p className="m-caption">Loading…</p>}
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

const ROLES = [['caregiver', 'Caregiver'], ['clinic_staff', 'Nurse'], ['system_admin', 'System admin'], ['family_member', 'Family member (link via verification)']];
function NewAccount({ onCreate }) {
  const [f, setF] = useState({ role: 'caregiver', name: '', username: '', phone: '', patients: '' });
  const set = (k) => (e) => setF({ ...f, [k]: e.target.value });
  return (
    <section className="ad-panel">
      <h2>New account</h2>
      <p className="m-caption">The person gets an SMS with their username and an activation code (valid 24 hours) and chooses their own password. Family members are linked to an elder only after the clinic verifies them.</p>
      <form className="ad-inline-form" onSubmit={(e) => {
        e.preventDefault();
        onCreate({ role: f.role, name: f.name.trim(), username: f.username.trim(), phone: f.phone.trim(), ...(f.role === 'caregiver' && f.patients.trim() ? { patients: f.patients.split(/[\s,]+/).filter(Boolean) } : {}) });
        setF({ ...f, name: '', username: '', phone: '', patients: '' });
      }}>
        <select value={f.role} onChange={set('role')} aria-label="Role">{ROLES.map(([k, l]) => <option key={k} value={k}>{l}</option>)}</select>
        <input value={f.name} onChange={set('name')} placeholder="Full name" aria-label="Full name" minLength={2} required />
        <input value={f.username} onChange={set('username')} placeholder="Username, e.g. caregiver.liza" aria-label="Username" pattern="[A-Za-z][A-Za-z0-9._\-]{2,39}" required />
        <input value={f.phone} onChange={set('phone')} placeholder="Mobile, e.g. 0917 123 4567" aria-label="Mobile number" inputMode="tel" required />
        {f.role === 'caregiver' && <input value={f.patients} onChange={set('patients')} placeholder="Elders (IDs), e.g. P-1003" aria-label="Elder IDs" />}
        <button type="submit" className="m-btn is-dark">Create and send code</button>
      </form>
    </section>
  );
}

export function AuditLog({ Head }) {
  const [data, setData] = useState(null);
  const [action, setAction] = useState('');
  useEffect(() => {
    setData(null);
    api(`/api/admin/audit?limit=200${action ? `&action=${action}` : ''}`).then(setData).catch((e) => setData({ error: e.message }));
  }, [action]);
  return (
    <>
      <Head title="Audit log" sub="Every account action - creation, activation, sign-ins, password resets, disabling, session changes - with who did it, when and from where. Codes, links and passwords are never recorded." />
      <section className="ad-panel">
        <div className="m-between">
          <h2>Account actions</h2>
          <select value={action} onChange={(e) => setAction(e.target.value)} aria-label="Filter by action" className="ad-select">
            <option value="">All actions</option>
            {Object.entries(ACTION_LABEL).map(([k, l]) => <option key={k} value={k}>{l}</option>)}
          </select>
        </div>
        {!data && <p>Loading…</p>}
        {data && data.error && <p className="m-error">{data.error}</p>}
        {data && data.entries && (
          <table className="ad-table">
            <thead><tr><th>When</th><th>What</th><th>By</th><th>Account</th><th>Details</th></tr></thead>
            <tbody>
              {data.entries.map((e) => (
                <tr key={e.id}>
                  <td title={new Date(e.at).toISOString()}>{when(e.at)}</td>
                  <td>{ACTION_LABEL[e.action] || e.action}</td>
                  <td>{e.actorId}<span className="m-sub">{e.actorRole ? e.actorRole.replace('_', ' ') : ''}{e.ip ? ` · ${e.ip}` : ''}</span></td>
                  <td>{e.targetId || '—'}</td>
                  <td className="m-caption">{Object.entries(e.details || {}).filter(([, v]) => v !== null && v !== '' && !(Array.isArray(v) && !v.length)).map(([k, v]) => `${k}: ${Array.isArray(v) ? v.join(', ') : typeof v === 'object' ? JSON.stringify(v) : v}`).join(' · ')}</td>
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

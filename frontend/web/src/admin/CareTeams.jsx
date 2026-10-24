// Admin: care teams, elder <-> team / monitoring plan links, first case nurse, duty overview and the
// assignment log. Technical, not clinical: no vital signs, notes or handover content are shown here, and a
// case that a nurse already holds can move only through a handover the incoming nurse accepts.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { relTime, initials } from '../format';
import Icon from '../mobile/icons';
import { Chip, toneFor } from '../mobile/kit';

const ACTION_LABEL = {
  team_created: 'Care team created', member_added: 'Nurse added to team', member_removed: 'Nurse removed from team',
  patient_assigned: 'Elder linked to team / plan', duty_changed: 'Duty changed', handover_submitted: 'Handover sent',
  handover_accepted: 'Handover accepted', handover_declined: 'Handover declined', handover_cancelled: 'Handover cancelled',
};

function useCareTeams() {
  const [state, setState] = useState({});
  const load = useCallback(() => Promise.all([
    api('/api/clinic/care-teams'),
    api('/api/admin/users').then((r) => r.users),
    api('/api/clinic/duty').then((r) => r.nurses).catch(() => []),
    api('/api/clinic/care-log?limit=40').then((r) => r.entries).catch(() => []),
  ]).then(([data, users, duty, log]) => setState({ data, users, nurses: users.filter((u) => u.role === 'clinic_staff'), duty, log })).catch((e) => setState({ error: e.message })), []);
  useEffect(() => { load(); }, [load]);
  return [state, load];
}

const TABS = [['roster', 'Team Roster & Elders'], ['link', 'Link & Assignments'], ['log', 'Assignment Log & Audit']];
const LOG_FILTERS = [['', 'All'], ['duty_changed', 'Duty changed'], ['handover_accepted', 'Handover accepted'], ['handover_submitted', 'Handover sent']];
const logChip = (action) => (action.startsWith('handover') ? ['info', 'bell'] : ['', 'checkCircle']);

export function CareTeams({ Head }) {
  const [{ data, users, nurses, duty, log, error }, reload] = useCareTeams();
  const [msg, setMsg] = useState(null);
  const [tab, setTab] = useState('roster');
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);
  const [logFilter, setLogFilter] = useState('');
  const run = async (fn, ok) => {
    setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); await reload(); return true; } catch (e) { setMsg({ tone: 'critical', text: (e.details || [e.message]).join('. ') }); return false; }
  };
  const name = (id) => (users || []).find((n) => n.id === id)?.name || id;
  const q = search.trim().toLowerCase();
  const elders = (t) => (data ? data.patients.filter((p) => p.careTeamId === t.id) : []);
  const teams = data ? data.teams.filter((t) => !q || [t.name, t.id, t.clinicId, ...t.members.map((m) => m.name), ...elders(t).map((p) => `${p.name} ${p.id}`)].join(' ').toLowerCase().includes(q)) : [];
  return (
    <>
      <Head title="Care teams" sub="Manage elder assignments, care team rosters, and track changes.">
        <button type="button" className="m-btn ad-btn-auto ad-btn-light" onClick={() => setCreating(true)}>+ Create New Team</button>
      </Head>
      <div className="ad-tabs" role="tablist" aria-label="Care teams">
        {TABS.map(([k, l]) => <button key={k} type="button" role="tab" aria-selected={tab === k} onClick={() => setTab(k)}>{l}</button>)}
      </div>
      {msg && <p className={`m-banner tone-${msg.tone}`} role={msg.tone === 'critical' ? 'alert' : 'status'} style={{ marginBottom: '1rem' }}>{msg.text}</p>}
      {error && <p className="m-banner tone-critical">{error}</p>}
      {!data && !error && <p className="ad-on-dark">Loading…</p>}

      {data && tab === 'roster' && (
        <>
          <label className="m-search ad-search"><Icon name="search" /><span className="m-sr">Search</span><input type="search" value={search} onChange={(e) => setSearch(e.target.value)} placeholder="Search" /></label>
          <div className="ad-grid-2">
            {teams.map((t) => (
              <section key={t.id} className="ad-panel">
                <div className="m-between"><h2>{t.name}</h2><Chip icon="checkCircle">{t.id}</Chip></div>
                <p className="m-caption">{t.clinicId || 'No clinic set'} · {elders(t).length} elder(s)</p>
                <h3 className="ad-label">Care team</h3>
                <ul className="ad-members">
                  {t.members.map((m) => {
                    const d = (duty || []).find((x) => x.id === m.id);
                    return (
                      <li key={m.id}>
                        <span className={`m-avatar ${toneFor(m.name)}`} aria-hidden="true">{initials(m.name)}</span>
                        <span className="m-grow"><strong><span className={`m-duty-dot ${d && d.onDuty ? 'is-on' : ''}`} title={d && d.onDuty ? 'On duty' : 'Off duty'} />{m.name}</strong>
                          <span className="m-sub">{m.teamRole === 'lead' ? 'Team lead · ' : ''}{d && d.onDuty ? 'On duty' : 'Off duty'} · {d ? d.cases : 0} case(s)</span></span>
                        <button type="button" className="m-link" onClick={() => window.confirm(`Remove ${m.name} from ${t.name}?`) && run(() => api(`/api/clinic/care-teams/${t.id}/members/${m.id}`, { method: 'DELETE' }), `${m.name} removed from ${t.name}`)}>Remove</button>
                      </li>
                    );
                  })}
                </ul>
                <AddMember team={t} nurses={nurses || []} onAdd={(body) => run(() => api(`/api/clinic/care-teams/${t.id}/members`, { method: 'POST', body }), `${body.nurseName} added to ${t.name}`)} />
                <div className="ad-divider" />
                <h3 className="ad-label">Elders</h3>
                <div className="ad-tags">{elders(t).map((p) => <span key={p.id}>{p.name} · {p.id}</span>)}{!elders(t).length && <span className="m-caption">None yet. Link one in Link & Assignments.</span>}</div>
              </section>
            ))}
            {!teams.length && <p className="ad-on-dark">No team matches “{search}”.</p>}
          </div>
        </>
      )}

      {data && tab === 'link' && (
        <>
          <section className="ad-panel">
            <h2>Elders</h2>
            <p className="m-caption">Cases already held by a nurse move only by an accepted handover.</p>
            <table className="ad-table">
              <thead><tr><th>Elder</th><th>Care team</th><th>Monitoring plan</th><th>Case held by</th><th><span className="m-sr">Save</span></th></tr></thead>
              <tbody>{data.patients.map((p) => <ElderRow key={p.id} p={p} data={data} onSave={(body, label) => run(() => api(`/api/clinic/patients/${encodeURIComponent(p.id)}/care`, { method: 'PUT', body }), label)} />)}</tbody>
            </table>
          </section>
          <section className="ad-panel">
            <h2>Link another elder</h2>
            <AddElder data={data} onSave={(id, body) => run(() => api(`/api/clinic/patients/${encodeURIComponent(id)}/care`, { method: 'PUT', body }), `${body.patientName} linked to ${body.careTeamId}`)} />
          </section>
        </>
      )}

      {data && tab === 'log' && (
        <section className="ad-panel">
          <h2>Assignment log</h2>
          <p className="m-caption">Every change to teams, links, duty and handovers, with who made it and when. Handover content stays with the nurses.</p>
          <div className="ad-filter-chips" role="group" aria-label="Show">
            {LOG_FILTERS.map(([k, l]) => <button key={k} type="button" aria-pressed={logFilter === k} onClick={() => setLogFilter(k)}>{l}</button>)}
          </div>
          <table className="ad-table">
            <thead><tr><th>When</th><th>What</th><th>By</th><th>Details</th></tr></thead>
            <tbody>
              {(log || []).filter((e) => !logFilter || e.action === logFilter).map((e) => {
                const [tone, icon] = logChip(e.action);
                return (
                  <tr key={e.id}>
                    <td title={new Date(e.at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}>{relTime(e.at)}</td>
                    <td><Chip tone={tone} icon={icon}>{ACTION_LABEL[e.action] || e.action}</Chip></td>
                    <td><strong>{name(e.actorId)}</strong><span className="m-sub">{e.actorRole.replace('_', ' ')}</span></td>
                    <td>{[e.patientId, e.teamId, e.details.from && `${name(e.details.from)} → ${name(e.details.to)}`, e.details.nurseName, e.details.onDuty !== undefined && (e.details.onDuty ? 'on duty' : 'off duty'), e.details.monitoringPlanId].filter(Boolean).join(' · ')}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </section>
      )}

      {creating && <NewTeam onClose={() => setCreating(false)} onCreate={async (body) => { if (await run(() => api('/api/clinic/care-teams', { method: 'POST', body }), `${body.name} created`)) setCreating(false); }} />}
    </>
  );
}

function ElderRow({ p, data, onSave }) {
  const [team, setTeam] = useState(p.careTeamId || '');
  const [plan, setPlan] = useState(p.monitoringPlanId || '');
  const [nurse, setNurse] = useState('');
  const members = (data.teams.find((t) => t.id === team) || { members: [] }).members;
  const changed = team !== (p.careTeamId || '') || plan !== (p.monitoringPlanId || '') || nurse;
  return (
    <tr>
      <td><strong>{p.name}</strong><span className="m-sub">{p.id}</span></td>
      <td><select value={team} onChange={(e) => setTeam(e.target.value)} aria-label={`Care team for ${p.name}`}>{data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></td>
      <td><select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label={`Monitoring plan for ${p.name}`}><option value="">—</option>{data.monitoringPlans.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></td>
      <td>
        {p.caseNurse ? <>{p.caseNurse.name}<span className="m-sub">since {relTime(p.caseNurse.since)}</span></> : (
          <select value={nurse} onChange={(e) => setNurse(e.target.value)} aria-label={`First case nurse for ${p.name}`}>
            <option value="">No nurse yet - choose</option>{members.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}
          </select>
        )}
        {p.handoverPendingTo && <Chip tone="moderate">Handover to {p.handoverPendingTo} pending</Chip>}
      </td>
      <td><button type="button" className="m-link" disabled={!changed} onClick={() => onSave({ careTeamId: team, monitoringPlanId: plan || null, ...(nurse ? { caseNurseId: nurse } : {}) }, `${p.name} updated`)}>Save</button></td>
    </tr>
  );
}

function AddElder({ data, onSave }) {
  const [id, setId] = useState('');
  const [nm, setNm] = useState('');
  const [team, setTeam] = useState(data.teams[0] ? data.teams[0].id : '');
  const [plan, setPlan] = useState('MP-DAILY');
  return (
    <form className="ad-form-row" onSubmit={(e) => { e.preventDefault(); onSave(id.trim(), { patientName: nm.trim(), careTeamId: team, monitoringPlanId: plan }); setId(''); setNm(''); }}>
      <label className="ad-field is-narrow"><span>Patient ID</span><input value={id} onChange={(e) => setId(e.target.value)} placeholder="P-1004" pattern="[A-Za-z0-9_\-]{1,64}" required /></label>
      <label className="ad-field"><span>Full name</span><input value={nm} onChange={(e) => setNm(e.target.value)} minLength={2} required /></label>
      <label className="ad-field"><span>Care team</span><select value={team} onChange={(e) => setTeam(e.target.value)}>{data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select></label>
      <label className="ad-field"><span>Monitoring plan</span><select value={plan} onChange={(e) => setPlan(e.target.value)}>{data.monitoringPlans.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select></label>
      <button type="submit" className="m-btn ad-btn-auto">Link</button>
    </form>
  );
}

function AddMember({ team, nurses, onAdd }) {
  const free = nurses.filter((n) => !team.members.some((m) => m.id === n.id));
  const [open, setOpen] = useState(false);
  const [id, setId] = useState('');
  const [role, setRole] = useState('nurse');
  if (!free.length) return <p className="m-caption">Every nurse account is on this team.</p>;
  if (!open) return <button type="button" className="m-link ad-add" onClick={() => setOpen(true)}>+ Add Nurse</button>;
  return (
    <form className="ad-inline-form" onSubmit={(e) => { e.preventDefault(); const n = free.find((x) => x.id === id); if (n) onAdd({ nurseId: n.id, nurseName: n.name, teamRole: role }); setId(''); setOpen(false); }}>
      <select value={id} onChange={(e) => setId(e.target.value)} aria-label={`Nurse to add to ${team.name}`} required autoFocus><option value="">Choose a nurse…</option>{free.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select>
      <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Team role"><option value="nurse">Nurse</option><option value="lead">Team lead</option></select>
      <button type="submit" className="m-btn ad-btn-auto" disabled={!id}>Add</button>
      <button type="button" className="m-link" onClick={() => setOpen(false)}>Cancel</button>
    </form>
  );
}

/** "Create New Team": a drawer from the right over the page (Figma "Create New Team drawer"). */
function NewTeam({ onCreate, onClose }) {
  const [id, setId] = useState('');
  const [nm, setNm] = useState('');
  const [clinic, setClinic] = useState('');
  useEffect(() => {
    const esc = (e) => e.key === 'Escape' && onClose();
    window.addEventListener('keydown', esc);
    return () => window.removeEventListener('keydown', esc);
  }, [onClose]);
  return (
    <div className="ad-drawer-backdrop" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <form className="ad-drawer" role="dialog" aria-modal="true" aria-labelledby="new-team-title" onSubmit={(e) => { e.preventDefault(); onCreate({ id: id.trim().toUpperCase(), name: nm.trim(), clinicId: clinic.trim() || undefined }); }}>
        <div className="m-between"><h2 id="new-team-title">New care team</h2><button type="button" className="ad-close" onClick={onClose} aria-label="Close"><Icon name="x" size={20} /></button></div>
        <label className="ad-field"><span>Team ID</span><input value={id} onChange={(e) => setId(e.target.value)} placeholder="CT-MNL-B" pattern="[Cc][Tt]-[A-Za-z0-9\-]{1,30}" required autoFocus /></label>
        <label className="ad-field"><span>Team name</span><input value={nm} onChange={(e) => setNm(e.target.value)} placeholder="RHU Manila - Team B" minLength={3} required /></label>
        <label className="ad-field"><span>Clinic ID</span><input value={clinic} onChange={(e) => setClinic(e.target.value)} placeholder="RHU-MNL-01 (optional)" /></label>
        <div className="ad-drawer-foot"><button type="submit" className="m-btn is-brand">Create team</button></div>
      </form>
    </div>
  );
}

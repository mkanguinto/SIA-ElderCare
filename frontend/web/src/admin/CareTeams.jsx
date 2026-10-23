// Admin: care teams, elder <-> team / monitoring plan links, first case nurse, duty overview and the
// assignment log. Technical, not clinical: no vital signs, notes or handover content are shown here, and a
// case that a nurse already holds can move only through a handover the incoming nurse accepts.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { relTime } from '../format';
import { Chip } from '../mobile/kit';

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

export function CareTeams({ Head }) {
  const [{ data, users, nurses, duty, log, error }, reload] = useCareTeams();
  const [msg, setMsg] = useState(null);
  const run = async (fn, ok) => {
    setMsg(null);
    try { await fn(); setMsg({ tone: 'ok', text: ok }); await reload(); } catch (e) { setMsg({ tone: 'critical', text: (e.details || [e.message]).join('. ') }); }
  };
  const name = (id) => (users || []).find((n) => n.id === id)?.name || id;
  return (
    <>
      <Head title="Care teams" sub="Link each elder to a care team and monitoring plan, and record who is on each team. Cases already held by a nurse move only by an accepted handover." />
      {msg && <p className={`m-banner tone-${msg.tone}`} role={msg.tone === 'critical' ? 'alert' : 'status'} style={{ marginBottom: '1rem' }}>{msg.text}</p>}
      {error && <p className="m-banner tone-critical">{error}</p>}
      {!data && !error && <p>Loading…</p>}
      {data && (
        <>
          <section className="ad-panel">
            <h2>Elders</h2>
            <table className="ad-table">
              <thead><tr><th>Elder</th><th>Care team</th><th>Monitoring plan</th><th>Case held by</th><th><span className="m-sr">Save</span></th></tr></thead>
              <tbody>{data.patients.map((p) => <ElderRow key={p.id} p={p} data={data} onSave={(body, label) => run(() => api(`/api/clinic/patients/${encodeURIComponent(p.id)}/care`, { method: 'PUT', body }), label)} />)}</tbody>
            </table>
            <AddElder data={data} onSave={(id, body) => run(() => api(`/api/clinic/patients/${encodeURIComponent(id)}/care`, { method: 'PUT', body }), `${body.patientName} linked to ${body.careTeamId}`)} />
          </section>

          <div className="ad-grid-2">
            {data.teams.map((t) => (
              <section key={t.id} className="ad-panel">
                <div className="m-between"><h2>{t.name}</h2><Chip>{t.id}</Chip></div>
                <p className="m-caption">{t.clinicId || 'No clinic set'} · {data.patients.filter((p) => p.careTeamId === t.id).length} elder(s)</p>
                <ul className="ad-members">
                  {t.members.map((m) => {
                    const d = (duty || []).find((x) => x.id === m.id);
                    return (
                      <li key={m.id}>
                        <span className={`m-duty-dot ${d && d.onDuty ? 'is-on' : ''}`} title={d && d.onDuty ? 'On duty' : 'Off duty'} />
                        <span className="m-grow"><strong>{m.name}</strong><span className="m-sub">{m.teamRole === 'lead' ? 'Team lead · ' : ''}{d && d.onDuty ? 'On duty' : 'Off duty'} · {d ? d.cases : 0} case(s)</span></span>
                        <button type="button" className="m-link" onClick={() => window.confirm(`Remove ${m.name} from ${t.name}?`) && run(() => api(`/api/clinic/care-teams/${t.id}/members/${m.id}`, { method: 'DELETE' }), `${m.name} removed from ${t.name}`)}>Remove</button>
                      </li>
                    );
                  })}
                </ul>
                <AddMember team={t} nurses={nurses || []} onAdd={(body) => run(() => api(`/api/clinic/care-teams/${t.id}/members`, { method: 'POST', body }), `${body.nurseName} added to ${t.name}`)} />
              </section>
            ))}
            <NewTeam onCreate={(body) => run(() => api('/api/clinic/care-teams', { method: 'POST', body }), `${body.name} created`)} />
          </div>

          <section className="ad-panel">
            <h2>Assignment log</h2>
            <p className="m-caption">Every change to teams, links, duty and handovers, with who made it and when. Handover content stays with the nurses.</p>
            <table className="ad-table">
              <thead><tr><th>When</th><th>What</th><th>By</th><th>Details</th></tr></thead>
              <tbody>
                {(log || []).map((e) => (
                  <tr key={e.id}>
                    <td title={new Date(e.at).toLocaleString('en-PH', { timeZone: 'Asia/Manila' })}>{relTime(e.at)}</td>
                    <td>{ACTION_LABEL[e.action] || e.action}</td>
                    <td>{name(e.actorId)}<span className="m-sub">{e.actorRole.replace('_', ' ')}</span></td>
                    <td className="m-caption">{[e.patientId, e.teamId, e.details.from && `${name(e.details.from)} → ${name(e.details.to)}`, e.details.nurseName, e.details.onDuty !== undefined && (e.details.onDuty ? 'on duty' : 'off duty'), e.details.monitoringPlanId].filter(Boolean).join(' · ')}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </section>
        </>
      )}
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
      <td><button type="button" className="m-btn" disabled={!changed} onClick={() => onSave({ careTeamId: team, monitoringPlanId: plan || null, ...(nurse ? { caseNurseId: nurse } : {}) }, `${p.name} updated`)}>Save</button></td>
    </tr>
  );
}

function AddElder({ data, onSave }) {
  const [id, setId] = useState('');
  const [nm, setNm] = useState('');
  const [team, setTeam] = useState(data.teams[0] ? data.teams[0].id : '');
  const [plan, setPlan] = useState('MP-DAILY');
  return (
    <form className="ad-inline-form" onSubmit={(e) => { e.preventDefault(); onSave(id.trim(), { patientName: nm.trim(), careTeamId: team, monitoringPlanId: plan }); setId(''); setNm(''); }}>
      <strong>Link another elder</strong>
      <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Patient ID (P-1004)" aria-label="Patient ID" pattern="[A-Za-z0-9_\-]{1,64}" required />
      <input value={nm} onChange={(e) => setNm(e.target.value)} placeholder="Full name" aria-label="Full name" minLength={2} required />
      <select value={team} onChange={(e) => setTeam(e.target.value)} aria-label="Care team">{data.teams.map((t) => <option key={t.id} value={t.id}>{t.name}</option>)}</select>
      <select value={plan} onChange={(e) => setPlan(e.target.value)} aria-label="Monitoring plan">{data.monitoringPlans.map((m) => <option key={m.id} value={m.id}>{m.name}</option>)}</select>
      <button type="submit" className="m-btn is-dark">Link</button>
    </form>
  );
}

function AddMember({ team, nurses, onAdd }) {
  const free = nurses.filter((n) => !team.members.some((m) => m.id === n.id));
  const [id, setId] = useState('');
  const [role, setRole] = useState('nurse');
  if (!free.length) return <p className="m-caption">Every nurse account is on this team.</p>;
  return (
    <form className="ad-inline-form" onSubmit={(e) => { e.preventDefault(); const n = free.find((x) => x.id === id); if (n) onAdd({ nurseId: n.id, nurseName: n.name, teamRole: role }); setId(''); }}>
      <select value={id} onChange={(e) => setId(e.target.value)} aria-label={`Nurse to add to ${team.name}`} required><option value="">Add a nurse…</option>{free.map((n) => <option key={n.id} value={n.id}>{n.name}</option>)}</select>
      <select value={role} onChange={(e) => setRole(e.target.value)} aria-label="Team role"><option value="nurse">Nurse</option><option value="lead">Team lead</option></select>
      <button type="submit" className="m-btn" disabled={!id}>Add</button>
    </form>
  );
}

function NewTeam({ onCreate }) {
  const [id, setId] = useState('');
  const [nm, setNm] = useState('');
  const [clinic, setClinic] = useState('');
  return (
    <section className="ad-panel">
      <h2>New care team</h2>
      <form className="ad-inline-form" style={{ flexDirection: 'column', alignItems: 'stretch' }} onSubmit={(e) => { e.preventDefault(); onCreate({ id: id.trim().toUpperCase(), name: nm.trim(), clinicId: clinic.trim() || undefined }); setId(''); setNm(''); setClinic(''); }}>
        <input value={id} onChange={(e) => setId(e.target.value)} placeholder="Team ID, e.g. CT-MNL-B" aria-label="Team ID" pattern="[Cc][Tt]-[A-Za-z0-9\-]{1,30}" required />
        <input value={nm} onChange={(e) => setNm(e.target.value)} placeholder="Name, e.g. RHU Manila - Team B" aria-label="Team name" minLength={3} required />
        <input value={clinic} onChange={(e) => setClinic(e.target.value)} placeholder="Clinic ID (optional), e.g. RHU-MNL-01" aria-label="Clinic ID" />
        <button type="submit" className="m-btn is-dark">Create team</button>
      </form>
    </section>
  );
}

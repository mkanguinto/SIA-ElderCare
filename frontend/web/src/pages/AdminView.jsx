import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { useToast } from '../toast';
import { PageHeader, StatusDot, ErrorNote, Loading } from '../components/ui';
import { ROLE_LABEL, relTime } from '../format';

const SERVICE = {
  checkin: { name: 'Daily check-ins', port: 4001 },
  alert: { name: 'Family alerts and SMS', port: 4002 },
  clinic: { name: 'Clinic risk queue', port: 4003 },
  legacyAdapter: { name: 'Clinic records adapter (SOAP)', port: 4004 },
  care: { name: 'Care plans (caregiver duties)', port: 4006 },
  nodeRed: { name: 'Node-RED integration flows', port: 1880 },
};
// Operators open the DLQ dashboard on the server itself (Node-RED is bound to 127.0.0.1).
const DLQ_DASHBOARD = import.meta.env.VITE_DLQ_DASHBOARD_URL || 'http://localhost:1880/dlq';

const STATE_TEXT = { up: 'Running', degraded: 'Degraded', down: 'Not reachable' };

function messagingSummary(m) {
  if (!m) return '';
  const broker = m.mode === 'rabbitmq' ? (m.connected ? 'RabbitMQ connected' : `RabbitMQ unreachable${m.lastError ? ` (${m.lastError})` : ''}`) : 'no broker (direct HTTP fallback)';
  const dead = (m.queues || []).filter((q) => q.queue.endsWith('.dlq') && q.messages > 0);
  const deadText = dead.length ? `, ${dead.map((q) => `${q.messages} in ${q.queue}`).join(', ')} - review and replay` : '';
  return `Messaging: ${broker}${deadText}`;
}

function serviceDetails(s) {
  const d = s.details || {};
  if (s.status === 'down') return `No response (${s.error || 'connection refused'}). Start it with npm start in its folder.`;
  if (s.name === 'checkin' && d.outbox) {
    const pending = d.outbox.pending || 0;
    const failed = d.outbox.failed || 0;
    return [`${d.outbox.delivered || 0} events published${pending ? `, ${pending} waiting to send` : ''}${failed ? `, ${failed} need manual follow-up` : ''}`, messagingSummary(d.messaging)].filter(Boolean).join('. ');
  }
  if (s.name === 'alert' && d.integrations) {
    const i = d.integrations;
    return [
      `SMS: ${i.sms && i.sms.live ? 'sending through TextBee' : `test mode (messages logged, not sent)${i.sms && i.sms.reason ? ` - ${i.sms.reason}` : ''}`}`,
      `Weather: ${i.openWeatherMap === 'configured' ? `OpenWeatherMap connected${i.lastWeatherFetch ? `, last check ${relTime(i.lastWeatherFetch)}` : ''}` : 'no API key set'}`,
      messagingSummary(d.messaging),
    ].filter(Boolean).join('. ');
  }
  if (s.name === 'clinic' && d.activeQueueItems !== undefined) return [`${d.activeQueueItems} patients in the active queue`, messagingSummary(d.messaging)].filter(Boolean).join('. ');
  if (s.name === 'legacyAdapter') return 'Translates SOAP/XML records from the health center system into JSON';
  if (s.name === 'nodeRed') return 'Routes incoming SMS, runs the weather check every 30 minutes, watches the dead-letter queues';
  if (s.name === 'care') return 'Care plans and the caregiver duty checklist';
  return '';
}

export function SecurityPanel() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/admin/security').then((r) => setS(r.jwt)).catch((e) => setError(e.message)); }, []);
  if (error) return <ErrorNote error={error} />;
  if (!s) return <Loading />;
  const r = s.rotation;
  return (
    <>
      <dl className="facts">
        <dt>Signing key</dt><dd><code>{s.access.activeKid}</code> ({s.algorithm}){s.access.verifyOnlyKids.length > 0 && <span className="muted small"> · still accepted: {s.access.verifyOnlyKids.join(', ')}</span>}</dd>
        <dt>Refresh key</dt><dd><code>{s.refresh.activeKid}</code>{s.refresh.verifyOnlyKids.length > 0 && <span className="muted small"> · still accepted: {s.refresh.verifyOnlyKids.join(', ')}</span>}</dd>
        <dt>Key rotation</dt>
        <dd>{r.nextRotationDue
          ? <><span className={r.overdue ? 'text-critical' : ''}>{r.overdue ? 'Overdue since' : 'Next by'} {r.nextRotationDue.slice(0, 10)}</span> <span className="muted small">(every {r.intervalDays} days)</span></>
          : <span className="muted">Set JWT_KEY_ROTATED_AT to track the {r.intervalDays}-day schedule</span>}</dd>
        <dt>Sessions</dt><dd>{s.store.activeSessions} active, {s.store.revokedSessions} ended, {s.store.deniedAccessTokens} revoked access tokens{!s.store.persistent && <span className="text-critical"> · not persisted</span>}</dd>
      </dl>
      <p className="muted small">How to rotate keys without signing anyone out: docs/SECURITY.md.</p>
    </>
  );
}

export default function AdminView() {
  const toast = useToast();
  const [health, setHealth] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');

  async function signOutEverywhere(u) {
    if (!window.confirm(`Sign ${u.name} out on every device? They can sign in again right away.`)) return;
    try {
      const r = await api(`/api/admin/users/${encodeURIComponent(u.id)}/revoke-sessions`, { method: 'POST' });
      toast({ title: `${u.name} signed out everywhere`, body: `${r.sessionsRevoked} session(s) ended`, tone: 'success' });
    } catch (e) {
      toast({ title: e.message, tone: 'error' });
    }
  }

  const load = useCallback(() => api('/api/admin/health').then((h) => { setHealth(h); setError(''); }).catch((e) => setError(e.message)), []);

  useEffect(() => { api('/api/admin/users').then(setUsers).catch((e) => setError(e.message)); }, []);
  useEffect(() => {
    load();
    const t = setInterval(load, 10000);
    return () => clearInterval(t);
  }, [load]);

  const down = health ? health.services.filter((s) => s.status !== 'up') : [];

  return (
    <>
      <PageHeader title="System status" subtitle="Refreshes every 10 seconds.">
        {health && (
          <span className={`overall overall-${health.overall}`}>
            <StatusDot state={health.overall} />
            {health.overall === 'up' ? 'All services running' : `${down.length} service${down.length === 1 ? '' : 's'} need attention`}
          </span>
        )}
      </PageHeader>
      <ErrorNote error={error} onRetry={load} />
      {!health && !error && <Loading label="Checking services" />}

      {health && (
        <section className="panel">
          <h2 className="panel-title">Services</h2>
          <ul className="services">
            <li className="service">
              <StatusDot state="up" />
              <div><strong>API gateway</strong><p className="muted small">Sign-in, permissions and routing. Port 8080.</p></div>
              <span className="service-state">Running</span>
            </li>
            {health.services.map((s) => (
              <li key={s.name} className="service">
                <StatusDot state={s.status} />
                <div>
                  <strong>{(SERVICE[s.name] || {}).name || s.name}</strong>
                  <p className="muted small">{[serviceDetails(s).replace(/\.$/, ''), SERVICE[s.name] && `Port ${SERVICE[s.name].port}`].filter(Boolean).join('. ')}.</p>
                </div>
                <span className="service-state">{STATE_TEXT[s.status]}<small>{s.latencyMs} ms</small></span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <div className="layout-split">
        <section className="panel">
          <h2 className="panel-title">Sign-in security</h2>
          <SecurityPanel />
        </section>
        <section className="panel">
          <h2 className="panel-title">Messages and dead-letter queues</h2>
          <p className="small">Messages that failed every retry wait in a dead-letter queue until someone replays them. The Node-RED dashboard shows every queue, the last weather check and the SMS router.</p>
          <a className="btn btn-secondary" href={DLQ_DASHBOARD} target="_blank" rel="noreferrer">Open DLQ dashboard</a>
          <p className="muted small">Opens on the server (port 1880). Sign in with DASHBOARD_USER / DASHBOARD_PASSWORD.</p>
        </section>
      </div>

      <div className="layout-split">
        {health && (
          <section className="panel">
            <h2 className="panel-title">Circuit breakers</h2>
            <p className="muted small">The gateway stops calling a service that keeps failing, then retries it after 15 seconds.</p>
            {health.circuitBreakers.length === 0 ? <p className="muted small">No traffic yet.</p> : (
              <table className="table">
                <thead><tr><th>Service</th><th>State</th><th>Recent failures</th></tr></thead>
                <tbody>
                  {health.circuitBreakers.map((b) => (
                    <tr key={b.name}>
                      <td>{(SERVICE[b.name] || {}).name || b.name}</td>
                      <td><span className={`pill breaker-${b.state}`}>{b.state === 'CLOSED' ? 'Normal' : b.state === 'OPEN' ? 'Paused' : 'Testing'}</span></td>
                      <td>{b.failures}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            )}
          </section>
        )}

        <section className="panel">
          <h2 className="panel-title">Accounts and roles</h2>
          {!users ? <Loading /> : (
            <>
              <p className="muted small">{users.total} accounts. Edit them in api-gateway/data/users.json. Passwords are stored as hashes and never shown.</p>
              <table className="table">
                <thead><tr><th>Name</th><th>Role</th><th>Patients</th><th /></tr></thead>
                <tbody>
                  {users.users.map((u) => (
                    <tr key={u.id}>
                      <td><strong>{u.name}</strong><br /><span className="muted small">{u.username}</span></td>
                      <td><span className={`pill role-${u.role}`}>{ROLE_LABEL[u.role]}</span></td>
                      <td>{u.patients.length ? u.patients.join(', ') : <span className="muted">All patients</span>}</td>
                      <td><button type="button" className="btn btn-quiet btn-sm" onClick={() => signOutEverywhere(u)}>Sign out everywhere</button></td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </>
          )}
        </section>
      </div>
    </>
  );
}

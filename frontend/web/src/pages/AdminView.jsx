import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { PageHeader, StatusDot, ErrorNote, Loading } from '../components/ui';
import { ROLE_LABEL, relTime } from '../format';

const SERVICE = {
  checkin: { name: 'Daily check-ins', port: 4001 },
  alert: { name: 'Family alerts and SMS', port: 4002 },
  clinic: { name: 'Clinic risk queue', port: 4003 },
  legacyAdapter: { name: 'Clinic records adapter (SOAP)', port: 4004 },
};

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
  return '';
}

export default function AdminView() {
  const [health, setHealth] = useState(null);
  const [users, setUsers] = useState(null);
  const [error, setError] = useState('');

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
                <thead><tr><th>Name</th><th>Role</th><th>Patients</th></tr></thead>
                <tbody>
                  {users.users.map((u) => (
                    <tr key={u.id}>
                      <td><strong>{u.name}</strong><br /><span className="muted small">{u.username}</span></td>
                      <td><span className={`pill role-${u.role}`}>{ROLE_LABEL[u.role]}</span></td>
                      <td>{u.patients.length ? u.patients.join(', ') : <span className="muted">All patients</span>}</td>
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

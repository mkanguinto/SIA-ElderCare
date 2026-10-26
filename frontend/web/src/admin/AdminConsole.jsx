// Admin web console (Figma page "All", Admin · frames): white sidebar on the dark green page.
import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { Link } from '../router';
import { relTime } from '../format';
import Icon from '../mobile/icons';
import { Chip } from '../mobile/kit';
import { SecurityPanel } from './SecurityPanel';
import { CareTeams } from './CareTeams';
import { Accounts, AuditLog } from './Accounts';
import AlertRules from '../pages/AlertRules';
import { ToastProvider } from '../toast';
import DesktopShell from '../components/DesktopShell';
import '../mobile/mobile.css';

const DLQ_DASHBOARD = import.meta.env.VITE_DLQ_DASHBOARD_URL || 'http://localhost:1880/dlq';
const SERVICES = {
  checkin: { name: 'Check-in service', sub: 'checkin_db · port 4001' },
  alert: { name: 'Alert service', sub: 'alert_db · TextBee · OpenWeatherMap' },
  clinic: { name: 'Clinic risk service', sub: 'clinic_db · port 4003' },
  legacyAdapter: { name: 'Legacy EMR adapter', sub: 'stateless · SOAP 1.1' },
  care: { name: 'Care plan service', sub: 'care_db · port 4006' },
  nodeRed: { name: 'Node-RED', sub: 'SMS router · weather · DLQ monitor' },
};
const SECTIONS = [
  { title: 'Operations', items: [
    { to: '/admin', label: 'Integration monitor', icon: 'pulse' },
    { to: '/admin/health', label: 'Service health', icon: 'server' },
    { to: '/admin/dlq', label: 'Dead-letter queue', icon: 'inbox' },
  ] },
  { title: 'Administration', items: [
    { to: '/admin/users', label: 'Accounts', icon: 'user' },
    { to: '/admin/care-teams', label: 'Care teams', icon: 'users' },
    { to: '/admin/audit', label: 'Audit log', icon: 'shield' },
  ] },
  { title: 'Settings', items: [{ to: '/admin/alert-rules', label: 'Alert rules', icon: 'sliders' }] },
];

/** /api/admin/health + /api/admin/messaging, refreshed every 5 s. */
export function useLive() {
  const [state, setState] = useState({});
  const load = useCallback(() => Promise.all([
    api('/api/admin/health').catch((e) => ({ error: e.message })),
    api('/api/admin/messaging').catch((e) => ({ error: e.message })),
  ]).then(([health, messaging]) => setState({ health, messaging, at: new Date() })), []);
  useEffect(() => {
    load();
    // Only while the page is on screen: a forgotten background tab must not keep the free cloud services awake.
    const t = setInterval(() => { if (document.visibilityState === 'visible') load(); }, 5000);
    const onShow = () => { if (document.visibilityState === 'visible') load(); };
    document.addEventListener('visibilitychange', onShow);
    return () => { clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
  }, [load]);
  return [state, load];
}

export default function AdminConsole({ user, path }) {
  const sub = path.replace(/\/+$/, '');
  const [live, reload] = useLive();
  let page;
  if (sub === '/admin/health') page = <Health live={live} />;
  else if (sub === '/admin/users') page = <Accounts Head={Head} />;
  else if (sub === '/admin/audit') page = <AuditLog Head={Head} />;
  else if (sub === '/admin/care-teams') page = <CareTeams Head={Head} />;
  else if (sub === '/admin/dlq') page = <Dlq live={live} reload={reload} />;
  else if (sub === '/admin/alert-rules') page = <AlertRules user={user} />;
  else page = <Monitor live={live} />;
  return (
    <ToastProvider>
      <DesktopShell variant="admin" label="Admin" role="Admin" sections={SECTIONS} user={user} userSub="System Administrator">
        <p className="m-banner tone-info ad-phone-note" role="note"><Icon name="monitor" />The admin console is made for a computer. On a phone you can check status, but use a computer to manage the system.</p>
        {page}
      </DesktopShell>
    </ToastProvider>
  );
}

export function Head({ title, sub, live, children }) {
  const h = live && live.health;
  const services = h && h.services ? h.services : [];
  const up = services.filter((s) => s.status === 'up').length + (h && h.gateway === 'up' ? 1 : 0);
  const all = services.length + 1;
  return (
    <header className="ad-head">
      <div><h1>{title}</h1><p>{sub}</p></div>
      {h && !h.error && <span className={`ad-live ${up === all ? '' : 'is-down'}`}><span aria-hidden="true" />Live · {up === all ? `All ${all} services up` : `${all - up} of ${all} down`}</span>}
      {children}
    </header>
  );
}

const queuesOf = (m) => ((m && m.services) || []).flatMap((s) => (s.queues || []).map((q) => ({ ...q, service: s.name })));

function Kpi({ icon, label, value, note, children }) {
  return (
    <div className="ad-card ad-kpi">
      <div className="ad-kpi-label"><span className="ad-kpi-icon"><Icon name={icon} size={20} /></span>{label}</div>
      <strong>{value}</strong>
      <div className="ad-kpi-foot"><span>{note}</span>{children}</div>
    </div>
  );
}

/* ------------------------------ integration monitor ------------------------------ */
export function Monitor({ live }) {
  const { health, messaging } = live;
  if (!health) return <><Head title="Integration monitor" sub="Live path of every event through the gateway, RabbitMQ and the services." /><p className="ad-on-dark">Loading…</p></>;
  if (health.error) return <p className="m-error">{health.error}</p>;
  const svc = Object.fromEntries(health.services.map((s) => [s.name, s]));
  const queues = queuesOf(messaging);
  const depth = queues.filter((q) => !q.queue.endsWith('.dlq')).reduce((a, q) => a + q.messages, 0);
  const dead = queues.filter((q) => q.queue.endsWith('.dlq')).reduce((a, q) => a + q.messages, 0);
  const published = ['checkin', 'alert', 'clinic'].reduce((a, k) => a + ((((svc[k] || {}).details || {}).outbox || {}).delivered || 0), 0);
  const avgLatency = Math.round(health.services.reduce((a, s) => a + (s.latencyMs || 0), 0) / health.services.length);
  const connected = ((messaging && messaging.services) || []).every((s) => s.connected);
  const nodeClass = (name) => (!svc[name] ? 'is-off' : svc[name].status === 'up' ? '' : 'is-down');
  const ms = (name) => (svc[name] ? <span className="ad-ms">{svc[name].latencyMs} ms</span> : null);
  const arrow = <span className="ad-arrow" aria-hidden="true"><Icon name="arrowRight" size={20} /></span>;
  return (
    <>
      <Head title="Integration monitor" sub="Live path of every event through the gateway, RabbitMQ and the services. Updates every 5 s." live={live} />
      <div className="ad-kpis">
        <Kpi icon="clock" label="Gateway → services (avg)" value={`${avgLatency} ms`} note="target ≤ 2.0 s"><Chip tone={avgLatency <= 2000 ? 'ok' : 'critical'} icon={avgLatency <= 2000 ? 'check' : 'alert'}>{avgLatency <= 2000 ? 'On target' : 'Slow'}</Chip></Kpi>
        <Kpi icon="arrowRight" label="Events published" value={published} note="via eldercare.events"><Chip icon="checkCircle">Fan-out ×3</Chip></Kpi>
        <Kpi icon="pulse" label="Queue depth" value={depth} note="alert · clinic queues"><Chip tone={depth < 50 ? 'ok' : 'moderate'} icon={depth < 50 ? 'check' : 'alert'}>{depth < 50 ? 'Healthy' : 'Backlog'}</Chip></Kpi>
        <Kpi icon="inbox" label="Dead-lettered" value={dead} note="*.dlq">{dead ? <Link to="/admin/dlq"><Chip tone="moderate" icon="alert">Review</Chip></Link> : <Chip tone="ok" icon="check">Clear</Chip>}</Kpi>
      </div>

      <section className="ad-panel">
        <div className="m-between"><h2>Event path — check-in to alert, queue and flows</h2><Chip tone={connected ? 'ok' : 'critical'} icon={connected ? 'check' : 'alert'}>{connected ? 'Broker connected' : 'Broker unreachable'}</Chip></div>
        <div className="ad-flow">
          <div className="ad-node"><strong>3 phone apps</strong>Caregiver PWA · Family · Nurse</div>
          {arrow}
          <div className="ad-node"><strong>API Gateway</strong>OAuth 2.0 JWT · RBAC · rate limit{ms('checkin')}</div>
          {arrow}
          <div className={`ad-node ${nodeClass('checkin')}`}><strong>Check-in</strong>Check-in + outbox in one DB transaction</div>
          {arrow}
          <div className={`ad-node ${connected ? '' : 'is-down'}`}><strong>RabbitMQ</strong>eldercare.events (topic exchange) · ack after commit
            <span className="ad-ms">DLX on</span>{dead > 0 && <span className="ad-ms is-warn">{dead} in DLQ</span>}</div>
          {arrow}
          <div className="ad-fan">
            <div className={`ad-node ${nodeClass('alert')}`}><strong>Alert service</strong>in-app alert + TextBee SMS · weather mashup{ms('alert')}</div>
            <div className={`ad-node ${nodeClass('clinic')}`}><strong>Clinic risk service</strong>risk score → priority · EMR via SOAP adapter{ms('clinic')}</div>
            <div className={`ad-node ${nodeClass('nodeRed')}`}><strong>Node-RED</strong>{svc.nodeRed ? <>SMS router · weather · DLQ monitor{ms('nodeRed')}</> : 'not deployed (set NODE_RED_URL)'}</div>
          </div>
        </div>
      </section>

      <section className="ad-panel">
        <div className="m-between"><h2>Queues</h2><span className="m-caption ad-checked"><Icon name="refresh" size={16} />Live depths checked at {live.at ? live.at.toLocaleTimeString('en-PH', { hour: 'numeric', minute: '2-digit' }) : ''}</span></div>
        <table className="ad-table">
          <thead><tr><th>Queue</th><th>Consumer</th><th>Messages</th><th>Consumers</th><th>Status</th></tr></thead>
          <tbody>
            {queues.map((q) => {
              const dlq = q.queue.endsWith('.dlq');
              return (
                <tr key={q.queue}>
                  <td>{q.queue}</td>
                  <td>{q.service}</td>
                  <td>{q.messages}</td>
                  <td>{q.consumers}</td>
                  <td>{dlq
                    ? (q.messages ? <Chip tone="moderate" icon="alert">Needs review</Chip> : <Chip icon="checkCircle">Empty</Chip>)
                    : (q.consumers ? <Chip tone="ok" icon="check">Consuming</Chip> : <Chip tone="critical" icon="alert">No consumer</Chip>)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

/* ------------------------------ service health ------------------------------ */
export function Health({ live }) {
  const { health, messaging } = live;
  if (!health) return <><Head title="Service health" sub="Each service, its own database, and the circuit breaker the gateway keeps for it." /><p className="ad-on-dark">Loading…</p></>;
  if (health.error) return <p className="m-error">{health.error}</p>;
  const breakers = Object.fromEntries((health.circuitBreakers || []).map((b) => [b.name, b]));
  const connected = messaging && messaging.services && messaging.services.every((s) => s.connected);
  const cards = [
    { key: 'gateway', name: 'API Gateway', sub: 'tokens · routing · rate limits', status: health.gateway, latency: null },
    ...health.services.map((s) => ({ key: s.name, ...(SERVICES[s.name] || { name: s.name, sub: '' }), status: s.status, latency: s.latencyMs, breaker: breakers[s.name] })),
    { key: 'rabbit', name: 'RabbitMQ', sub: `${queuesOf(messaging).length} queues incl. DLQs`, status: connected ? 'up' : 'down', latency: null, broker: true },
  ];
  return (
    <>
      <Head title="Service health" sub="Each service, its own database, and the circuit breaker the gateway keeps for it." live={live} />
      <div className="ad-health">
        {cards.map((c) => (
          <div key={c.key} className="ad-svc">
            <div className="ad-svc-top">
              <div className="m-grow"><strong>{c.name}</strong><span className="m-sub">{c.sub}</span></div>
              <Chip tone={c.status === 'up' ? 'ok' : c.status === 'degraded' ? 'moderate' : 'critical'} icon={c.status === 'up' ? 'check' : 'alert'}>{c.status === 'up' ? 'Up' : c.status === 'degraded' ? 'Degraded' : 'Down'}</Chip>
            </div>
            <div className="ad-svc-foot">
              <span>Latency {c.latency != null ? `${c.latency} ms` : '—'}</span>
              {c.broker ? <Chip tone={connected ? 'info' : 'critical'} icon="bell">{connected ? 'Connected' : 'Disconnected'}</Chip>
                : c.breaker ? <Chip tone={c.breaker.state === 'CLOSED' ? 'ok' : 'critical'} icon={c.breaker.state === 'CLOSED' ? 'check' : 'alert'}>Breaker {c.breaker.state.toLowerCase().replace('_', '-')}</Chip>
                  : c.key === 'gateway' ? <Chip tone="info" icon="bell">Entry point</Chip> : <Chip icon="checkCircle">No breaker</Chip>}
            </div>
          </div>
        ))}
      </div>
      <section className="ad-panel"><h2>Token security</h2><SecurityPanel /></section>
    </>
  );
}

/* ------------------------------ dead-letter queue ------------------------------ */
/** readOnly: a team-lead nurse sees the dead letters; replaying them stays with the admin. */
export function Dlq({ live, reload, readOnly = false }) {
  const [msg, setMsg] = useState('');
  const { messaging } = live;
  async function replay(q) {
    try {
      const r = await api('/api/admin/messaging/replay', { method: 'POST', body: { service: q.service, queue: q.queue } });
      setMsg(`${q.queue}: ${r.replayed ?? r.count ?? 0} message(s) sent back for processing.`);
      reload();
    } catch (e) { setMsg(e.message); }
  }
  const dlqs = queuesOf(messaging).filter((q) => q.queue.endsWith('.dlq'));
  return (
    <>
      <Head title="Dead-letter queue" sub={readOnly ? 'Messages that failed after all retries (5 s, 30 s, 2 min). The admin fixes the cause and replays them.' : 'Messages that failed after all retries (5 s, 30 s, 2 min). Fix the cause, then replay.'} live={live} />
      {msg && <p className="m-banner tone-info" role="status">{msg}</p>}
      <section className="ad-panel">
        <div className="m-between"><h2>Parked messages</h2><a className="m-btn ad-btn-auto" href={DLQ_DASHBOARD} target="_blank" rel="noreferrer">Open the Node-RED DLQ dashboard ↗</a></div>
        {!messaging && <p>Loading…</p>}
        <table className="ad-table is-boxed">
          <thead><tr><th>Queue</th><th>Service</th><th>Messages</th><th>Action</th></tr></thead>
          <tbody>
            {dlqs.map((q) => (
              <tr key={q.queue}>
                <td>{q.queue}</td><td>{q.service}</td>
                <td>{q.messages ? <Chip tone="moderate" icon="alert">{q.messages} parked</Chip> : <Chip icon="checkCircle">Empty</Chip>}</td>
                <td>{!readOnly && <button type="button" className="m-btn ad-btn-auto" disabled={!q.messages} onClick={() => replay(q)}>Replay</button>}</td>
              </tr>
            ))}
          </tbody>
        </table>
        {live.at && <p className="m-caption" style={{ marginTop: '.75rem' }}>Checked {relTime(live.at)}.</p>}
      </section>
    </>
  );
}

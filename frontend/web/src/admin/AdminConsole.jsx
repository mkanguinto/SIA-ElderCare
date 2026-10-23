// Admin web console (Figma A1 "Integration monitor" and A2 "Service health & users"): dark sidebar layout.
import React, { useCallback, useEffect, useState } from 'react';
import { api, logout } from '../api';
import { Link } from '../router';
import { relTime } from '../format';
import Icon from '../mobile/icons';
import { Chip } from '../mobile/kit';
import { SecurityPanel } from './SecurityPanel';
import { CareTeams } from './CareTeams';
import { Accounts, AuditLog } from './Accounts';
import { manilaDay } from '../mobile/kit';
import '../mobile/mobile.css';

const DLQ_DASHBOARD = import.meta.env.VITE_DLQ_DASHBOARD_URL || 'http://localhost:1880/dlq';
const SERVICES = {
  checkin: { name: 'Check-in service', sub: 'checkin_db · port 4001', icon: 'pulse' },
  alert: { name: 'Alert service', sub: 'alert_db · TextBee · OpenWeatherMap', icon: 'zap' },
  clinic: { name: 'Clinic risk service', sub: 'clinic_db · port 4003', icon: 'server' },
  legacyAdapter: { name: 'Legacy EMR adapter', sub: 'stateless · SOAP 1.1', icon: 'file' },
  care: { name: 'Care plan service', sub: 'care_db · port 4006', icon: 'clipboard' },
  nodeRed: { name: 'Node-RED', sub: 'SMS router · weather · DLQ monitor', icon: 'flow' },
};
const NAV = [
  { to: '/admin', label: 'Integration monitor', icon: 'flow' },
  { to: '/admin/health', label: 'Service health', icon: 'server' },
  { to: '/admin/users', label: 'Accounts', icon: 'users' },
  { to: '/admin/audit', label: 'Audit log', icon: 'shield' },
  { to: '/admin/care-teams', label: 'Care teams', icon: 'heartPulse' },
  { to: '/admin/dlq', label: 'Dead-letter queue', icon: 'inbox' },
  { to: '/admin/digest', label: 'Digest export', icon: 'file' },
];

/** /api/admin/health + /api/admin/messaging, refreshed every 5 s. */
function useLive() {
  const [state, setState] = useState({});
  const load = useCallback(() => Promise.all([
    api('/api/admin/health').catch((e) => ({ error: e.message })),
    api('/api/admin/messaging').catch((e) => ({ error: e.message })),
  ]).then(([health, messaging]) => setState({ health, messaging, at: new Date() })), []);
  useEffect(() => {
    load();
    const t = setInterval(load, 5000);
    return () => clearInterval(t);
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
  else if (sub === '/admin/digest') page = <DigestExport />;
  else page = <Monitor live={live} />;
  return (
    <div className="ad-app">
      <aside className="ad-side">
        <div className="ad-brand">
          <span className="m-brand-mark"><Icon name="heart" /></span>
          <div><strong>ElderCare</strong><small>{user.name} · admin</small></div>
        </div>
        <nav aria-label="Admin" style={{ display: 'contents' }}>
          {NAV.map((n) => <Link key={n.to} to={n.to} activeClassName="is-active"><Icon name={n.icon} />{n.label}</Link>)}
          <span className="ad-sep">Settings</span>
          <Link to="/clinic/alert-rules" activeClassName="is-active"><Icon name="sliders" />Alert rules</Link>
        </nav>
        <button type="button" className="ad-bottom" onClick={logout}><Icon name="logout" />Log out</button>
      </aside>
      <main className="ad-main" id="main">
        <p className="m-banner tone-info ad-phone-note" role="note"><Icon name="monitor" />The admin console is made for a computer. On a phone you can check status, but use a computer to manage the system.</p>
        {page}
      </main>
    </div>
  );
}

function Head({ title, sub, live }) {
  const h = live && live.health;
  const services = h && h.services ? h.services : [];
  const up = services.filter((s) => s.status === 'up').length + (h && h.gateway === 'up' ? 1 : 0);
  const all = services.length + 1;
  return (
    <header className="ad-head">
      <div><h1>{title}</h1><p>{sub}</p></div>
      {h && !h.error && <Chip tone={up === all ? 'ok' : 'critical'}><span style={{ width: '.55rem', height: '.55rem', borderRadius: '50%', background: 'currentColor', display: 'inline-block' }} />Live · {up === all ? `all ${all} services up` : `${all - up} of ${all} down`}</Chip>}
    </header>
  );
}

const queuesOf = (m) => ((m && m.services) || []).flatMap((s) => (s.queues || []).map((q) => ({ ...q, service: s.name })));

/* ------------------------------ A1 integration monitor ------------------------------ */
function Monitor({ live }) {
  const { health, messaging } = live;
  if (!health) return <><Head title="Integration monitor" sub="Live path of every event through the gateway, RabbitMQ and the services." /><p>Loading…</p></>;
  if (health.error) return <p className="m-error">{health.error}</p>;
  const svc = Object.fromEntries(health.services.map((s) => [s.name, s]));
  const queues = queuesOf(messaging);
  const depth = queues.filter((q) => !q.queue.endsWith('.dlq')).reduce((a, q) => a + q.messages, 0);
  const dead = queues.filter((q) => q.queue.endsWith('.dlq')).reduce((a, q) => a + q.messages, 0);
  const published = ['checkin', 'alert', 'clinic'].reduce((a, k) => a + ((((svc[k] || {}).details || {}).outbox || {}).delivered || 0), 0);
  const avgLatency = Math.round(health.services.reduce((a, s) => a + (s.latencyMs || 0), 0) / health.services.length);
  const connected = ((messaging && messaging.services) || []).every((s) => s.connected);
  const nodeClass = (name) => (!svc[name] ? 'is-off' : svc[name].status === 'up' ? '' : 'is-down');
  const ms = (name) => (svc[name] ? `${svc[name].latencyMs} ms` : '–');
  return (
    <>
      <Head title="Integration monitor" sub="Live path of every event through the gateway, RabbitMQ and the services. Updates every 5 s." live={live} />
      <div className="ad-kpis">
        <div className="ad-card ad-kpi"><small>Gateway → services (avg)</small><strong>{avgLatency} ms</strong><div className="m-between"><span>target ≤ 2.0 s</span><Chip tone={avgLatency <= 2000 ? 'ok' : 'critical'} icon="check">{avgLatency <= 2000 ? 'On target' : 'Slow'}</Chip></div></div>
        <div className="ad-card ad-kpi"><small>Events published</small><strong>{published}</strong><div className="m-between"><span>via eldercare.events</span><Chip tone="info" icon="bell">Fan-out ×3</Chip></div></div>
        <div className="ad-card ad-kpi"><small>Queue depth</small><strong>{depth}</strong><div className="m-between"><span>alert · clinic queues</span><Chip tone={depth < 50 ? 'ok' : 'moderate'} icon="check">{depth < 50 ? 'Healthy' : 'Backlog'}</Chip></div></div>
        <div className="ad-card ad-kpi"><small>Dead-lettered</small><strong>{dead}</strong><div className="m-between"><span>*.dlq</span>{dead ? <Link to="/admin/dlq"><Chip tone="moderate" icon="alert">Review</Chip></Link> : <Chip tone="ok" icon="check">Clear</Chip>}</div></div>
      </div>

      <section className="ad-panel">
        <div className="m-between"><h2>Event path — check-in to alert, queue and flows</h2><Chip tone={connected ? 'ok' : 'critical'} icon={connected ? 'check' : 'alert'}>{connected ? 'Broker connected' : 'Broker unreachable'}</Chip></div>
        <div className="ad-flow">
          <div className="ad-node"><strong><Icon name="users" size={18} />3 phone apps</strong>Caregiver PWA · Family · Nurse</div>
          <div className="ad-node"><strong><Icon name="shield" size={18} />API Gateway</strong>OAuth 2.0 JWT · RBAC · rate limit<span className="ad-ms">{ms('checkin')}</span></div>
          <div className={`ad-node ${nodeClass('checkin')}`}><strong><Icon name="pulse" size={18} />Check-in</strong>Check-in + outbox in one DB transaction</div>
          <div className={`ad-node ${connected ? '' : 'is-down'}`}><strong><Icon name="zap" size={18} />RabbitMQ</strong>eldercare.events (topic exchange) · ack after commit
            <div className="m-pills" style={{ marginTop: '.5rem' }}><Chip icon="checkCircle">DLX on</Chip>{dead > 0 && <Chip tone="moderate" icon="alert">{dead} in DLQ</Chip>}</div></div>
          <div className="ad-fan">
            <div className={`ad-node ${nodeClass('alert')}`}><strong><Icon name="alert" size={18} />Alert service</strong>{ms('alert')} · in-app alert + TextBee SMS · weather mashup</div>
            <div className={`ad-node ${nodeClass('clinic')}`}><strong><Icon name="server" size={18} />Clinic risk service</strong>{ms('clinic')} · risk score → priority · EMR via SOAP adapter</div>
            <div className={`ad-node ${nodeClass('nodeRed')}`}><strong><Icon name="flow" size={18} />Node-RED</strong>{svc.nodeRed ? `${ms('nodeRed')} · SMS router · weather · DLQ monitor` : 'not deployed (set NODE_RED_URL)'}</div>
          </div>
        </div>
      </section>

      <section className="ad-panel">
        <div className="m-between"><h2>Queues</h2><span className="m-caption">Live depths from RabbitMQ · checked {live.at ? live.at.toLocaleTimeString() : ''}</span></div>
        <table className="ad-table">
          <thead><tr><th>Queue</th><th>Consumer</th><th>Messages</th><th>Consumers</th><th>Status</th></tr></thead>
          <tbody>
            {queues.map((q) => {
              const dlq = q.queue.endsWith('.dlq');
              const tone = dlq ? (q.messages ? 'moderate' : 'ok') : q.consumers ? 'ok' : 'critical';
              return (
                <tr key={q.queue}>
                  <td><strong>{q.queue}</strong></td>
                  <td>{q.service}</td>
                  <td>{q.messages}</td>
                  <td>{q.consumers}</td>
                  <td><Chip tone={tone} icon={tone === 'ok' ? 'check' : 'alert'}>{dlq ? (q.messages ? 'Needs review' : 'Empty') : q.consumers ? 'Consuming' : 'No consumer'}</Chip></td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </section>
    </>
  );
}

/* ------------------------------ A2 service health ------------------------------ */
function Health({ live }) {
  const { health, messaging } = live;
  if (!health) return <><Head title="Service health" sub="Each service, its own database, and the circuit breaker the gateway keeps for it." /><p>Loading…</p></>;
  if (health.error) return <p className="m-error">{health.error}</p>;
  const breakers = Object.fromEntries((health.circuitBreakers || []).map((b) => [b.name, b]));
  const connected = messaging && messaging.services && messaging.services.every((s) => s.connected);
  const cards = [
    { key: 'gateway', name: 'API Gateway', sub: 'tokens · routing · rate limits', icon: 'shield', status: health.gateway, latency: null },
    ...health.services.map((s) => ({ key: s.name, ...(SERVICES[s.name] || { name: s.name, sub: '', icon: 'server' }), status: s.status, latency: s.latencyMs, breaker: breakers[s.name] })),
    { key: 'rabbit', name: 'RabbitMQ', sub: `${queuesOf(messaging).length} queues incl. DLQs`, icon: 'zap', status: connected ? 'up' : 'down', latency: null, broker: true },
  ];
  return (
    <>
      <Head title="Service health" sub="Each service, its own database, and the circuit breaker the gateway keeps for it." live={live} />
      <div className="ad-health">
        {cards.map((c) => (
          <div key={c.key} className="ad-svc">
            <div className="m-row">
              <span className="ad-svc-icon"><Icon name={c.icon} size={20} /></span>
              <div className="m-grow"><strong>{c.name}</strong><span className="m-sub">{c.sub}</span></div>
              <Chip tone={c.status === 'up' ? 'ok' : c.status === 'degraded' ? 'moderate' : 'critical'} icon={c.status === 'up' ? 'check' : 'alert'}>{c.status === 'up' ? 'Up' : c.status === 'degraded' ? 'Degraded' : 'Down'}</Chip>
            </div>
            <div className="ad-svc-foot">
              <span>Latency {c.latency != null ? `${c.latency} ms` : '—'}</span>
              {c.broker ? <Chip tone="info" icon="bell">{connected ? 'Connected' : 'Disconnected'}</Chip>
                : c.breaker ? <Chip tone={c.breaker.state === 'CLOSED' ? 'info' : 'critical'} icon="bell">Breaker: {c.breaker.state.toLowerCase()}</Chip>
                  : <Chip icon="checkCircle">{c.key === 'gateway' ? 'Entry point' : 'No breaker'}</Chip>}
            </div>
          </div>
        ))}
      </div>
      <section className="ad-panel"><h2 style={{ marginBottom: '1rem' }}>Token security</h2><SecurityPanel /></section>
    </>
  );
}

/* ------------------------------ A2 users & roles ------------------------------ */
/* ------------------------------ dead-letter queue ------------------------------ */
function Dlq({ live, reload }) {
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
      <Head title="Dead-letter queue" sub="Messages that failed after all retries (5 s, 30 s, 2 min). Fix the cause, then replay." live={live} />
      {msg && <p className="m-banner tone-info" role="status">{msg}</p>}
      <section className="ad-panel">
        <div className="m-between"><h2>Parked messages</h2><a className="m-link" href={DLQ_DASHBOARD} target="_blank" rel="noreferrer">Open the Node-RED DLQ dashboard ↗</a></div>
        {!messaging && <p>Loading…</p>}
        <table className="ad-table">
          <thead><tr><th>Queue</th><th>Service</th><th>Messages</th><th>Action</th></tr></thead>
          <tbody>
            {dlqs.map((q) => (
              <tr key={q.queue}>
                <td><strong>{q.queue}</strong></td><td>{q.service}</td>
                <td>{q.messages ? <Chip tone="moderate" icon="alert">{q.messages} parked</Chip> : <Chip tone="ok" icon="check">Empty</Chip>}</td>
                <td><button type="button" className="m-btn" style={{ minHeight: '2.5rem' }} disabled={!q.messages} onClick={() => replay(q)}>Replay</button></td>
              </tr>
            ))}
          </tbody>
        </table>
        {live.at && <p className="m-caption" style={{ marginTop: '.75rem' }}>Checked {relTime(live.at)}.</p>}
      </section>
    </>
  );
}

/* ------------------------------ daily digest export (JSON / XML) ------------------------------ */
// The nurse app shows the digest as a list; the machine-readable copies for the barangay health office
// and other systems live here, in the system console, not in the phone app.
const esc = (v) => String(v).replace(/[<>&'"]/g, (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' }[c]));
// The admin's digest is de-identified (Batch 3a): counts, case ages and statuses from
// GET /api/clinic/queue/summary - no patient names, ids, reasons or readings. Nurses see the named digest.
function buildDigest(q) {
  return {
    digest: {
      generatedAt: q.generatedAt, date: manilaDay(), deidentified: true,
      open: q.open, closedLast7Days: q.closedLast7Days, pendingHandovers: q.handovers,
      cases: q.cases,
    },
  };
}
function toXml(d) {
  const g = d.digest;
  const cases = g.cases.map((c) => `    <case ref="${esc(c.ref)}" priority="${c.priority}" category="${esc(c.category || '')}" status="${c.status}" handover="${c.handoverStatus}" assigned="${c.assigned}" ageHours="${c.ageHours}"/>`).join('\n');
  const p = g.open.byPriority;
  return `<?xml version="1.0" encoding="UTF-8"?>\n<digest date="${g.date}" generatedAt="${g.generatedAt}" deidentified="true">\n  <open total="${g.open.total}" p1="${p.P1}" p2="${p.P2}" p3="${p.P3}" p4="${p.P4}" unassigned="${g.open.unassigned}" olderThan24h="${g.open.olderThan24h}"/>\n  <closedLast7Days resolved="${g.closedLast7Days.resolved}" dismissed="${g.closedLast7Days.dismissed}"/>\n  <handovers pending="${g.pendingHandovers.pending}" overdue="${g.pendingHandovers.overdue}"/>\n  <cases>\n${cases}\n  </cases>\n</digest>`;
}
function download(name, type, text) {
  const url = URL.createObjectURL(new Blob([text], { type }));
  const a = document.createElement('a');
  a.href = url;
  a.download = name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function DigestExport() {
  const [q, setQ] = useState(null);
  const [tab, setTab] = useState('json');
  const load = useCallback(() => api('/api/clinic/queue/summary').then(setQ).catch((e) => setQ({ error: e.message })), []);
  useEffect(() => { load(); }, [load]);
  const digest = q && q.open ? buildDigest(q) : null;
  const text = digest ? (tab === 'json' ? JSON.stringify(digest, null, 2) : toXml(digest)) : '';
  return (
    <>
      <Head title="Daily digest export" sub="Workload counts in machine-readable form (JSON and XML) for the barangay health office and other systems. De-identified: no names, readings or reasons - those stay with the nurses." />
      <section className="ad-panel">
        <div className="m-between">
          <div className="m-seg" role="group" aria-label="Format" style={{ width: '16rem' }}>
            <button type="button" aria-pressed={tab === 'json'} onClick={() => setTab('json')}>JSON</button>
            <button type="button" aria-pressed={tab === 'xml'} onClick={() => setTab('xml')}>XML</button>
          </div>
          <div className="m-row">
            <button type="button" className="m-btn" onClick={load}><Icon name="refresh" size={18} />Rebuild</button>
            <button type="button" className="m-btn is-dark" disabled={!digest} onClick={() => download(`digest-${manilaDay()}.${tab}`, tab === 'json' ? 'application/json' : 'application/xml', text)}>Download .{tab}</button>
          </div>
        </div>
        {!q && <p>Loading…</p>}
        {q && q.error && <p className="m-error">{q.error}</p>}
        {digest && <pre className="m-code" style={{ marginTop: '1rem', maxHeight: '36rem' }}>{text}</pre>}
      </section>
    </>
  );
}

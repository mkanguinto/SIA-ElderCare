import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { PageHeader, Empty, ErrorNote, Loading } from '../components/ui';
import Icon from '../mobile/icons';
import { Chip, PRIORITY_TONE } from '../mobile/kit';
import Pager from '../components/Pager';
import { STATUS_LABEL, REASON_LABEL, VISIT_TYPE_LABEL, dateTime, relTime } from '../format';

function duration(h) {
  if (h == null) return '–';
  if (h < 1) return `${Math.max(1, Math.round(h * 60))} min`;
  if (h < 48) return `${Math.round(h)} h`;
  return `${Math.round(h / 24)} days`;
}

export default function CaseHistory() {
  const [outcome, setOutcome] = useState('');
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [data, setData] = useState(null);
  const [error, setError] = useState('');
  const [open, setOpen] = useState(null);
  const [page, setPage] = useState(1);

  const load = useCallback(() => {
    const q = new URLSearchParams({ page: String(page), pageSize: '25' });
    if (outcome) q.set('outcome', outcome);
    if (from) q.set('from', from);
    if (to) q.set('to', to);
    return api(`/api/clinic/queue/history?${q}`).then((r) => { setData(r); setError(''); }).catch((e) => setError(e.message));
  }, [outcome, from, to, page]);
  useEffect(() => { load(); }, [load]);
  useEffect(() => { setPage(1); }, [outcome, from, to]);

  return (
    <>
      <PageHeader title="Case history" subtitle="Resolved and dismissed cases, newest first. A case moves here when it is marked resolved, dismissed, or its visit is completed with “resolve case”." />
      {data && (
        <div className="ad-stat-cards">
          <div className="ad-stat tone-ok"><span className="ad-kpi-icon"><Icon name="checkCircle" size={22} /></span><span>Resolved</span><strong>{data.summary.resolved}</strong></div>
          <div className="ad-stat"><span className="ad-kpi-icon"><Icon name="x" size={22} /></span><span>Dismissed</span><strong>{data.summary.dismissed}</strong></div>
          <div className="ad-stat tone-moderate"><span className="ad-kpi-icon"><Icon name="calendar" size={22} /></span><span>Closed in the last 30 days</span><strong>{data.summary.last30days}</strong></div>
        </div>
      )}
      <section className="ad-panel">
        <div className="ad-filters">
          <div className="ad-field"><span>Outcome</span>
            <div className="m-seg" role="group" aria-label="Outcome">
              {[['', 'All'], ['resolved', 'Resolved'], ['dismissed', 'Dismissed']].map(([k, l]) => <button key={k} type="button" aria-pressed={outcome === k} onClick={() => setOutcome(k)}>{l}</button>)}
            </div>
          </div>
          <label className="ad-field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
          <label className="ad-field"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
        </div>
      <ErrorNote error={error} onRetry={load} />
      {!data && !error && <Loading label="Loading case history" />}
      {data && data.cases.length === 0 && <Empty title="No closed cases">Cases appear here after they are resolved or dismissed.</Empty>}
      {data && data.cases.length > 0 && (
          <table className="ad-table is-boxed history-table">
            <thead><tr><th>Patient</th><th>Priority</th><th>Outcome</th><th>Closed</th><th>Open for</th><th /></tr></thead>
            <tbody>
              {data.cases.map((c) => (
                <React.Fragment key={c.id}>
                  <tr>
                    <td><button type="button" className="link-btn ad-strong" onClick={() => navigate(`/clinic/patients/${encodeURIComponent(c.patient.id)}`)}>{c.patient.name}</button><span className="m-sub">{c.patient.id}</span></td>
                    <td><Chip tone={PRIORITY_TONE[c.priority]} icon={PRIORITY_TONE[c.priority] === 'ok' ? 'check' : 'alert'}>{c.priority}</Chip></td>
                    <td>{c.status === 'resolved' ? <Chip tone="ok" icon="check">{STATUS_LABEL[c.status]}</Chip> : <Chip icon="x">{STATUS_LABEL[c.status]}</Chip>}{c.resolutionNotes && <span className="m-sub ad-strong">{c.resolutionNotes}</span>}</td>
                    <td title={dateTime(c.resolvedAt)}>{relTime(c.resolvedAt)}</td>
                    <td>{duration(c.durationHours)}</td>
                    <td><button type="button" className="m-link" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Hide' : 'Details'}</button></td>
                  </tr>
                  {open === c.id && (
                    <tr className="history-detail">
                      <td colSpan="6">
                        <div className="layout-split">
                          <div>
                            <h4>Why it was opened</h4>
                            <ul className="plain-list">{c.reasons.slice(0, 6).map((r, i) => <li key={i}><span><strong>{REASON_LABEL[r.type] || r.type}:</strong> {r.detail}</span></li>)}</ul>
                            {c.visits.length > 0 && (<><h4>Visits</h4><ul className="plain-list">{c.visits.map((v) => <li key={v.id}><span>{VISIT_TYPE_LABEL[v.visit_type]} {v.visit_date} {v.visit_time}, {v.destination}: <strong>{v.status}</strong>{v.outcome ? `. ${v.outcome}` : ''}</span></li>)}</ul></>)}
                          </div>
                          <div>
                            <h4>Follow-up log</h4>
                            <ul className="plain-list">{c.followUps.map((f, i) => <li key={i}><span><strong>{f.action.replace(/_/g, ' ')}</strong>{f.notes ? `: ${f.notes}` : ''} <span className="muted small">by {f.performed_by}, {relTime(f.created_at)}</span></span></li>)}</ul>
                          </div>
                        </div>
                      </td>
                    </tr>
                  )}
                </React.Fragment>
              ))}
            </tbody>
          </table>
      )}
      {data && data.cases.length > 0 && <Pager pagination={data.pagination} onPage={setPage} label="cases" />}
      </section>
    </>
  );
}

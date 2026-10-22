import React, { useCallback, useEffect, useState } from 'react';
import { api } from '../api';
import { navigate } from '../router';
import { PageHeader, PriorityTag, Empty, ErrorNote, Loading } from '../components/ui';
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
        <dl className="stats stats-inline">
          <div><dt>Resolved</dt><dd>{data.summary.resolved}</dd></div>
          <div><dt>Dismissed</dt><dd>{data.summary.dismissed}</dd></div>
          <div><dt>Closed in the last 30 days</dt><dd>{data.summary.last30days}</dd></div>
        </dl>
      )}
      <div className="filters">
        <label className="field"><span>Outcome</span>
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)}><option value="">All</option><option value="resolved">Resolved</option><option value="dismissed">Dismissed</option></select>
        </label>
        <label className="field"><span>From</span><input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <label className="field"><span>To</span><input type="date" value={to} onChange={(e) => setTo(e.target.value)} /></label>
      </div>
      <ErrorNote error={error} onRetry={load} />
      {!data && !error && <Loading label="Loading case history" />}
      {data && data.cases.length === 0 && <Empty title="No closed cases">Cases appear here after they are resolved or dismissed.</Empty>}
      {data && data.cases.length > 0 && (
        <section className="panel panel-flush">
          <table className="table history-table">
            <thead><tr><th>Patient</th><th>Priority</th><th>Outcome</th><th>Closed</th><th>Open for</th><th /></tr></thead>
            <tbody>
              {data.cases.map((c) => (
                <React.Fragment key={c.id}>
                  <tr>
                    <td><button type="button" className="link-btn" onClick={() => navigate(`/clinic/patients/${encodeURIComponent(c.patient.id)}`)}>{c.patient.name}</button><br /><span className="muted small">{c.patient.id}</span></td>
                    <td><PriorityTag value={c.priority} /></td>
                    <td><strong>{STATUS_LABEL[c.status]}</strong>{c.resolutionNotes && <><br /><span className="small">{c.resolutionNotes}</span></>}</td>
                    <td title={dateTime(c.resolvedAt)}>{relTime(c.resolvedAt)}</td>
                    <td>{duration(c.durationHours)}</td>
                    <td><button type="button" className="btn btn-quiet btn-sm" aria-expanded={open === c.id} onClick={() => setOpen(open === c.id ? null : c.id)}>{open === c.id ? 'Hide' : 'Details'}</button></td>
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
          <Pager pagination={data.pagination} onPage={setPage} label="cases" />
        </section>
      )}
    </>
  );
}

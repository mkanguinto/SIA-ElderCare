import React from 'react';

/** Previous / next controls for the API's `pagination` envelope (Batch 2). */
export default function Pager({ pagination, onPage, label = 'items' }) {
  if (!pagination || pagination.totalPages <= 1) return null;
  const { page, pageSize, totalItems, totalPages, hasPrev, hasNext } = pagination;
  const first = (page - 1) * pageSize + 1;
  const last = Math.min(page * pageSize, totalItems);
  return (
    <nav className="pager" aria-label="Pages">
      <span className="muted small">{first}–{last} of {totalItems} {label}</span>
      <div className="btn-row">
        <button type="button" className="btn btn-secondary btn-sm" disabled={!hasPrev} onClick={() => onPage(page - 1)}>Previous</button>
        <span className="small">Page {page} of {totalPages}</span>
        <button type="button" className="btn btn-secondary btn-sm" disabled={!hasNext} onClick={() => onPage(page + 1)}>Next</button>
      </div>
    </nav>
  );
}

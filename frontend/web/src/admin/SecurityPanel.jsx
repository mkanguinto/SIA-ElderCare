// JWT key ids, rotation schedule and session counters (GET /api/admin/security). No key material is shown.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNote, Loading } from '../components/ui';

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

// JWT key ids, rotation schedule and session counters (GET /api/admin/security). No key material is shown.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { ErrorNote, Loading } from '../components/ui';
import Icon from '../mobile/icons';
import { Chip } from '../mobile/kit';

const SECURITY_DOC = 'https://github.com/mkanguinto/SIA-ElderCare/blob/main/docs/SECURITY.md';

export function SecurityPanel() {
  const [s, setS] = useState(null);
  const [error, setError] = useState('');
  useEffect(() => { api('/api/admin/security').then((r) => setS(r.jwt)).catch((e) => setError(e.message)); }, []);
  if (error) return <ErrorNote error={error} />;
  if (!s) return <Loading />;
  const r = s.rotation;
  return (
    <>
      <dl className="ad-facts">
        <div><dt>Signing key</dt><dd>{s.access.activeKid} ({s.algorithm})</dd>{s.access.verifyOnlyKids.length > 0 && <span className="m-sub">still accepted: {s.access.verifyOnlyKids.join(', ')}</span>}</div>
        <div><dt>Refresh key</dt><dd>{s.refresh.activeKid}</dd>{s.refresh.verifyOnlyKids.length > 0 && <span className="m-sub">still accepted: {s.refresh.verifyOnlyKids.join(', ')}</span>}</div>
        <div><dt>Key rotation</dt><dd>{r.intervalDays}-day schedule</dd>
          {r.nextRotationDue
            ? <Chip tone={r.overdue ? 'critical' : 'ok'} icon={r.overdue ? 'alert' : 'check'}>{r.overdue ? 'Overdue since' : 'Next by'} {r.nextRotationDue.slice(0, 10)}</Chip>
            : <Chip tone="high" icon="alert">JWT_KEY_ROTATED_AT not set</Chip>}</div>
        <div><dt>Active sessions</dt><dd>{s.store.activeSessions} active · {s.store.revokedSessions} ended</dd>
          <span className="m-sub">{s.store.deniedAccessTokens} revoked access tokens{!s.store.persistent && <strong className="text-critical"> · not persisted</strong>}</span></div>
      </dl>
      <div className="ad-facts-foot">
        <span>How to rotate keys without signing anyone out: docs/SECURITY.md</span>
        <a className="m-link" href={SECURITY_DOC} target="_blank" rel="noreferrer"><Icon name="file" size={18} />View Security Docs</a>
      </div>
    </>
  );
}

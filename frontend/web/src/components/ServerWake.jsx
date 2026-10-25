// Free cloud hosting puts idle services to sleep. When the app opens it asks the gateway to wake every
// service (GET /health/wake) and shows a notice until all of them answer; while the app stays open it
// pings again every few minutes so nothing falls asleep in the middle of a demo - but only while the page is on
// screen: a tab left open in the background must not keep every free service running (that uses up the free
// plan's monthly hours, and Render then suspends the services until the month ends).
import React, { useEffect, useState } from 'react';
import { BASE } from '../api';

const KEEP_AWAKE_MS = 4 * 60 * 1000;
const RETRY_MS = 4000;

export default function ServerWake() {
  const [state, setState] = useState('checking'); // checking | waking | ready
  const [since] = useState(Date.now());
  const [, tick] = useState(0);

  useEffect(() => {
    let live = true;
    let timer;
    const ping = async () => {
      let ready = false;
      try {
        const r = await fetch(`${BASE}/health/wake`, { cache: 'no-store' });
        ready = r.ok && (await r.json()).ready;
      } catch { /* gateway itself is still starting */ }
      if (!live) return;
      setState((s) => (ready ? 'ready' : s === 'ready' ? 'ready' : 'waking'));
      timer = setTimeout(ready ? keepAwake : ping, ready ? KEEP_AWAKE_MS : RETRY_MS);
    };
    const keepAwake = () => {
      if (document.visibilityState === 'visible') return ping();
      if (live) timer = setTimeout(keepAwake, KEEP_AWAKE_MS);
      return undefined;
    };
    const onShow = () => { if (document.visibilityState === 'visible') { clearTimeout(timer); ping(); } };
    document.addEventListener('visibilitychange', onShow);
    ping();
    const t = setInterval(() => tick((n) => n + 1), 1000);
    return () => { live = false; clearTimeout(timer); clearInterval(t); document.removeEventListener('visibilitychange', onShow); };
  }, []);

  if (state !== 'waking') return null;
  const secs = Math.round((Date.now() - since) / 1000);
  return (
    <div className="server-wake" role="status" aria-live="polite">
      <span className="server-wake-spin" aria-hidden="true" />
      <span><strong>Starting the servers…</strong> The free cloud plan sleeps when nobody is using it, so the first visit takes about a minute ({secs}s).</span>
    </div>
  );
}

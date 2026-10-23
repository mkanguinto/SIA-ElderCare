// Inactivity lock (Batch 3a). After the idle limit with no taps, keys or scrolling (15 min for nurses and
// admin, 30 min for caregivers and family - the server sends the number at sign-in) the app locks: the server
// refuses the session's tokens and this screen covers the page until the password is entered. Background
// polling does not count as activity. Signing out from here ends the session.
import React, { useEffect, useRef, useState } from 'react';
import { idleLockMinutes, isLocked, lockNow, logout, onLockChange, unlock } from '../api';
import Icon from '../mobile/icons';
import '../mobile/mobile.css';

const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'];

export function useIdleLock() {
  const last = useRef(Date.now());
  useEffect(() => {
    const seen = () => { last.current = Date.now(); };
    const check = () => {
      if (!isLocked() && Date.now() - last.current > idleLockMinutes() * 60000) lockNow();
    };
    ACTIVITY.forEach((e) => window.addEventListener(e, seen, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', check);
    const t = setInterval(check, 15000);
    return () => {
      ACTIVITY.forEach((e) => window.removeEventListener(e, seen, { capture: true }));
      document.removeEventListener('visibilitychange', check);
      clearInterval(t);
    };
  }, []);
}

export default function SessionLock({ user, children }) {
  const [locked, setLocked] = useState(isLocked());
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  useIdleLock();
  useEffect(() => onLockChange(setLocked), []);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await unlock(password);
      setPassword('');
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <>
      <div aria-hidden={locked || undefined} inert={locked ? '' : undefined} style={locked ? { visibility: 'hidden' } : undefined}>{children}</div>
      {locked && (
        <div className="m-lock" role="dialog" aria-modal="true" aria-labelledby="lock-title">
          <form className="m-lock-card m-stack" onSubmit={submit}>
            <span className="m-brand-mark" style={{ width: '3rem', height: '3rem', margin: '0 auto' }} aria-hidden="true"><Icon name="shield" size={24} /></span>
            <h1 id="lock-title" style={{ fontSize: '1.5rem', textAlign: 'center' }}>Locked</h1>
            <p className="m-muted" style={{ textAlign: 'center' }}>
              No activity for {idleLockMinutes()} minutes, so the app locked to protect patient information.
              <span className="m-sub" style={{ display: 'block' }}>Naka-lock dahil walang galaw. Ilagay ang password para magpatuloy.</span>
            </p>
            <p style={{ textAlign: 'center', fontWeight: 700 }}>{user.name}</p>
            <label className="m-field"><span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
            </label>
            {error && <p className="m-error" role="alert">{error}</p>}
            <button type="submit" className="m-cta" disabled={busy || !password}>{busy ? 'Unlocking…' : 'Unlock'}</button>
            <button type="button" className="m-link" onClick={logout}>Sign out instead</button>
          </form>
        </div>
      )}
    </>
  );
}

// Inactivity lock (Batch 3a). After the idle limit with no taps, keys or scrolling (15 min for nurses and
// admin, 30 min for caregivers and family - the server sends the number at sign-in) the app locks: the server
// refuses the session's tokens and this screen covers the page until the password is entered. Background
// polling does not count as activity. Two minutes before the lock a warning counts down with a "Stay signed in"
// button. Unsent entries (drafts) stay in their forms through the lock; signing out from here warns before it
// discards them.
import React, { useEffect, useRef, useState } from 'react';
import { draftCount, idleLockMinutes, isLocked, lockNow, onLockChange, requestSignOut, unlock } from '../api';
import Icon from '../mobile/icons';
import '../mobile/mobile.css';

const ACTIVITY = ['pointerdown', 'keydown', 'touchstart', 'wheel', 'scroll'];
export const WARN_SECONDS = 120;

/** @returns {[number|null, () => void]} seconds left while the warning shows (else null), and "stay signed in" */
export function useIdleLock() {
  const last = useRef(Date.now());
  const [left, setLeft] = useState(null);
  useEffect(() => {
    const seen = () => { last.current = Date.now(); setLeft(null); };
    const check = () => {
      if (isLocked()) { setLeft(null); return; }
      const remain = idleLockMinutes() * 60 - (Date.now() - last.current) / 1000;
      if (remain <= 0) { setLeft(null); lockNow(); } else setLeft(remain <= WARN_SECONDS ? Math.ceil(remain) : null);
    };
    ACTIVITY.forEach((e) => window.addEventListener(e, seen, { passive: true, capture: true }));
    document.addEventListener('visibilitychange', check);
    const t = setInterval(check, 1000);
    const offLock = onLockChange((locked) => { if (!locked) seen(); }); // unlocking starts a fresh idle period
    return () => {
      offLock();
      ACTIVITY.forEach((e) => window.removeEventListener(e, seen, { capture: true }));
      document.removeEventListener('visibilitychange', check);
      clearInterval(t);
    };
  }, []);
  return [left, () => { last.current = Date.now(); setLeft(null); }];
}

const mmss = (sec) => `${Math.floor(sec / 60)}:${String(sec % 60).padStart(2, '0')}`;

function IdleWarning({ left, stay }) {
  return (
    <div className="m-idle-warn" role="alertdialog" aria-labelledby="idle-warn-text">
      <p id="idle-warn-text">
        Still there? The app locks in <strong aria-live="off">{mmss(left)}</strong> to protect patient information.
        {draftCount() ? ' Anything you have not sent is kept.' : ''}
        <span style={{ display: 'block', opacity: 0.8, fontSize: '.85rem' }}>Magla-lock ang app kung walang galaw.</span>
      </p>
      <button type="button" onClick={stay}>Stay signed in</button>
    </div>
  );
}

export default function SessionLock({ user, children }) {
  const [locked, setLocked] = useState(isLocked());
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [left, stay] = useIdleLock();
  useEffect(() => onLockChange(setLocked), []);
  const kept = locked ? draftCount() : 0;

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
      {!locked && left !== null && <IdleWarning left={left} stay={stay} />}
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
            <p className="m-caption" style={{ textAlign: 'center' }}>
              {kept ? `Your unsent ${kept === 1 ? 'entry is' : 'entries are'} kept: unlock to finish ${kept === 1 ? 'it' : 'them'}.` : 'Unlock to continue where you were.'}
            </p>
            <label className="m-field"><span>Password</span>
              <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required autoFocus />
            </label>
            {error && <p className="m-error" role="alert">{error}</p>}
            <button type="submit" className="m-cta" disabled={busy || !password}>{busy ? 'Unlocking…' : 'Unlock'}</button>
            <button type="button" className="m-link" onClick={requestSignOut}>Sign out instead</button>
          </form>
        </div>
      )}
    </>
  );
}

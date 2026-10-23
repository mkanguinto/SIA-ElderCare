import React, { useEffect, useRef, useState } from 'react';
import { Link } from '../router';
import { ROLE_LABEL, initials } from '../format';
import { switchAccount } from '../api';
import { DEMO, DEMO_PASSWORD } from '../demoAccounts';

const CLINIC_NAV = [
  { to: '/clinic', label: 'Risk queue', exact: true },
  { to: '/clinic/visits', label: 'Visits' },
  { to: '/clinic/history', label: 'Case history' },
  { to: '/clinic/patients/new', label: 'Add patient' },
  { to: '/clinic/alert-rules', label: 'Alert rules' },
];
const NAV = {
  clinic_staff: [...CLINIC_NAV, { to: '/m/nurse', label: 'Phone view' }],
  system_admin: [{ to: '/admin', label: 'Admin console' }, ...CLINIC_NAV],
};

export function Logo({ size = 28 }) {
  return (
    <svg width={size} height={size} viewBox="0 0 32 32" aria-hidden="true" className="logo">
      <path d="M16 28s-11-6.6-11-15A6 6 0 0 1 16 9.6 6 6 0 0 1 27 13c0 8.4-11 15-11 15z" fill="currentColor" opacity=".16" />
      <path d="M4 17h6l2.5-5 4 10 3-7 1.5 2H28" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

/**
 * Account menu: sign out, or switch account in one step (no manual sign-out first).
 * Switching discards the old tokens and all page state before the new user's data loads.
 */
function AccountMenu({ user, onSignOut }) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');
  const ref = useRef(null);

  useEffect(() => {
    if (!open) return undefined;
    const close = (e) => { if (ref.current && !ref.current.contains(e.target)) setOpen(false); };
    const esc = (e) => { if (e.key === 'Escape') setOpen(false); };
    document.addEventListener('mousedown', close);
    document.addEventListener('keydown', esc);
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc); };
  }, [open]);

  async function switchTo(username) {
    setBusy(username);
    setError('');
    try {
      await switchAccount(username, DEMO_PASSWORD);
    } catch (e) {
      setError(e.message);
      setBusy(null);
    }
  }

  const others = DEMO.filter((d) => d.name !== user.name);
  return (
    <div className="account" ref={ref}>
      <button type="button" className="account-trigger" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="avatar" aria-hidden="true">{initials(user.name)}</span>
        <span className="account-text">
          <strong>{user.name}</strong>
          <span>{ROLE_LABEL[user.role]}</span>
        </span>
        <span className="chevron" aria-hidden="true">▾</span>
      </button>
      {open && (
        <div className="account-menu" role="menu">
          {import.meta.env.DEV && (
            <>
              <p className="menu-label">Switch to a demo account</p>
              {others.map((d) => (
                <button key={d.username} type="button" role="menuitem" className="menu-item" disabled={!!busy} onClick={() => switchTo(d.username)}>
                  <strong>{d.role}</strong>
                  <span>{busy === d.username ? 'Switching…' : d.name}</span>
                </button>
              ))}
              <hr />
            </>
          )}
          <button type="button" role="menuitem" className="menu-item" onClick={() => { setOpen(false); onSignOut(); }}>
            <strong>Sign out</strong>
            <span>Clears this session so someone else can sign in</span>
          </button>
          {error && <p className="note note-error small">{error}</p>}
        </div>
      )}
    </div>
  );
}

export default function Shell({ user, onSignOut, children }) {
  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <Logo />
          <span>ElderCare Connect</span>
        </div>
        <nav aria-label="Main">
          {(NAV[user.role] || []).map((item) => (
            <Link key={item.to} to={item.to} exact={item.exact !== false} className="nav-link">{item.label}</Link>
          ))}
        </nav>
        <AccountMenu user={user} onSignOut={onSignOut} />
      </aside>
      <main className="content" id="main">{children}</main>
    </div>
  );
}

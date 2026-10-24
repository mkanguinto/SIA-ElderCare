// Building blocks for the phone-first screens (Figma "Components" page): frame, nav, buttons, chips, banners.
import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import Icon from './icons';
import { Link, navigate } from '../router';
import { initials } from '../format';
import './mobile.css';

/* ------------------------------ preferences ------------------------------ */
// Language and Big text are per-device conveniences, so they live in localStorage (wrapped: it may be blocked).
const PREFS_KEY = 'eldercare.prefs';
function readPrefs() {
  try { return { lang: 'en', big: false, ...JSON.parse(localStorage.getItem(PREFS_KEY)) }; } catch { return { lang: 'en', big: false }; }
}
const PrefsContext = createContext({ lang: 'en', big: false, setPrefs: () => {} });

export function PrefsProvider({ children }) {
  const [prefs, setState] = useState(readPrefs);
  const setPrefs = useCallback((patch) => setState((p) => {
    const next = { ...p, ...patch };
    try { localStorage.setItem(PREFS_KEY, JSON.stringify(next)); } catch { /* keep in memory */ }
    return next;
  }), []);
  // Big text scales every rem on the page; restore the default when leaving the phone UI.
  useEffect(() => {
    document.documentElement.style.fontSize = prefs.big ? '118.75%' : '';
    document.documentElement.lang = prefs.lang === 'fil' ? 'fil' : 'en';
    return () => { document.documentElement.style.fontSize = ''; };
  }, [prefs.big, prefs.lang]);
  return <PrefsContext.Provider value={{ ...prefs, setPrefs }}>{children}</PrefsContext.Provider>;
}
export const usePrefs = () => useContext(PrefsContext);

/** useT() returns tr(english, filipino): screens carry both strings inline instead of a key catalogue. */
export function useT() {
  const { lang } = usePrefs();
  return useCallback((en, fil) => (lang === 'fil' && fil ? fil : en), [lang]);
}

/* ------------------------------ time helpers ------------------------------ */
const TZ = 'Asia/Manila';
export const manilaHour = (d = new Date()) => Number(new Intl.DateTimeFormat('en-US', { timeZone: TZ, hour: 'numeric', hourCycle: 'h23' }).format(d));
export const manilaDay = (d = new Date()) => new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(new Date(d));
export const clock = (d) => new Date(d).toLocaleTimeString('en-PH', { timeZone: TZ, hour: 'numeric', minute: '2-digit' });
export const isToday = (ts) => Boolean(ts) && manilaDay(ts) === manilaDay();
/** "08:00" -> "8:00 AM" */
export const hhmm = (t) => {
  const [h, m] = t.split(':').map(Number);
  return `${((h + 11) % 12) + 1}:${String(m).padStart(2, '0')} ${h < 12 ? 'AM' : 'PM'}`;
};
export function useGreeting() {
  const tr = useT();
  const h = manilaHour();
  if (h < 12) return tr('Good morning,', 'Magandang umaga,');
  if (h < 18) return tr('Good afternoon,', 'Magandang hapon,');
  return tr('Good evening,', 'Magandang gabi,');
}

/* ------------------------------ severity -> tone ------------------------------ */
export const TONE = { none: 'ok', low: 'ok', moderate: 'moderate', high: 'high', critical: 'critical' };
export const PRIORITY_TONE = { P1: 'critical', P2: 'high', P3: 'moderate', P4: 'ok' };
export const AVATAR_TONES = ['', 'tone-amber', 'tone-blue', 'tone-rose'];
export const toneFor = (seed = '') => AVATAR_TONES[[...seed].reduce((a, c) => a + c.charCodeAt(0), 0) % AVATAR_TONES.length];
/** Patient display name without the long surname: "Lola Remedios Dela Cruz" -> "Lola Remedios". */
export const shortName = (n = '') => n.split(' ').slice(0, 2).join(' ');

/* ------------------------------ layout ------------------------------ */
export function MobileFrame({ children, plain = false, emergency = false, light = false }) {
  return (
    <div className={`m-root ${light ? 'is-light' : ''}`}>
      <main className={`m-app ${plain ? 'is-plain' : ''} ${emergency ? 'has-emergency' : ''} ${light ? 'is-light' : ''}`} id="main">
        {emergency && <EmergencyBar />}
        {children}
      </main>
    </div>
  );
}

/**
 * Health safeguard: the emergency number is on every caregiver and family screen (also inside the
 * check-in), because this app is not an emergency service and a check-in is not a call for help.
 */
export function EmergencyBar() {
  const tr = useT();
  return (
    <aside className="m-emergency" role="note" aria-label={tr('Emergency', 'Emergency')}>
      <Icon name="alert" size={16} strokeWidth={2.4} />
      <span>{tr('Emergency? Do not wait for the app.', 'Emergency? Huwag maghintay sa app.')}</span>
      <a href={`tel:${EMERGENCY_PHONE}`}>{tr(`Call ${EMERGENCY_PHONE}`, `Tumawag sa ${EMERGENCY_PHONE}`)}</a>
      {CLINIC_PHONE && <a href={`tel:${CLINIC_PHONE}`}>{tr('Clinic', 'Klinika')}</a>}
    </aside>
  );
}

export function BottomNav({ items }) {
  const tr = useT();
  return (
    <nav className="m-nav" aria-label={tr('Main', 'Pangunahin')}>
      {items.map((it) => (
        <Link key={it.to} to={it.to} exact={it.exact !== false} activeClassName="is-active" aria-label={it.label} title={it.label}>
          <Icon name={it.icon} />
          <span className="m-nav-label">{it.label}</span>
        </Link>
      ))}
    </nav>
  );
}

export function Greeting({ user, alerts = 0, alertsTo, hello }) {
  const tr = useT();
  const greet = useGreeting();
  return (
    <header className="m-greet">
      <span className={`m-avatar ${toneFor(user.name)}`} aria-hidden="true">{initials(user.name)}</span>
      <div className="m-grow">
        <small>{hello || greet}</small>
        <strong>{user.name}</strong>
      </div>
      {alertsTo && (
        <Link to={alertsTo} className="m-icon-btn" aria-label={alerts ? tr(`Alerts, ${alerts} new`, `Mga alerto, ${alerts} bago`) : tr('Alerts', 'Mga alerto')}>
          <Icon name="bell" />
          {alerts > 0 && <span className="m-dot" />}
        </Link>
      )}
    </header>
  );
}

export function TopBar({ title, back, action }) {
  const tr = useT();
  const goBack = () => (typeof back === 'string' ? navigate(back) : window.history.back());
  return (
    <header className="m-topbar">
      {back ? <button type="button" className="m-icon-btn" onClick={goBack} aria-label={tr('Back', 'Bumalik')}><Icon name="back" /></button> : <span />}
      <h1>{title}</h1>
      {action || <span />}
    </header>
  );
}

export function Cta({ children, onClick, disabled, type = 'button', href }) {
  const inner = <>{children}<span className="m-cta-arrow" aria-hidden="true"><Icon name="arrowRight" size={20} /></span></>;
  if (href) return <Link to={href} className="m-cta">{inner}</Link>;
  return <button type={type} className="m-cta" onClick={onClick} disabled={disabled}>{inner}</button>;
}

export function Chip({ tone, icon, children, className = '' }) {
  return <span className={`m-chip ${tone ? `tone-${tone}` : ''} ${className}`}>{icon && <Icon name={icon} size={15} strokeWidth={2.4} />}{children}</span>;
}

export function Banner({ tone = 'info', icon = 'alert', children, role }) {
  return <div className={`m-banner tone-${tone}`} role={role}><Icon name={icon} /><div>{children}</div></div>;
}

export function Ring({ value, size = 76, stroke = 9, color = 'var(--bg-primary)', track = '#fff', label }) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  return (
    <div className="m-ring" style={{ width: size, height: size }} role="img" aria-label={label}>
      <svg width={size} height={size}>
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={track} strokeWidth={stroke} />
        <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke={color} strokeWidth={stroke} strokeLinecap="round"
          strokeDasharray={c} strokeDashoffset={c * (1 - Math.max(0, Math.min(1, value)))} />
      </svg>
      <span aria-hidden="true">{Math.round(value * 100)}%</span>
    </div>
  );
}

export function Loader({ label }) {
  const tr = useT();
  return <p className="m-muted" role="status" style={{ padding: '2rem 0', textAlign: 'center' }}>{label || tr('Loading…', 'Naglo-load…')}</p>;
}

/** Simple top toast for the phone screens. */
export function useMobileToast() {
  const [msg, setMsg] = useState(null);
  useEffect(() => {
    if (!msg) return undefined;
    const t = setTimeout(() => setMsg(null), 3500);
    return () => clearTimeout(t);
  }, [msg]);
  const node = msg ? <div className="m-toast" role="status">{msg}</div> : null;
  return [node, setMsg];
}

/** Language switch (EN / FIL) as on the Welcome and Log in frames. */
export function LangSwitch() {
  const { lang, setPrefs } = usePrefs();
  return (
    <div className="m-lang" role="group" aria-label="Language / Wika">
      <button type="button" aria-pressed={lang === 'en'} onClick={() => setPrefs({ lang: 'en' })}>EN</button>
      <button type="button" aria-pressed={lang === 'fil'} onClick={() => setPrefs({ lang: 'fil' })}>FIL</button>
    </div>
  );
}

/** The walking caregiver illustration: four Figma frames swapped by CSS steps (no JS, honours reduced motion). */
export function CaregiverWalk({ small = false }) {
  return (
    <div className={`m-walk ${small ? 'is-small' : ''}`} aria-hidden="true">
      {[1, 2, 3, 4].map((i) => <img key={i} src={`/brand/walk-${i}.svg`} alt="" />)}
    </div>
  );
}

export function BrandMark({ size = 22 }) {
  return <span className="m-brand-mark"><Icon name="heart" size={size} /></span>;
}

/** Phone numbers for the call buttons. The clinic hotline is configurable; 911 is the PH national emergency number. */
export const CLINIC_PHONE = import.meta.env.VITE_CLINIC_PHONE || '';
export const EMERGENCY_PHONE = '911';

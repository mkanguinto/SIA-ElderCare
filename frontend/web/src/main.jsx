import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { currentUser, hasNotice, requestSignOut, onSessionChange, onUserUpdate, refreshLinks } from './api';
import { matchRoute, navigate, usePath } from './router';
import ClinicConsole from './clinic/ClinicConsole';
import { PrefsProvider } from './mobile/kit';
import { Landing, RolePicker, SignIn, NoAccount } from './mobile/Onboarding';
import { Activate, ResetPassword } from './mobile/Account';
import SessionLock from './components/SessionLock';
import CaregiverApp from './mobile/caregiver';
import FamilyApp from './mobile/family';
import NurseApp from './mobile/nurse';
import AdminConsole from './admin/AdminConsole';
import ServerWake from './components/ServerWake';
import './styles.css';

// Caregivers and families use only the phone app (on a computer it is shown in a phone-sized frame).
// Nurses get the phone app on small screens and the clinic console on a computer - the same screens and
// design in a web layout (each links to the other). Admins use the admin console, built the same way.
const isPhone = () => window.matchMedia('(max-width: 820px)').matches;
export const HOME = {
  caregiver: '/m/caregiver',
  family_member: '/m/family',
  clinic_staff: '/clinic',
  system_admin: '/admin',
};
const homeFor = (role) => (role === 'clinic_staff' && isPhone() ? '/m/nurse' : HOME[role] || '/');

const PUBLIC = { '/': Landing, '/start': RolePicker, '/signin': SignIn, '/no-account': NoAccount, '/activate': Activate, '/reset-password': ResetPassword };
// Every entry renders full-screen and handles its own sub-paths. The clinic console shows patient
// records: nurses only (the admin's alert-rule settings are in the admin console).
const ROUTES = {
  '/m/caregiver': { roles: ['caregiver'], app: CaregiverApp, layout: 'mobile', title: 'Caregiver' },
  '/m/family': { roles: ['family_member'], app: FamilyApp, layout: 'mobile', title: 'Family' },
  '/m/nurse': { roles: ['clinic_staff'], app: NurseApp, layout: 'mobile', title: 'Nurse' },
  '/clinic': { roles: ['clinic_staff'], app: ClinicConsole, layout: 'desktop', title: 'Clinic' },
  '/admin': { roles: ['system_admin'], app: AdminConsole, layout: 'admin', title: 'Admin' },
};
const MOBILE_PREFIXES = Object.keys(ROUTES).filter((k) => ROUTES[k].app);

function resolve(path) {
  const clean = path.replace(/\/+$/, '') || '/';
  const prefix = MOBILE_PREFIXES.find((p) => clean === p || clean.startsWith(`${p}/`));
  if (prefix) return { route: ROUTES[prefix], params: {} };
  const match = matchRoute(Object.keys(ROUTES), clean);
  return match ? { route: ROUTES[match.pattern], params: match.params } : { route: null, params: {} };
}

function App() {
  const [user, setUser] = useState(currentUser());
  const path = usePath();

  // One place reacts to every identity change (sign-in, sign-out, account switch, expired session):
  // all page state is dropped because the layout and the page are keyed by the user ID below.
  useEffect(() => onUserUpdate(setUser), []);
  // Caregivers and family see a newly linked elder without signing in again: fresh links when the app opens and
  // whenever it comes back on screen (at most once a minute).
  const scoped = user && ['caregiver', 'family_member'].includes(user.role);
  useEffect(() => {
    if (!scoped) return undefined;
    let last = 0;
    const check = () => { if (document.visibilityState === 'visible' && Date.now() - last > 60000) { last = Date.now(); refreshLinks(); } };
    check();
    document.addEventListener('visibilitychange', check);
    return () => document.removeEventListener('visibilitychange', check);
  }, [scoped]);
  useEffect(() => onSessionChange((next) => {
    setUser(next);
    // Signed out for a reason (another device, session ended): go to Sign in, which explains it.
    navigate(next ? homeFor(next.role) : hasNotice() ? '/signin' : '/', { replace: true });
  }), []);

  const { route, params } = resolve(path);
  const allowed = Boolean(user && route && route.roles.includes(user.role));
  const Public = PUBLIC[path.replace(/\/+$/, '') || '/'];

  useEffect(() => {
    if (!user && !Public) navigate(path === '/login' || hasNotice() ? '/signin' : '/', { replace: true });
    else if (user && !allowed) navigate(homeFor(user.role), { replace: true });
  }, [user, path, allowed, Public]);

  useEffect(() => {
    document.title = route && allowed ? `${route.title} – ElderCare` : 'ElderCare';
  }, [route, allowed]);

  if (!user) return Public ? <PrefsProvider><Public /></PrefsProvider> : null;
  if (!allowed) return null;

  const AppScreen = route.app;
  return <SessionLock user={user}><PrefsProvider key={user.id}><AppScreen user={user} path={path} /></PrefsProvider></SessionLock>;
}

createRoot(document.getElementById('root')).render(<><App /><ServerWake /></>);

// Installable app + offline shell + reminder taps (public/sw.js). Production builds only, so the dev server
// never serves stale cached code.
if (import.meta.env.PROD && 'serviceWorker' in navigator) {
  window.addEventListener('load', () => navigator.serviceWorker.register('/sw.js').catch(() => {}));
}

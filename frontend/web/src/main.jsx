import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { currentUser, logout, onSessionChange } from './api';
import { matchRoute, navigate, usePath } from './router';
import { ToastProvider } from './toast';
import Shell from './components/Shell';
import ClinicQueue from './pages/ClinicQueue';
import PatientProfile from './pages/PatientProfile';
import AddPatient from './pages/AddPatient';
import ClinicVisits from './pages/ClinicVisits';
import CaseHistory from './pages/CaseHistory';
import AlertRules from './pages/AlertRules';
import { PrefsProvider } from './mobile/kit';
import { Landing, RolePicker, SignIn, NoAccount } from './mobile/Onboarding';
import CaregiverApp from './mobile/caregiver';
import FamilyApp from './mobile/family';
import NurseApp from './mobile/nurse';
import AdminConsole from './admin/AdminConsole';
import './styles.css';

// Caregivers and families use only the phone app (on a computer it is shown in a phone-sized frame).
// Nurses get the phone app on small screens and the desktop clinic pages on a computer (each links to
// the other). Admins use the web console. Old desktop URLs (/caregiver, /family) redirect to the phone app.
const isPhone = () => window.matchMedia('(max-width: 820px)').matches;
export const HOME = {
  caregiver: '/m/caregiver',
  family_member: '/m/family',
  clinic_staff: '/clinic',
  system_admin: '/admin',
};
const homeFor = (role) => (role === 'clinic_staff' && isPhone() ? '/m/nurse' : HOME[role] || '/');

const PUBLIC = { '/': Landing, '/start': RolePicker, '/signin': SignIn, '/no-account': NoAccount };
const CLINIC = ['clinic_staff', 'system_admin'];
// Entries with `app` render full-screen and handle their own sub-paths (phone apps, admin console);
// entries with `page` render inside the desktop Shell.
const ROUTES = {
  '/m/caregiver': { roles: ['caregiver'], app: CaregiverApp, layout: 'mobile', title: 'Caregiver' },
  '/m/family': { roles: ['family_member'], app: FamilyApp, layout: 'mobile', title: 'Family' },
  '/m/nurse': { roles: ['clinic_staff'], app: NurseApp, layout: 'mobile', title: 'Nurse' },
  '/clinic/alert-rules': { roles: CLINIC, page: AlertRules, title: 'Alert rules' },
  '/clinic': { roles: CLINIC, page: ClinicQueue, title: 'Risk queue' },
  '/clinic/visits': { roles: CLINIC, page: ClinicVisits, title: 'Visits' },
  '/clinic/history': { roles: CLINIC, page: CaseHistory, title: 'Case history' },
  '/clinic/patients/new': { roles: CLINIC, page: AddPatient, title: 'Add patient' },
  '/clinic/patients/:id': { roles: CLINIC, page: PatientProfile, title: 'Patient profile' },
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
  useEffect(() => onSessionChange((next) => {
    setUser(next);
    navigate(next ? homeFor(next.role) : '/', { replace: true });
  }), []);

  const { route, params } = resolve(path);
  const allowed = Boolean(user && route && route.roles.includes(user.role));
  const Public = PUBLIC[path.replace(/\/+$/, '') || '/'];

  useEffect(() => {
    if (!user && !Public) navigate(path === '/login' ? '/signin' : '/', { replace: true });
    else if (user && !allowed) navigate(homeFor(user.role), { replace: true });
  }, [user, path, allowed, Public]);

  useEffect(() => {
    document.title = route && allowed ? `${route.title} – ElderCare` : 'ElderCare';
  }, [route, allowed]);

  if (!user) return Public ? <PrefsProvider><Public /></PrefsProvider> : null;
  if (!allowed) return null;

  if (route.app) {
    const AppScreen = route.app;
    return <PrefsProvider key={user.id}><AppScreen user={user} path={path} /></PrefsProvider>;
  }
  const Page = route.page;
  return (
    <ToastProvider key={user.id}>
      <Shell key={user.id} user={user} onSignOut={logout}>
        <Page key={path} user={user} params={params} />
      </Shell>
    </ToastProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);

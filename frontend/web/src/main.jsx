import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { currentUser, logout, onSessionChange } from './api';
import { matchRoute, navigate, usePath } from './router';
import { ToastProvider } from './toast';
import Shell from './components/Shell';
import Login from './pages/Login';
import CaregiverCheckIn from './pages/CaregiverCheckIn';
import FamilyDashboard from './pages/FamilyDashboard';
import ClinicQueue from './pages/ClinicQueue';
import PatientProfile from './pages/PatientProfile';
import AddPatient from './pages/AddPatient';
import ClinicVisits from './pages/ClinicVisits';
import CaseHistory from './pages/CaseHistory';
import AdminView from './pages/AdminView';
import CareDuties from './pages/CareDuties';
import AlertRules from './pages/AlertRules';
import './styles.css';

export const HOME = { caregiver: '/caregiver', family_member: '/family', clinic_staff: '/clinic', system_admin: '/admin' };
const CLINIC = ['clinic_staff', 'system_admin'];
const ROUTES = {
  '/caregiver': { roles: ['caregiver'], page: CaregiverCheckIn, title: 'Daily check-in' },
  '/caregiver/duties': { roles: ['caregiver'], page: CareDuties, title: 'Care duties' },
  '/clinic/alert-rules': { roles: CLINIC, page: AlertRules, title: 'Alert rules' },
  '/family': { roles: ['family_member'], page: FamilyDashboard, title: 'Family dashboard' },
  '/clinic': { roles: CLINIC, page: ClinicQueue, title: 'Risk queue' },
  '/clinic/visits': { roles: CLINIC, page: ClinicVisits, title: 'Visits' },
  '/clinic/history': { roles: CLINIC, page: CaseHistory, title: 'Case history' },
  '/clinic/patients/new': { roles: CLINIC, page: AddPatient, title: 'Add patient' },
  '/clinic/patients/:id': { roles: CLINIC, page: PatientProfile, title: 'Patient profile' },
  '/admin': { roles: ['system_admin'], page: AdminView, title: 'System status' },
};

function App() {
  const [user, setUser] = useState(currentUser());
  const path = usePath();

  // One place reacts to every identity change (sign-in, sign-out, account switch, expired session):
  // all page state is dropped because Shell and the page are keyed by the user ID below.
  useEffect(() => onSessionChange((next) => {
    setUser(next);
    navigate(next ? HOME[next.role] || '/login' : '/login', { replace: true });
  }), []);

  const match = matchRoute(Object.keys(ROUTES), path);
  const route = match && ROUTES[match.pattern];
  const allowed = Boolean(user && route && route.roles.includes(user.role));

  useEffect(() => {
    if (!user && path !== '/login') navigate('/login', { replace: true });
    else if (user && !allowed) navigate(HOME[user.role] || '/login', { replace: true });
  }, [user, path, allowed]);

  useEffect(() => {
    document.title = route && allowed ? `${route.title} – ElderCare Connect` : 'ElderCare Connect';
  }, [route, allowed]);

  if (!user) return <Login />;
  if (!allowed) return null;

  const Page = route.page;
  return (
    <ToastProvider key={user.id}>
      <Shell key={user.id} user={user} onSignOut={logout}>
        <Page key={path} user={user} params={match.params} />
      </Shell>
    </ToastProvider>
  );
}

createRoot(document.getElementById('root')).render(<App />);

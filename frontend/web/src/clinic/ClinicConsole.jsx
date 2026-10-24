// Nurse desktop console (/clinic), Figma page "All" (Nurse · frames): dark sidebar on a white page, the desktop
// risk queue, the patient case in three tabs, and the other nurse screens at desktop width. Visits, case history
// and alert rules keep their desktop pages, restyled with the phone tokens. Links stay inside /clinic.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { ToastProvider } from '../toast';
import { ScheduleVisit, AddPatient, Patients, Digest, Reviews } from '../mobile/nurse';
import { HandoverForm } from '../mobile/handover';
import { ClinicMessages } from '../mobile/contact';
import DesktopShell from '../components/DesktopShell';
import RiskQueue from './RiskQueue';
import PatientCase from './PatientCase';
import ClinicVisits from '../pages/ClinicVisits';
import CaseHistory from '../pages/CaseHistory';
import AlertRules from '../pages/AlertRules';
import '../mobile/mobile.css';

const sections = (unseen) => [
  { title: 'Main', items: [
    { to: '/clinic', label: 'Risk Queue', icon: 'clipboard' },
    { to: '/clinic/reviews', label: 'Check-in Reviews', icon: 'eye' },
    { to: '/clinic/messages', label: 'Family Messages', icon: 'message', badge: unseen },
    { to: '/clinic/patients', label: 'Patients', icon: 'users', exact: false },
    { to: '/clinic/visits', label: 'Visits', icon: 'calendar' },
    { to: '/clinic/history', label: 'Case History', icon: 'file' },
  ] },
  { title: 'Reports', items: [{ to: '/clinic/digest', label: 'Daily Digest', icon: 'zap' }] },
  { title: 'Settings', items: [{ to: '/clinic/alert-rules', label: 'Alert Rules', icon: 'sliders' }] },
];

/** Unseen family messages, for the sidebar badge. */
function useUnseen() {
  const [n, setN] = useState(0);
  useEffect(() => {
    const load = () => api('/api/clinic/contact-requests').then((d) => setN(d.unseen || 0)).catch(() => {});
    load();
    const t = setInterval(load, 30000);
    return () => clearInterval(t);
  }, []);
  return n;
}

export default function ClinicConsole({ user, path }) {
  const unseen = useUnseen();
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean).slice(1); // after "clinic"
  let page;
  let width = 'is-wide';
  if (!parts.length) page = <RiskQueue user={user} />;
  else if (parts[0] === 'patients' && parts[1] === 'new') { page = <AddPatient />; width = ''; }
  else if (parts[0] === 'patients' && parts[2] === 'schedule') { page = <ScheduleVisit patientId={parts[1]} />; width = ''; }
  else if (parts[0] === 'patients' && parts[2] === 'handover') { page = <HandoverForm user={user} patientId={parts[1]} />; width = ''; }
  else if (parts[0] === 'patients' && parts[1]) page = <PatientCase key={parts[1]} user={user} patientId={parts[1]} />;
  else if (parts[0] === 'patients') { page = <Patients />; width = ''; }
  else if (parts[0] === 'reviews') page = <Reviews desktop />;
  else if (parts[0] === 'messages') { page = <ClinicMessages user={user} />; width = ''; }
  else if (parts[0] === 'digest') { page = <Digest />; width = ''; }
  else if (parts[0] === 'visits') page = <ClinicVisits user={user} />;
  else if (parts[0] === 'history') page = <CaseHistory />;
  else if (parts[0] === 'alert-rules') page = <AlertRules user={user} />;
  else page = <RiskQueue user={user} />;

  return (
    <ToastProvider>
      <DesktopShell variant="nurse" label="Clinic" sections={sections(unseen)} user={user} userSub={user.username}>
        <div className={`ad-page ${width}`}>{page}</div>
      </DesktopShell>
    </ToastProvider>
  );
}

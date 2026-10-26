// Nurse desktop console (/clinic), Figma page "All" (Nurse · frames): dark sidebar on a white page, the desktop
// risk queue, the patient case in three tabs, and the other nurse screens at desktop width. Visits, case history
// and alert rules keep their desktop pages, restyled with the phone tokens. Links stay inside /clinic.
import React, { useEffect, useState } from 'react';
import { api } from '../api';
import { ToastProvider } from '../toast';
import { ScheduleVisit, Patients, Digest, Reviews } from '../mobile/nurse';
import { HandoverForm } from '../mobile/handover';
import { ClinicMessages } from '../mobile/contact';
import DesktopShell from '../components/DesktopShell';
import RiskQueue from './RiskQueue';
import PatientCase from './PatientCase';
import ClinicVisits from '../pages/ClinicVisits';
import CaseHistory from '../pages/CaseHistory';
import AlertRules from '../pages/AlertRules';
import { Accounts, AuditLog } from '../admin/Accounts';
import { CareTeams } from '../admin/CareTeams';
import { Head, useLive, Monitor, Health, Dlq } from '../admin/AdminConsole';
import '../mobile/mobile.css';

// Team-lead nurses (lead of a care team) also run their teams: caregiver and family accounts, registering and
// linking elders, the audit log, and the operations pages (read-only).
const TEAM_LEAD = [
  { title: 'Team lead', items: [
    { to: '/clinic/accounts', label: 'Accounts', icon: 'user' },
    { to: '/clinic/elders', label: 'Elders & linking', icon: 'users' },
    { to: '/clinic/audit', label: 'Audit log', icon: 'shield' },
  ] },
  { title: 'Operations', items: [
    { to: '/clinic/operations', label: 'Integration monitor', icon: 'pulse' },
    { to: '/clinic/operations/health', label: 'Service health', icon: 'server' },
    { to: '/clinic/operations/dlq', label: 'Dead-letter queue', icon: 'inbox' },
  ] },
];

const sections = (unseen, lead) => [
  { title: 'Main', items: [
    { to: '/clinic', label: 'Risk Queue', icon: 'clipboard' },
    { to: '/clinic/reviews', label: 'Check-in Reviews', icon: 'eye' },
    { to: '/clinic/messages', label: 'Family Messages', icon: 'message', badge: unseen },
    { to: '/clinic/patients', label: 'Patients', icon: 'users', exact: false },
    { to: '/clinic/visits', label: 'Visits', icon: 'calendar' },
    { to: '/clinic/history', label: 'Case History', icon: 'file' },
  ] },
  { title: 'Reports', items: [{ to: '/clinic/digest', label: 'Daily Digest', icon: 'zap' }] },
  ...(lead ? TEAM_LEAD : []),
  { title: 'Settings', items: [
    { to: '/clinic/alert-rules', label: 'Alert Rules', icon: 'sliders' },
    // The nurse's phone app on this computer (the same screens a nurse sees on a phone).
    { to: '/m/nurse', label: 'Phone view', icon: 'smartphone' },
  ] },
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

/** { teamLead, leadTeams } for the signed-in nurse (GET /api/me). */
function useMe() {
  const [me, setMe] = useState(null);
  useEffect(() => { api('/api/me').then(setMe).catch(() => setMe({ teamLead: false, leadTeams: [] })); }, []);
  return me;
}

/** Operations pages for a team lead: live service health and queues, refreshed while on screen. */
function Operations({ view }) {
  const [live, reload] = useLive();
  if (view === 'health') return <Health live={live} />;
  if (view === 'dlq') return <Dlq live={live} reload={reload} readOnly />;
  return <Monitor live={live} />;
}

export default function ClinicConsole({ user, path }) {
  const unseen = useUnseen();
  const me = useMe();
  const lead = Boolean(me && me.teamLead);
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean).slice(1); // after "clinic"
  let page;
  let width = 'is-wide';
  // Every page uses the full width beside the sidebar; forms lay their fields out in two columns.
  if (!parts.length) page = <RiskQueue user={user} />;
  else if (parts[0] === 'patients' && parts[2] === 'schedule') { page = <ScheduleVisit patientId={parts[1]} />; width = 'is-wide is-form'; }
  else if (parts[0] === 'patients' && parts[2] === 'handover') { page = <HandoverForm user={user} patientId={parts[1]} />; width = 'is-wide is-form'; }
  else if (parts[0] === 'patients' && parts[1]) page = <PatientCase key={parts[1]} user={user} patientId={parts[1]} />;
  else if (parts[0] === 'patients') page = <Patients />;
  else if (parts[0] === 'reviews') page = <Reviews desktop />;
  else if (parts[0] === 'messages') page = <ClinicMessages user={user} />;
  else if (parts[0] === 'digest') page = <Digest />;
  else if (parts[0] === 'visits') page = <ClinicVisits user={user} />;
  else if (parts[0] === 'history') page = <CaseHistory />;
  else if (parts[0] === 'alert-rules') page = <AlertRules user={user} />;
  else if (lead && parts[0] === 'accounts') page = <Accounts Head={Head} lead />;
  else if (lead && parts[0] === 'elders') page = <CareTeams Head={Head} leadTeams={me.leadTeams} accountsPath="/clinic/accounts" />;
  else if (lead && parts[0] === 'audit') page = <AuditLog Head={Head} />;
  else if (lead && parts[0] === 'operations') page = <Operations view={parts[1]} />;
  else if (!me && ['accounts', 'elders', 'audit', 'operations'].includes(parts[0])) page = <p className="m-caption">Loading…</p>;
  else page = <RiskQueue user={user} />;

  return (
    <ToastProvider>
      <DesktopShell variant="nurse" label="Clinic" sections={sections(unseen, lead)} user={user} userSub={user.username}>
        <div className={`ad-page ${width}`}>{page}</div>
      </DesktopShell>
    </ToastProvider>
  );
}

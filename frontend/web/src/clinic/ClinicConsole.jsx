// Nurse desktop console (/clinic): the phone nurse app's screens and design in a web layout - the admin
// console's sidebar, wider content, and the patient page in two columns (the phone patient screen beside the
// clinic records only the desktop has: trends, medicines, visits, SMS contacts, care plan, health-center record).
// Visits management, case history and alert rules keep their desktop pages, restyled with the phone tokens.
import React, { useEffect, useState } from 'react';
import { api, requestSignOut } from '../api';
import { Link } from '../router';
import { ToastProvider } from '../toast';
import { dateTime, initials } from '../format';
import Icon from '../mobile/icons';
import { Queue, PatientDetail, ScheduleVisit, AddPatient, Patients, Digest, Reviews } from '../mobile/nurse';
import { HandoverForm } from '../mobile/handover';
import { ClinicMessages } from '../mobile/contact';
import PatientRecords from '../pages/PatientProfile';
import ClinicVisits from '../pages/ClinicVisits';
import CaseHistory from '../pages/CaseHistory';
import AlertRules from '../pages/AlertRules';
import { weatherSentence } from '../pages/ClinicQueue';
import '../mobile/mobile.css';

const NAV = [
  { to: '/clinic', label: 'Risk queue', icon: 'clipboard', exact: true },
  { to: '/clinic/reviews', label: 'Check-in reviews', icon: 'eye' },
  { to: '/clinic/messages', label: 'Family messages', icon: 'message', badge: 'messages' },
  { to: '/clinic/patients', label: 'Patients', icon: 'users' },
  { to: '/clinic/visits', label: 'Visits', icon: 'calendar' },
  { to: '/clinic/history', label: 'Case history', icon: 'file' },
  { to: '/clinic/digest', label: 'Daily digest', icon: 'zap' },
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

function WeatherCheck() {
  const [checking, setChecking] = useState(false);
  const [weather, setWeather] = useState(null);
  async function run() {
    setChecking(true);
    try {
      setWeather({ ok: true, ...(await api('/api/alerts/weather-check', { method: 'POST', body: {} })) });
    } catch (e) {
      setWeather({ ok: false, message: e.status === 503 ? 'Weather checks are not set up yet. Add an OpenWeatherMap API key to the alert service.' : e.message });
    } finally { setChecking(false); }
  }
  const s = weather && weather.ok && weather.summary;
  const tone = !weather ? '' : !weather.ok || s.areasFailed === s.areasChecked ? 'critical' : s.heatAreas.length || s.stormAreas.length ? 'moderate' : 'info';
  return (
    <>
      <button type="button" className="m-btn" onClick={run} disabled={checking}><Icon name="thermometer" size={18} />{checking ? 'Checking weather…' : 'Check weather risk now'}</button>
      {weather && (
        <p className={`m-banner tone-${tone} ad-weather`} role="status">
          <strong>Weather check{weather.ok ? ` at ${dateTime(weather.ranAt)}` : ' failed'}.</strong>{' '}
          {weather.ok ? weatherSentence(s) : weather.message}
          <button type="button" className="m-link" onClick={() => setWeather(null)}>Dismiss</button>
        </p>
      )}
    </>
  );
}

export default function ClinicConsole({ user, path }) {
  const unseen = useUnseen();
  const parts = path.replace(/\/+$/, '').split('/').filter(Boolean).slice(1); // after "clinic"
  let page;
  let wide = false;
  if (!parts.length) page = <><div className="ad-toolbar"><WeatherCheck /></div><Queue user={user} /></>;
  else if (parts[0] === 'patients' && parts[1] === 'new') page = <AddPatient />;
  else if (parts[0] === 'patients' && parts[2] === 'schedule') page = <ScheduleVisit patientId={parts[1]} />;
  else if (parts[0] === 'patients' && parts[2] === 'handover') page = <HandoverForm user={user} patientId={parts[1]} />;
  else if (parts[0] === 'patients' && parts[1]) {
    wide = true;
    page = (
      <div className="ad-patient">
        <div className="ad-patient-main"><PatientDetail user={user} patientId={parts[1]} /></div>
        <div className="ad-patient-records"><h2 className="m-section-title" style={{ marginTop: 0 }}>Clinic records</h2><PatientRecords user={user} patientId={parts[1]} /></div>
      </div>
    );
  } else if (parts[0] === 'patients') page = <Patients />;
  else if (parts[0] === 'reviews') page = <Reviews />;
  else if (parts[0] === 'messages') page = <ClinicMessages user={user} />;
  else if (parts[0] === 'digest') page = <Digest />;
  else if (parts[0] === 'visits') { wide = true; page = <ClinicVisits user={user} />; }
  else if (parts[0] === 'history') { wide = true; page = <CaseHistory />; }
  else if (parts[0] === 'alert-rules') { wide = true; page = <AlertRules user={user} />; }
  else page = <Queue user={user} />;

  return (
    <ToastProvider>
      <div className="ad-app ad-clinic">
        <aside className="ad-side">
          <div className="ad-brand">
            <span className="m-brand-mark"><Icon name="heart" /></span>
            <div><strong>ElderCare</strong><small>{user.name} · nurse</small></div>
          </div>
          <nav aria-label="Clinic" style={{ display: 'contents' }}>
            {NAV.map((n) => (
              <Link key={n.to} to={n.to} exact={n.exact} activeClassName="is-active">
                <Icon name={n.icon} />{n.label}{n.badge === 'messages' && unseen > 0 && <span className="ad-badge" aria-label={`${unseen} new`}>{unseen}</span>}
              </Link>
            ))}
            <Link to="/clinic/patients/new" activeClassName="is-active"><Icon name="plus" />Add patient</Link>
            <span className="ad-sep">Settings</span>
            <Link to="/clinic/alert-rules" activeClassName="is-active"><Icon name="sliders" />Alert rules</Link>
            <Link to="/m/nurse"><Icon name="phone" />Phone view</Link>
          </nav>
          <div className="ad-bottom-group">
            <div className="ad-user"><span className="m-avatar" aria-hidden="true">{initials(user.name)}</span><div><strong>{user.name}</strong><span className="m-sub">Clinic nurse</span></div></div>
            <button type="button" className="ad-bottom" onClick={requestSignOut}><Icon name="logout" />Log out</button>
          </div>
        </aside>
        <main className="ad-main" id="main">
          <div className={`ad-page ${wide ? 'is-wide' : ''}`}>{page}</div>
        </main>
      </div>
    </ToastProvider>
  );
}

// Onboarding (Figma "Start: landing, sign in, sign up" + "01 Welcome" / "02 Log in"):
//   /        landing: logo, "Care from Anywhere", Get started / I already have an account
//   /start   pick your role: one tap signs in with that role's demo account (demo mode only)
//   /signin  username + password, Big text and Filipino toggles
import React, { useState } from 'react';
import { login } from '../api';
import { navigate } from '../router';
import { DEMO, DEMO_PASSWORD } from '../demoAccounts';
import Icon from './icons';
import { MobileFrame, Cta, LangSwitch, CaregiverWalk, BrandMark, usePrefs, useT } from './kit';

// Demo mode: role buttons sign straight in. On in development; set VITE_DEMO_LOGIN=true for a demo deployment.
export const DEMO_MODE = import.meta.env.DEV || import.meta.env.VITE_DEMO_LOGIN === 'true';

const ROLES = [
  { username: 'caregiver.maria', icon: 'clipboard', en: ['Caregiver', 'Log daily check-ins and medicines'], fil: ['Tagapag-alaga', 'Mag-check-in araw-araw at itala ang gamot'] },
  { username: 'family.jose', icon: 'heart', en: ['Family', 'See how your loved one is doing'], fil: ['Pamilya', 'Tingnan ang kalagayan ng mahal mo sa buhay'] },
  { username: 'nurse.ana', icon: 'users', en: ['Nurse', 'Risk queue, visits and patients'], fil: ['Nars', 'Risk queue, pagbisita at pasyente'], tag: ['Phone or computer', 'Phone o computer'] },
  { username: 'admin.harold', icon: 'monitor', en: ['Admin', 'Service health and accounts'], fil: ['Admin', 'Kalagayan ng serbisyo at mga account'], tag: ['Computer', 'Computer'] },
];

export function Landing() {
  const tr = useT();
  return (
    <MobileFrame plain>
      <div className="m-landing">
        <img className="m-logo-img" src="/brand/logo.png" alt="ElderCare" width="324" height="205" />
        <h1>{tr('Care from Anywhere', 'Alaga Saan Man')}</h1>
        <p>{tr('Daily check-ins, health alerts and clinic follow-up, all in one', 'Araw-araw na check-in, alerto sa kalusugan at follow-up ng klinika, sa iisang app')}</p>
        <div style={{ marginTop: 'auto', paddingTop: '2.5rem', display: 'grid', gap: '.75rem' }}>
          <button type="button" className="m-cta is-green" onClick={() => navigate(DEMO_MODE ? '/start' : '/signin')}>{tr('Get started', 'Magsimula')}</button>
          <button type="button" className="m-btn is-soft" onClick={() => navigate('/signin')}>{tr('I already have an account', 'May account na ako')}</button>
          <div style={{ display: 'flex', justifyContent: 'center', marginTop: '.5rem' }}><LangSwitch /></div>
        </div>
      </div>
    </MobileFrame>
  );
}

export function RolePicker() {
  const tr = useT();
  const { lang } = usePrefs();
  const [busy, setBusy] = useState(null);
  const [error, setError] = useState('');

  async function signInAs(username) {
    setBusy(username);
    setError('');
    try {
      await login(username, DEMO_PASSWORD); // App opens the right home screen for the role
    } catch (e) {
      setError(e.message);
      setBusy(null);
    }
  }

  return (
    <MobileFrame plain>
      <div className="m-brandbar">
        <button type="button" className="m-icon-btn" onClick={() => navigate('/')} aria-label={tr('Back', 'Bumalik')}><Icon name="back" /></button>
        <LangSwitch />
      </div>
      <CaregiverWalk small />
      <h1 style={{ fontSize: '1.75rem', margin: '1.25rem 0 .35rem' }}>{tr('Who are you?', 'Sino ka?')}</h1>
      <p className="m-muted" style={{ marginBottom: '1rem' }}>{tr('Tap your role to open the app. You will only see the screens for your role.', 'Pindutin ang iyong papel para buksan ang app. Makikita mo lang ang mga screen para sa iyo.')}</p>
      {error && <p className="m-error" role="alert" style={{ marginBottom: '.75rem' }}>{error}</p>}
      <div className="m-roles">
        {ROLES.map((r) => {
          const [title, sub] = r[lang] || r.en;
          const demo = DEMO.find((d) => d.username === r.username);
          return (
            <button key={r.username} type="button" className="m-role" disabled={!!busy} onClick={() => signInAs(r.username)}>
              <span className="m-thumb" aria-hidden="true"><Icon name={r.icon} /></span>
              <span className="m-grow">
                <strong>{title}{r.tag && <span className="m-tag">{lang === 'fil' ? r.tag[1] : r.tag[0]}</span>}</strong>
                <span className="m-sub">{busy === r.username ? tr('Signing in…', 'Nagsa-sign in…') : `${sub} · ${demo ? demo.name : ''}`}</span>
              </span>
              <Icon name="chevron" />
            </button>
          );
        })}
      </div>
      <p className="m-caption" style={{ marginTop: '1rem' }}>
        {tr('Demo mode: each role signs in with a sample account.', 'Demo mode: bawat papel ay may sample na account.')}{' '}
        <button type="button" className="m-link" onClick={() => navigate('/signin')}>{tr('Use a username instead', 'Gumamit ng username')}</button>
      </p>
    </MobileFrame>
  );
}

export function SignIn() {
  const tr = useT();
  const { big, lang, setPrefs } = usePrefs();
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    setBusy(true);
    setError('');
    try {
      await login(username.trim(), password);
    } catch (err) {
      setError(err.message);
      setBusy(false);
    }
  }

  return (
    <MobileFrame plain>
      <div className="m-brandbar">
        <BrandMark />
        <strong>ElderCare</strong>
        <LangSwitch />
      </div>
      <CaregiverWalk small />
      <form onSubmit={submit} className="m-stack" style={{ marginTop: '1.25rem' }}>
        <div>
          <h1 style={{ fontSize: '1.75rem' }}>{tr('Welcome back', 'Maligayang pagbabalik')}</h1>
          <p className="m-muted" style={{ marginTop: '.35rem' }}>{tr('Log in with the account your barangay health center gave you.', 'Mag-log in gamit ang account na ibinigay ng barangay health center.')}</p>
        </div>
        <label className="m-field"><span>{tr('Username', 'Username')}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required />
        </label>
        <label className="m-field"><span>{tr('Password', 'Password')}</span>
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <div className="m-pills">
          <button type="button" className="m-pill" aria-pressed={big} onClick={() => setPrefs({ big: !big })}><Icon name="textSize" size={18} />{tr('Big text', 'Malaking letra')}</button>
          <button type="button" className="m-pill" aria-pressed={lang === 'fil'} onClick={() => setPrefs({ lang: lang === 'fil' ? 'en' : 'fil' })}><Icon name="globe" size={18} />Filipino</button>
        </div>
        {error && <p className="m-error" role="alert">{error}</p>}
        <div style={{ marginTop: '.75rem' }}><Cta type="submit" disabled={busy}>{busy ? tr('Logging in…', 'Nagla-log in…') : tr('Log in', 'Mag-log in')}</Cta></div>
        <p className="m-caption">{tr('Caregivers, family and clinic staff use the same app. You will only see the screens for your role.', 'Iisang app para sa tagapag-alaga, pamilya at klinika. Makikita mo lang ang mga screen para sa iyo.')}</p>
        {DEMO_MODE && <button type="button" className="m-link" onClick={() => navigate('/start')}>{tr('Demo: pick a role instead', 'Demo: pumili ng papel')}</button>}
      </form>
    </MobileFrame>
  );
}

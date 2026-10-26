// Onboarding (Figma "Start: landing, sign in, sign up" + "01 Welcome" / "02 Log in"):
//   /        landing: logo, "Care from Anywhere", Get started / I already have an account
//   /start   pick your role: one tap signs in with that role's demo account (demo mode only)
//   /signin  username + password, Big text and Filipino toggles
//   /no-account  how to get an account (there is no open sign-up: the health center creates accounts and
//                links each one to a patient before anyone can see health data)
import React, { useState } from 'react';
import { login, takeNotice } from '../api';
import { navigate } from '../router';
import { DEMO, DEMO_PASSWORD } from '../demoAccounts';
import Icon from './icons';
import { MobileFrame, Cta, Banner, LangSwitch, CaregiverWalk, BrandMark, usePrefs, useT } from './kit';

// Demo mode: role buttons sign straight in. On in development; set VITE_DEMO_LOGIN=true for a demo deployment.
export const DEMO_MODE = import.meta.env.DEV || import.meta.env.VITE_DEMO_LOGIN === 'true';

const ROLES = [
  { username: 'caregiver.maria', icon: 'clipboard', en: ['Caregiver', 'Log daily check-ins and medicines'], fil: ['Tagapag-alaga', 'Mag-check-in araw-araw at itala ang gamot'] },
  { username: 'family.jose', icon: 'heart', en: ['Family', 'See how your loved one is doing'], fil: ['Pamilya', 'Tingnan ang kalagayan ng mahal mo sa buhay'] },
  { username: 'nurse.ana', icon: 'users', en: ['Nurse', 'Risk queue, visits and patients'], fil: ['Nars', 'Risk queue, pagbisita at pasyente'], tag: ['Phone or computer', 'Phone o computer'] },
  { username: 'admin.harold', icon: 'monitor', en: ['Health Center Admin', 'Service health, staff accounts and care teams'], fil: ['Admin ng health center', 'Kalagayan ng serbisyo, account ng kawani at care team'], tag: ['Computer', 'Computer'] },
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
  const [notice] = useState(takeNotice);
  const [forgot, setForgot] = useState(false);

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
        {notice && <Banner tone="moderate" icon="shield" role="status">{notice}</Banner>}
        {error && <p className="m-error" role="alert">{error}</p>}
        <div style={{ marginTop: '.75rem' }}><Cta type="submit" disabled={busy}>{busy ? tr('Logging in…', 'Nagla-log in…') : tr('Log in', 'Mag-log in')}</Cta></div>
        <div className="m-between">
          <button type="button" className="m-link" onClick={() => navigate('/activate')}>{tr('Activate my account', 'I-activate ang account')}</button>
          <button type="button" className="m-link" onClick={() => setForgot(!forgot)} aria-expanded={forgot}>{tr('Forgot password?', 'Nakalimutan ang password?')}</button>
        </div>
        {forgot && (
          <Banner tone="info" icon="message">
            {tr('Ask your health center to send a reset code. It comes by SMS to the number on your account. They never see or ask for your password.', 'Humingi ng reset code sa health center. Darating ito sa SMS. Hindi nila makikita o hihingin ang iyong password.')}{' '}
            <button type="button" className="m-link" style={{ padding: 0, minHeight: 0 }} onClick={() => navigate('/reset-password')}>{tr('I have a reset code', 'May reset code ako')}</button>
          </Banner>
        )}
        <p className="m-caption">{tr('Caregivers, family and clinic staff use the same app. You will only see the screens for your role.', 'Iisang app para sa tagapag-alaga, pamilya at klinika. Makikita mo lang ang mga screen para sa iyo.')}</p>
        <p className="m-muted" style={{ textAlign: 'center' }}>{tr('New here?', 'Bago ka rito?')} <button type="button" className="m-link" onClick={() => navigate('/no-account')}>{tr('How to get an account', 'Paano magkaroon ng account')}</button></p>
        {DEMO_MODE && <button type="button" className="m-link" onClick={() => navigate('/start')}>{tr('Demo: pick a role instead', 'Demo: pumili ng papel')}</button>}
      </form>
    </MobileFrame>
  );
}

const STEPS = [
  ['Visit or call your barangay health center.', 'Pumunta o tumawag sa inyong barangay health center.'],
  ['Tell the nurse who you care for and how you are related (caregiver or family).', 'Sabihin sa nars kung sino ang inaalagaan mo at ano ang kaugnayan mo (tagapag-alaga o pamilya).'],
  ['The health center creates your account and links it to them (family members are verified first).', 'Gagawa ang health center ng account at ili-link ito (bini-verify muna ang pamilya).'],
  ['You get an SMS with your username and an activation code. Tap "Activate my account" and choose your own password.', 'Makakatanggap ka ng SMS na may username at activation code. I-tap ang "I-activate ang account" at pumili ng sariling password.'],
];

/** Replaces open sign-up: accounts are created by the health center so no one sees a patient they are not linked to. */
export function NoAccount() {
  const tr = useT();
  return (
    <MobileFrame plain>
      <div className="m-brandbar">
        <button type="button" className="m-icon-btn" onClick={() => navigate('/signin')} aria-label={tr('Back', 'Bumalik')}><Icon name="back" /></button>
        <LangSwitch />
      </div>
      <h1 style={{ fontSize: '1.75rem', margin: '.5rem 0 .35rem' }}>{tr('Getting an account', 'Paano magkaroon ng account')}</h1>
      <p className="m-muted" style={{ marginBottom: '1rem' }}>{tr("Accounts come from your barangay health center, so only the people your loved one's nurse approves can see their health information.", 'Ang account ay galing sa barangay health center para ang mga inaprubahan lang ng nars ang makakita ng impormasyon.')}</p>
      <ol className="m-stack" style={{ listStyle: 'none', padding: 0, margin: 0 }}>
        {STEPS.map(([en, fil], i) => (
          <li key={en} className="m-card m-row" style={{ marginTop: 0, alignItems: 'flex-start' }}>
            <span className="m-brand-mark" style={{ width: '2.25rem', height: '2.25rem', fontWeight: 800 }} aria-hidden="true">{i + 1}</span>
            <span style={{ paddingTop: '.35rem' }}>{tr(en, fil)}</span>
          </li>
        ))}
      </ol>
      <div className="m-note" style={{ marginTop: '1rem' }}>
        <strong>{tr('Clinic staff', 'Kawani ng klinika')}</strong>
        {tr('Nurse and admin accounts are set up by the health center administrator.', 'Ang account ng nars at admin ay ginagawa ng administrator ng health center.')}
      </div>
      <div style={{ marginTop: '1.5rem' }}><Cta onClick={() => navigate('/signin')}>{tr('I have my username', 'May username na ako')}</Cta></div>
    </MobileFrame>
  );
}

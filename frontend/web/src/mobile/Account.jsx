// Account activation (code from SMS) and password reset (link from SMS), Batch 3a. Public pages: the user is
// not signed in yet. Codes and links come only by SMS to the phone number the clinic registered; the admin
// who created the account never sees them.
import React, { useEffect, useState } from 'react';
import { accountRequest } from '../api';
import { navigate } from '../router';
import Icon from './icons';
import { MobileFrame, BrandMark, LangSwitch, Cta, Banner, useT } from './kit';

function PasswordFields({ password, setPassword, confirm, setConfirm }) {
  const tr = useT();
  const mismatch = confirm && confirm !== password;
  return (
    <>
      <label className="m-field"><span>{tr('New password', 'Bagong password')}</span>
        <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="new-password" minLength={10} required />
        <span className="m-hint">{tr('At least 10 characters with letters and numbers. Not your name.', 'Hindi bababa sa 10 titik at numero. Hindi ang iyong pangalan.')}</span>
      </label>
      <label className={`m-field ${mismatch ? 'is-invalid' : ''}`}><span>{tr('Type it again', 'Ulitin')}</span>
        <input type="password" value={confirm} onChange={(e) => setConfirm(e.target.value)} autoComplete="new-password" required aria-invalid={mismatch || undefined} />
        {mismatch && <span className="m-field-error" role="alert">{tr('The two passwords are different.', 'Magkaiba ang dalawang password.')}</span>}
      </label>
    </>
  );
}

function Header({ title, sub }) {
  return (
    <>
      <div className="m-brandbar">
        <button type="button" className="m-icon-btn" onClick={() => navigate('/signin')} aria-label="Back"><Icon name="back" /></button>
        <span className="m-row" style={{ gap: '.5rem' }}><BrandMark /><strong>ElderCare</strong></span>
        <LangSwitch />
      </div>
      <h1 style={{ fontSize: '1.75rem', margin: '1rem 0 .35rem' }}>{title}</h1>
      <p className="m-muted" style={{ marginBottom: '1rem' }}>{sub}</p>
    </>
  );
}

export function Activate() {
  const tr = useT();
  const [username, setUsername] = useState('');
  const [code, setCode] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(null);
  const [busy, setBusy] = useState(false);

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError('');
    try {
      setDone(await accountRequest('activate', { username: username.trim(), code, password }));
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <MobileFrame plain>
        <Header title={tr('Account ready', 'Handa na ang account')} sub={tr(`You can now sign in as ${done.username} with your new password.`, `Maaari ka nang mag-log in bilang ${done.username}.`)} />
        <Cta onClick={() => navigate('/signin')}>{tr('Go to sign in', 'Mag-log in')}</Cta>
      </MobileFrame>
    );
  }
  return (
    <MobileFrame plain>
      <Header title={tr('Activate your account', 'I-activate ang account')} sub={tr('The health center sent an SMS with your username and an activation code. The code works for 24 hours.', 'Nagpadala ang health center ng SMS na may username at activation code. Gumagana ito sa loob ng 24 oras.')} />
      <form className="m-stack" onSubmit={submit}>
        <label className="m-field"><span>{tr('Username', 'Username')}</span>
          <input value={username} onChange={(e) => setUsername(e.target.value)} autoComplete="username" autoCapitalize="none" required /></label>
        <label className="m-field"><span>{tr('Activation code', 'Activation code')}</span>
          <input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} placeholder="ABCD-EFGH" autoComplete="one-time-code" autoCapitalize="characters" inputMode="text" maxLength={12} required
            style={{ letterSpacing: '.15em', fontWeight: 700 }} /></label>
        <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
        {error && <p className="m-error" role="alert">{error}</p>}
        <Cta type="submit" disabled={busy || !password || password !== confirm}>{busy ? tr('Activating…', 'Ina-activate…') : tr('Activate', 'I-activate')}</Cta>
        <Banner tone="info" icon="message">{tr('No SMS, or the code expired? Ask the health center to send a new code. Nobody from the clinic will ask you for it.', 'Walang SMS o expired na? Humingi ng bagong code sa health center. Walang taga-klinika na hihingi nito sa iyo.')}</Banner>
      </form>
    </MobileFrame>
  );
}

export function ResetPassword() {
  const tr = useT();
  const [token] = useState(() => window.location.hash.slice(1));
  const [check, setCheck] = useState(null);
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [error, setError] = useState('');
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    // The secret is in the #fragment, so it never reaches server logs; drop it from the address bar too.
    window.history.replaceState(null, '', '/reset-password');
    if (!token) { setCheck({ error: tr('This link is incomplete. Open the link from the SMS again.', 'Kulang ang link.') }); return; }
    accountRequest('password-reset/check', { token }).then(setCheck).catch((e) => setCheck({ error: e.message }));
  }, [token]); // eslint-disable-line react-hooks/exhaustive-deps

  async function submit(e) {
    e.preventDefault();
    if (password !== confirm) return;
    setBusy(true);
    setError('');
    try {
      await accountRequest('password-reset', { token, password });
      setDone(true);
    } catch (err) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  }

  if (done) {
    return (
      <MobileFrame plain>
        <Header title={tr('Password changed', 'Napalitan ang password')} sub={tr('You were signed out on every device. Sign in with the new password.', 'Na-sign out ka sa lahat ng device. Mag-log in gamit ang bagong password.')} />
        <Cta onClick={() => navigate('/signin')}>{tr('Go to sign in', 'Mag-log in')}</Cta>
      </MobileFrame>
    );
  }
  return (
    <MobileFrame plain>
      <Header title={tr('Set a new password', 'Bagong password')} sub={check && check.username ? tr(`For ${check.username}. The link works once, for 1 hour.`, `Para kay ${check.username}. Isang beses lang, sa loob ng 1 oras.`) : ''} />
      {!check && <p className="m-muted">{tr('Checking the link…', 'Sinusuri ang link…')}</p>}
      {check && check.error && <Banner tone="critical">{check.error}</Banner>}
      {check && check.valid && (
        <form className="m-stack" onSubmit={submit}>
          <PasswordFields password={password} setPassword={setPassword} confirm={confirm} setConfirm={setConfirm} />
          {error && <p className="m-error" role="alert">{error}</p>}
          <Cta type="submit" disabled={busy || !password || password !== confirm}>{busy ? tr('Saving…', 'Sine-save…') : tr('Save new password', 'I-save')}</Cta>
        </form>
      )}
    </MobileFrame>
  );
}

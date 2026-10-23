// API client for the ElderCare Connect API Gateway.
// Tokens live in memory + sessionStorage (cleared when the tab closes). On a 401 the access
// token is refreshed once with the refresh token; if that fails the session ends.
// The gateway rotates refresh tokens and treats a reused one as theft, so concurrent 401s share ONE
// refresh request, and signing out revokes the session on the server (POST /oauth/revoke).
// Sessions (Batch 3a): one per user (nurses: one phone + one desktop), locked after inactivity until the
// password is entered again. A 401 says why: session_locked -> lock screen (the session is kept),
// session_replaced / session_ended -> signed out with a message on the sign-in page.
// Drafts: unsent entries (check-in, review note, handover) are kept per user in this tab's sessionStorage, so a
// lock, a time-out or a session ended elsewhere does not lose them. They come back only for the same user, are
// dropped when another user signs in here or after 12 hours, and signing out on purpose discards them (after a
// warning). A save refused because the session just locked is sent again once the user unlocks.

export const BASE = import.meta.env.VITE_API_BASE_URL || ''; // '' => same origin (Vite proxy in dev)
const KEY = 'eldercare.session';
const NOTICE_KEY = 'eldercare.notice';
const DRAFTS_KEY = 'eldercare.drafts';
const DRAFT_TTL_MS = 12 * 3600000;
const listeners = new Set();
const lockListeners = new Set();

let session = (() => {
  try { return JSON.parse(sessionStorage.getItem(KEY)) || null; } catch { return null; }
})();

function save(next) {
  const before = currentUser();
  session = next;
  try {
    if (next) sessionStorage.setItem(KEY, JSON.stringify(next));
    else sessionStorage.removeItem(KEY);
  } catch { /* storage unavailable: keep the session in memory only */ }
  const after = currentUser();
  // Notify only when the signed-in identity changes (sign-in, sign-out, account switch) -
  // a silent token refresh for the same user must not reset the app.
  if ((before && before.id) !== (after && after.id)) listeners.forEach((fn) => fn(after));
}

function decode(token) {
  try {
    return JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
  } catch {
    return {};
  }
}

export function currentUser() {
  if (!session) return null;
  const c = decode(session.accessToken);
  if (!c.sub) return null;
  return { id: c.sub, name: c.name || c.sub, role: c.role, patients: c.patients || [] };
}

/** Called whenever the signed-in user changes: sign-in, sign-out, account switch, or expired session. */
export function onSessionChange(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

/** Messages for the sign-in page after a session ends for a reason the user should know. */
const NOTICES = {
  session_replaced: 'You signed in on another device, so you were signed out here.',
  session_ended: 'Your session has ended. Please sign in again.',
};
export function hasNotice() {
  try { return Boolean(sessionStorage.getItem(NOTICE_KEY)); } catch { return false; }
}
export function takeNotice() {
  try { const n = sessionStorage.getItem(NOTICE_KEY); sessionStorage.removeItem(NOTICE_KEY); return n; } catch { return null; }
}
function endSession(reason) {
  const kept = draftCount();
  const notice = NOTICES[reason] && `${NOTICES[reason]}${kept ? ' Your unsent entries are kept on this device: sign in again to finish them.' : ''}`;
  try { if (notice) sessionStorage.setItem(NOTICE_KEY, notice); } catch { /* ignore */ }
  save(null);
}

/* ------------------------------ drafts ------------------------------ */
function readDrafts() {
  try {
    const all = JSON.parse(sessionStorage.getItem(DRAFTS_KEY)) || { owner: null, items: {} };
    const now = Date.now();
    all.items = Object.fromEntries(Object.entries(all.items || {}).filter(([, d]) => now - d.savedAt < DRAFT_TTL_MS));
    return all;
  } catch { return { owner: null, items: {} }; }
}
function writeDrafts(all) {
  try {
    if (Object.keys(all.items).length) sessionStorage.setItem(DRAFTS_KEY, JSON.stringify(all));
    else sessionStorage.removeItem(DRAFTS_KEY);
  } catch { /* storage unavailable: the draft lives only in the open form */ }
}
const draftOwner = () => { const u = currentUser(); return u && u.id; };
/** @returns {{data:any, savedAt:number} | null} the signed-in user's draft for this form */
export function loadDraft(key) {
  const all = readDrafts();
  return all.owner && all.owner === draftOwner() ? all.items[key] || null : null;
}
export function saveDraft(key, data) {
  const owner = draftOwner();
  if (!owner) return;
  const all = readDrafts();
  writeDrafts({ owner, items: { ...(all.owner === owner ? all.items : {}), [key]: { data, savedAt: Date.now() } } });
}
export function clearDraft(key) {
  const all = readDrafts();
  if (all.owner !== draftOwner() || !all.items[key]) return;
  delete all.items[key];
  writeDrafts(all);
}
export function draftCount() {
  const all = readDrafts();
  return all.owner && all.owner === draftOwner() ? Object.keys(all.items).length : 0;
}
const clearAllDrafts = () => { try { sessionStorage.removeItem(DRAFTS_KEY); } catch { /* ignore */ } };

/* ------------------------------ inactivity lock ------------------------------ */
export const isLocked = () => Boolean(session && session.locked);
export const idleLockMinutes = () => (session && session.idleLockMinutes) || 15;
export function onLockChange(fn) {
  lockListeners.add(fn);
  return () => lockListeners.delete(fn);
}
function setLocked(locked) {
  if (!session || Boolean(session.locked) === locked) return;
  save({ ...session, locked });
  lockListeners.forEach((fn) => fn(locked));
}
/** The user was idle: tell the server (so the tokens stop working at once) and show the lock screen. */
export function lockNow() {
  if (!session || session.locked) return;
  fetch(`${BASE}/oauth/lock`, { method: 'POST', headers: { Authorization: `Bearer ${session.accessToken}` } }).catch(() => {});
  setLocked(true);
}
/** Resolves true once the lock screen is passed, false if the session ends instead. */
function whenUnlocked() {
  if (!isLocked()) return Promise.resolve(Boolean(session));
  return new Promise((resolve) => {
    const done = (v) => { offLock(); offSession(); resolve(v); };
    const offLock = onLockChange((locked) => { if (!locked) done(true); });
    const offSession = onSessionChange((u) => { if (!u) done(false); });
  });
}
/** Lock screen: the password continues the same session. Three wrong tries sign the user out. */
export async function unlock(password) {
  const res = await fetch(`${BASE}/oauth/unlock`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ refresh_token: session && session.refreshToken, password }) })
    .catch(() => { throw new Error('Cannot reach the server. Try again.'); });
  const data = await res.json().catch(() => ({}));
  if (res.ok) {
    save({ ...session, accessToken: data.access_token, refreshToken: data.refresh_token, locked: false });
    lockListeners.forEach((fn) => fn(false));
    return true;
  }
  if (data.reason === 'bad_password') throw new Error('Wrong password.');
  if (res.status === 429) throw new Error('Too many tries. Wait a few minutes.');
  endSession(data.reason || 'session_ended');
  throw new Error(data.error_description || 'Your session has ended.');
}

// A phone (or a narrow window) signs in as a phone session; nurses may keep one phone and one desktop session.
const deviceClass = () => (/Mobi|Android|iPhone|iPad/i.test(navigator.userAgent) || window.matchMedia('(max-width: 820px)').matches ? 'phone' : 'desktop');

async function tokenRequest(body) {
  let res;
  try {
    res = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Cannot reach the server. Check that the API gateway is running on port 8080.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error('Too many failed sign-in attempts. Wait 15 minutes and try again.');
  if (!res.ok) {
    const err = new Error(['account_pending', 'account_disabled'].includes(data.reason) || (body.grant_type === 'refresh_token' && data.reason)
      ? data.error_description
      : data.error === 'invalid_grant' ? 'Wrong username or password.' : data.error_description || 'Sign-in failed.');
    err.reason = data.reason;
    throw err;
  }
  save({
    accessToken: data.access_token, refreshToken: data.refresh_token, locked: false,
    idleLockMinutes: data.session ? data.session.idleLockMinutes : session && session.idleLockMinutes,
  });
  const drafts = readDrafts();
  if (drafts.owner && drafts.owner !== draftOwner()) clearAllDrafts(); // never show one user's draft to another
  return currentUser();
}

export const login = (username, password) => tokenRequest({ grant_type: 'password', username, password, device: deviceClass() });

/** Public account endpoints (activation code from SMS, password-reset link). */
export async function accountRequest(path, body) {
  let res;
  try {
    res = await fetch(`${BASE}/auth/${path}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Cannot reach the server. Try again.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error('Too many tries. Wait 15 minutes and try again.');
  if (!res.ok) { const err = new Error(data.message || 'Something went wrong.'); err.details = data.details; err.code = data.error; throw err; }
  return data;
}
export function logout() {
  const refreshToken = session && session.refreshToken;
  clearAllDrafts();
  save(null);
  // Best effort: end the server-side session so the tokens stop working everywhere (RFC 7009).
  if (refreshToken) {
    fetch(`${BASE}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: refreshToken, token_type_hint: 'refresh_token' }) })
      .catch(() => {});
  }
}

/** Sign-out button: warns first when unsent entries would be discarded. @returns {boolean} signed out */
export function requestSignOut() {
  const n = draftCount();
  if (n && !window.confirm(`You have ${n === 1 ? 'an unsent entry' : `${n} unsent entries`} (not yet sent to the clinic). Sign out and discard ${n === 1 ? 'it' : 'them'}?`)) return false;
  logout();
  return true;
}

/**
 * Switches to another account in one step: the old tokens are discarded before the new sign-in,
 * so no data from the previous user can be requested with the old session. On failure the user is
 * left signed out (never half-switched).
 */
export async function switchAccount(username, password) {
  logout();
  return login(username, password);
}

let refreshing = null;
/** @returns {Promise<true|string>} true, or why it failed ('session_locked', 'session_replaced', ...) */
function refresh() {
  if (!session || !session.refreshToken) return Promise.resolve('session_ended');
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
      .then(() => true, (err) => err.reason || 'session_ended')
      .finally(() => { refreshing = null; });
  }
  return refreshing;
}

export async function api(path, { method = 'GET', body } = {}, retried = false) {
  let res;
  try {
    res = await fetch(`${BASE}${path}`, {
      method,
      headers: {
        ...(body ? { 'Content-Type': 'application/json' } : {}),
        ...(session ? { Authorization: `Bearer ${session.accessToken}` } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
  } catch {
    const err = new Error('Cannot reach the server. Check that the API gateway is running.');
    err.status = 0;
    throw err;
  }
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (res.status === 401) {
    // Locked: keep the session and show the lock screen. Ended elsewhere: sign out with a message.
    // Otherwise the access token expired: refresh once and retry.
    let reason = data && data.reason;
    if (!reason && !retried) {
      const r = await refresh();
      if (r === true) return api(path, { method, body }, true);
      reason = r;
    }
    const err = new Error(reason === 'session_locked' ? 'Locked after inactivity.' : (data && data.message) || 'Please sign in again.');
    err.status = 401;
    err.reason = reason;
    if (reason === 'session_locked') {
      setLocked(true);
      // A save (not a background read) that hit the lock is sent again after the password is entered.
      if (method !== 'GET' && !retried && (await whenUnlocked())) return api(path, { method, body }, true);
    } else endSession(reason || 'session_ended');
    throw err;
  }
  if (!res.ok) {
    const detail = data && (data.details ? data.details.join('. ') : data.message);
    const err = new Error(detail || `Request failed (${res.status}).`);
    err.status = res.status;
    err.details = data && data.details;
    throw err;
  }
  return data;
}

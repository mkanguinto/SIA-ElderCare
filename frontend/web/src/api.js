// API client for the ElderCare Connect API Gateway.
// Tokens live in memory + sessionStorage (cleared when the tab closes). On a 401 the access
// token is refreshed once with the refresh token; if that fails the session ends.
// The gateway rotates refresh tokens and treats a reused one as theft, so concurrent 401s share ONE
// refresh request, and signing out revokes the session on the server (POST /oauth/revoke).

const BASE = import.meta.env.VITE_API_BASE_URL || ''; // '' => same origin (Vite proxy in dev)
const KEY = 'eldercare.session';
const listeners = new Set();

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

async function tokenRequest(body) {
  let res;
  try {
    res = await fetch(`${BASE}/oauth/token`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  } catch {
    throw new Error('Cannot reach the server. Check that the API gateway is running on port 8080.');
  }
  const data = await res.json().catch(() => ({}));
  if (res.status === 429) throw new Error('Too many failed sign-in attempts. Wait 15 minutes and try again.');
  if (!res.ok) throw new Error(data.error === 'invalid_grant' ? 'Wrong username or password.' : data.error_description || 'Sign-in failed.');
  save({ accessToken: data.access_token, refreshToken: data.refresh_token });
  return currentUser();
}

export const login = (username, password) => tokenRequest({ grant_type: 'password', username, password });
export function logout() {
  const refreshToken = session && session.refreshToken;
  save(null);
  // Best effort: end the server-side session so the tokens stop working everywhere (RFC 7009).
  if (refreshToken) {
    fetch(`${BASE}/oauth/revoke`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ token: refreshToken, token_type_hint: 'refresh_token' }) })
      .catch(() => {});
  }
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
function refresh() {
  if (!session || !session.refreshToken) return Promise.resolve(false);
  if (!refreshing) {
    refreshing = tokenRequest({ grant_type: 'refresh_token', refresh_token: session.refreshToken })
      .then(() => true, () => false)
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
  if (res.status === 401 && !retried && (await refresh())) return api(path, { method, body }, true);
  const data = res.status === 204 ? null : await res.json().catch(() => ({}));
  if (!res.ok) {
    const detail = data && (data.details ? data.details.join('. ') : data.message);
    const err = new Error(detail || `Request failed (${res.status}).`);
    err.status = res.status;
    err.details = data && data.details;
    if (res.status === 401) save(null);
    throw err;
  }
  return data;
}

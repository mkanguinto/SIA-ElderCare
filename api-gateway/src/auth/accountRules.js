'use strict';

/**
 * Account and session rules (pure, unit tested in test/accountRules.test.js).
 *
 *   created by admin ──> pending_activation ──(code from SMS + own password)──> active ──> disabled ──> active
 *
 * Activation codes expire after 24 hours, password-reset links after 1 hour; both are single use, a new one
 * replaces the old one, and five wrong tries lock a code. Only a keyed hash is stored, so nobody - including
 * the admin who sent it - can read a code back.
 */
const crypto = require('crypto');

const ROLES = ['caregiver', 'family_member', 'clinic_staff', 'system_admin'];
const ID_PREFIX = { caregiver: 'U-CG-', family_member: 'U-FM-', clinic_staff: 'U-CS-', system_admin: 'U-AD-' };
const DEFAULT_SCOPES = {
  caregiver: ['checkins:write', 'patients:read'],
  family_member: ['patients:read', 'alerts:read'],
  clinic_staff: ['clinic:read', 'clinic:write', 'alerts:dispatch'],
  system_admin: ['admin'],
};
const TOKEN_TTL_MIN = { activation: 24 * 60, password_reset: 60 };
const MAX_ATTEMPTS = 5;
// No 0/O, 1/I/L: the code is read off a phone screen and typed by older users.
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

/** "XXXX-XXXX" activation code (~40 bits; brute force is stopped by the 5-try lock and the rate limit). */
function newActivationCode() {
  const bytes = crypto.randomBytes(8);
  const chars = [...bytes].map((b) => CODE_ALPHABET[b % CODE_ALPHABET.length]).join('');
  return `${chars.slice(0, 4)}-${chars.slice(4)}`;
}
const normalizeCode = (c) => String(c || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
/** 256-bit secret for a reset link. */
const newResetToken = () => crypto.randomBytes(32).toString('base64url');

/** Keyed hash of a code / link secret. Codes are normalised first so "abcd efgh" matches "ABCD-EFGH". */
function hashSecret(secret, pepper, purpose) {
  const value = purpose === 'activation' ? normalizeCode(secret) : String(secret || '');
  return crypto.createHmac('sha256', pepper).update(`${purpose}:${value}`).digest('hex');
}

/**
 * @param {{expiresAt:Date|string, usedAt?, revokedAt?, attempts:number}|null} t
 * @returns {'ok'|'missing'|'expired'|'used'|'replaced'|'locked'}
 */
function tokenState(t, now = new Date()) {
  if (!t) return 'missing';
  if (t.usedAt) return 'used';
  if (t.revokedAt) return 'replaced';
  if (t.attempts >= MAX_ATTEMPTS) return 'locked';
  if (new Date(t.expiresAt).getTime() <= now.getTime()) return 'expired';
  return 'ok';
}
const TOKEN_MESSAGE = {
  missing: 'This code is not valid. Check it, or ask the clinic to send a new one.',
  expired: 'This code has expired. Ask the clinic to send a new one.',
  used: 'This code was already used. Sign in with your password.',
  replaced: 'A newer code was sent. Use the latest SMS.',
  locked: 'Too many wrong tries. Ask the clinic to send a new code.',
};

/** Philippine mobile number -> +639XXXXXXXXX, or null. */
function normalizePhone(v) {
  const d = String(v || '').replace(/[\s()-]/g, '');
  if (/^\+639\d{9}$/.test(d)) return d;
  if (/^639\d{9}$/.test(d)) return `+${d}`;
  if (/^09\d{9}$/.test(d)) return `+63${d.slice(1)}`;
  return null;
}
/** +639175550102 -> "+63 9•• ••• 0102" (enough for the user to recognise their number, not enough to leak it). */
const maskPhone = (e164) => (e164 ? `+63 9•• ••• ${e164.slice(-4)}` : null);

/** @returns {string[]} problems with a new password (empty = acceptable) */
function passwordProblems(pw, { username = '', name = '' } = {}) {
  const p = String(pw || '');
  const errors = [];
  if (p.length < 10) errors.push('Password must be at least 10 characters');
  if (p.length > 128) errors.push('Password must be at most 128 characters');
  if (!/[A-Za-z]/.test(p) || !/\d/.test(p)) errors.push('Password must contain letters and numbers');
  const lower = p.toLowerCase();
  const parts = [username, ...String(name).split(/[\s,.]+/)].map((x) => x.toLowerCase()).filter((x) => x.length >= 4);
  if (parts.some((x) => lower.includes(x))) errors.push('Password must not contain your name or username');
  if (['eldercare', 'password', '12345678', 'qwerty'].some((w) => lower.includes(w))) errors.push('Password is too easy to guess');
  return errors;
}

/**
 * Admin "create account" body.
 * @returns {{ok:true, value:object} | {ok:false, errors:string[]}}
 */
function validateNewAccount(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return { ok: false, errors: ['Body must be a JSON object'] };
  const username = typeof b.username === 'string' ? b.username.trim().toLowerCase() : '';
  if (!/^[a-z][a-z0-9._-]{2,39}$/.test(username)) errors.push('username must be 3-40 characters: letters, digits, . _ - (start with a letter)');
  const name = typeof b.name === 'string' ? b.name.trim() : '';
  if (name.length < 2 || name.length > 100) errors.push('name is required (2-100 characters)');
  if (!ROLES.includes(b.role)) errors.push(`role must be one of: ${ROLES.join(', ')}`);
  const phone = normalizePhone(b.phone);
  if (!phone) errors.push('phone must be a Philippine mobile number (09XXXXXXXXX or +639XXXXXXXXX): the activation code is sent there');
  let patients = [];
  if (b.patients !== undefined) {
    if (!Array.isArray(b.patients) || b.patients.length > 20 || b.patients.some((p) => typeof p !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(p))) {
      errors.push('patients must be a list of patient IDs (max 20)');
    } else patients = [...new Set(b.patients)];
  }
  if (patients.length && !['caregiver', 'family_member'].includes(b.role)) errors.push('Only caregivers and family members are linked to specific elders');
  // Family accounts are linked to an elder only through the clinic's identity verification (Batch 3b).
  if (b.role === 'family_member' && patients.length) errors.push('Family members are linked to an elder through family verification, not directly');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { username, name, role: b.role, phone, patients, scopes: DEFAULT_SCOPES[b.role] } };
}

/** Next id for a role from the ids already taken: U-CG-001, U-CG-002, ... */
function nextAccountId(role, takenIds) {
  const prefix = ID_PREFIX[role];
  const max = takenIds.filter((id) => id.startsWith(prefix)).map((id) => Number(id.slice(prefix.length)) || 0).reduce((a, n) => Math.max(a, n), 0);
  return `${prefix}${String(max + 1).padStart(3, '0')}`;
}

/* ------------------------------ sessions ------------------------------ */
const DEVICE_CLASSES = ['phone', 'desktop'];

/** Device class from what the client says, else from the User-Agent. */
function deviceClass(claimed, userAgent = '') {
  if (DEVICE_CLASSES.includes(claimed)) return claimed;
  return /Mobi|Android|iPhone|iPad/i.test(userAgent) ? 'phone' : 'desktop';
}

/**
 * Single session per user: a new sign-in ends the user's other sessions. Nurses may keep one phone session
 * and one desktop session (quick alerts on the phone, full records on the desktop), so for them only the
 * session on the same kind of device is ended.
 * @param {Array<{sid, deviceClass}>} active  the user's active sessions
 * @returns {string[]} sids to end
 */
function sessionsToReplace(role, newDeviceClass, active) {
  if (role === 'clinic_staff') return active.filter((s) => (s.deviceClass || 'desktop') === newDeviceClass).map((s) => s.sid);
  return active.map((s) => s.sid);
}

/** Minutes without activity before a session locks (password needed to continue). */
function idleLimitMinutes(role, env = process.env) {
  const clinical = Number(env.SESSION_IDLE_MINUTES_CLINICAL || 15);
  const home = Number(env.SESSION_IDLE_MINUTES_HOME || 30);
  return ['clinic_staff', 'system_admin'].includes(role) ? clinical : home;
}

module.exports = {
  ROLES, DEFAULT_SCOPES, TOKEN_TTL_MIN, MAX_ATTEMPTS, TOKEN_MESSAGE,
  newActivationCode, normalizeCode, newResetToken, hashSecret, tokenState,
  normalizePhone, maskPhone, passwordProblems, validateNewAccount, nextAccountId,
  DEVICE_CLASSES, deviceClass, sessionsToReplace, idleLimitMinutes,
};

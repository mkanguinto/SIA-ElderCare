'use strict';

/**
 * User credentials and profiles for the gateway's OAuth 2.0 token endpoint (async; backed by accountStore:
 * PostgreSQL auth_db, or data/users.json without a database).
 *
 * Passwords are stored as scrypt hashes: "scrypt$<saltHex>$<hashHex>".
 * Generate one with:  node scripts/hash-password.js "<password>"
 *
 * For a larger deployment, replace this with a dedicated identity provider (Keycloak, Auth0, Cognito) and
 * switch JWT_ALGORITHM to RS256 so the gateway only needs the IdP's public key.
 */
const crypto = require('crypto');
const { store } = require('./accountStore');

const KEYLEN = 64;

function hashPassword(password, salt = crypto.randomBytes(16).toString('hex')) {
  const hash = crypto.scryptSync(password, salt, KEYLEN).toString('hex');
  return `scrypt$${salt}$${hash}`;
}

function verifyPassword(password, stored) {
  const [algo, salt, hash] = String(stored || '').split('$');
  if (algo !== 'scrypt' || !salt || !hash) return false;
  const candidate = crypto.scryptSync(password, salt, KEYLEN);
  const expected = Buffer.from(hash, 'hex');
  return expected.length === candidate.length && crypto.timingSafeEqual(candidate, expected);
}

// Spend the same time on unknown usernames to avoid user-enumeration by timing.
const DUMMY_HASH = hashPassword('timing-equalizer');

/**
 * Password sign-in.
 * @returns {Promise<{user:object} | {reason:'invalid'|'pending_activation'|'disabled', account?:object}>}
 *   pending / disabled are reported only when the password is right, so they reveal nothing to a guesser.
 */
async function verifyLogin(username, password) {
  const account = await store.getByUsername(String(username || ''));
  const ok = verifyPassword(String(password || ''), (account && account.passwordHash) || DUMMY_HASH);
  if (!account) return { reason: 'invalid' };
  if (account.status === 'pending_activation') return { reason: 'pending_activation', account };
  if (!ok) return { reason: 'invalid', account };
  if (account.status === 'disabled') return { reason: 'disabled', account };
  return { user: account };
}

/** Kept for callers that only need yes/no. */
async function findByCredentials(username, password) {
  const r = await verifyLogin(username, password);
  return r.user || null;
}

/** Active account by id (null when missing, pending or disabled). */
async function findById(id) {
  const a = await store.getById(id);
  return a && a.status === 'active' ? a : null;
}

/** Any account by id, whatever its status. */
const getAccount = (id) => store.getById(id);

/** Safe view of an account for API responses - never the password hash. */
function publicAccount(a) {
  return {
    id: a.id, username: a.username, name: a.name, role: a.role, staffId: a.staffId || null, patients: a.patients || [], scopes: a.scopes || [],
    status: a.status, disabled: a.status === 'disabled', phone: a.phone ? `+63 9•• ••• ${a.phone.slice(-4)}` : null,
    createdAt: a.createdAt, createdBy: a.createdBy, activatedAt: a.activatedAt, lastLoginAt: a.lastLoginAt,
    passwordChangedAt: a.passwordChangedAt, disabledAt: a.disabledAt, disabledReason: a.disabledReason,
  };
}

/** Safe listing for the Admin View - never includes password hashes. */
async function listUsers() {
  return (await store.list()).map(publicAccount);
}

/**
 * Adds/removes patient IDs on a caregiver or family account (used when onboarding a patient). The user must
 * sign in again to get a token with the new `patients` claim.
 */
async function updateUserPatients(userId, { add = [], remove = [] }) {
  const user = await store.getById(userId);
  if (!user) return null;
  const set = new Set(user.patients || []);
  add.forEach((p) => set.add(p));
  remove.forEach((p) => set.delete(p));
  const updated = await store.update(userId, { patients: [...set].sort() });
  return { id: updated.id, username: updated.username, name: updated.name, role: updated.role, patients: updated.patients };
}

const staffIdOf = async (id) => (id ? ((await store.getById(id)) || {}).staffId || null : null);

/**
 * Appends to the account audit log: who did what to which account, from where. The staff IDs of the actor and
 * the target are recorded too, so one person's admin and nurse accounts show up together.
 */
async function audit(req, action, targetId, details = {}) {
  const actor = req && req.user ? { actorId: req.user.id, actorRole: req.user.role } : { actorId: details.actorId || 'anonymous', actorRole: details.actorRole || null };
  const { actorId, actorRole, ...rest } = details;
  const [actorStaffId, targetStaffId] = await Promise.all([staffIdOf(req && req.user ? req.user.id : null), staffIdOf(targetId)]);
  return store.audit({ ...actor, actorStaffId, action, targetId: targetId || null, targetStaffId, ip: req ? req.ip : null, details: rest });
}

module.exports = { hashPassword, verifyPassword, verifyLogin, findByCredentials, findById, getAccount, publicAccount, listUsers, updateUserPatients, audit, store };

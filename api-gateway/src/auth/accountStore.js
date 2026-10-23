'use strict';

/**
 * Where accounts, one-time account codes and the account audit log live.
 *
 *   AUTH_DATABASE_URL set   -> PostgreSQL (auth_db): the Docker stack and the cloud. Accounts created in the
 *                              app survive restarts and redeploys. data/users.json is imported once (accounts
 *                              not in the table yet), so the demo accounts exist on a fresh database.
 *   not set                 -> data/users.json (unit tests, running without Docker). Account changes are
 *                              written back to the file; codes and the audit log are kept in memory only.
 *
 * Both stores expose the same async interface; callers never see SQL or the file.
 */
const fs = require('fs');
const path = require('path');
const config = require('../config');
const logger = require('../lib/logger');

const FIELDS = ['id', 'username', 'name', 'role', 'phone', 'patients', 'scopes', 'passwordHash', 'status', 'createdBy', 'createdAt',
  'activatedAt', 'passwordChangedAt', 'lastLoginAt', 'disabledAt', 'disabledBy', 'disabledReason'];
const COLUMN = Object.fromEntries(FIELDS.map((f) => [f, f.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]));

/** users.json entry -> account */
function fromSeed(u) {
  return {
    id: u.id, username: u.username, name: u.name, role: u.role, phone: u.phone || null, patients: u.patients || [], scopes: u.scopes || [],
    passwordHash: u.passwordHash || null, status: u.status || (u.disabled ? 'disabled' : u.passwordHash ? 'active' : 'pending_activation'),
    createdBy: u.createdBy || 'bootstrap', createdAt: u.createdAt || null, activatedAt: u.activatedAt || null, passwordChangedAt: u.passwordChangedAt || null,
    lastLoginAt: u.lastLoginAt || null, disabledAt: u.disabledAt || null, disabledBy: u.disabledBy || null, disabledReason: u.disabledReason || null,
  };
}
const fromRow = (r) => (r ? Object.fromEntries(FIELDS.map((f) => [f, r[COLUMN[f]] ?? (f === 'patients' || f === 'scopes' ? [] : null)])) : null);
const tokenFromRow = (r) => (r ? {
  id: r.id, accountId: r.account_id, purpose: r.purpose, secretHash: r.secret_hash, expiresAt: r.expires_at, attempts: r.attempts,
  usedAt: r.used_at, revokedAt: r.revoked_at, sentTo: r.sent_to, delivery: r.delivery, createdBy: r.created_by, createdAt: r.created_at,
} : null);
const auditFromRow = (r) => ({ id: Number(r.id), at: r.at, actorId: r.actor_id, actorRole: r.actor_role, action: r.action, targetId: r.target_id, ip: r.ip, details: r.details });

/* ------------------------------ file store ------------------------------ */
class FileStore {
  constructor(file) {
    this.kind = 'file';
    this.file = file;
    this.accounts = null;
    this.tokens = [];
    this.auditLog = [];
    this.seq = 0;
  }

  async init() { this.load(); }

  load() {
    if (!this.accounts) this.accounts = JSON.parse(fs.readFileSync(this.file, 'utf8')).map(fromSeed);
    return this.accounts;
  }

  persist() {
    const out = this.accounts.map((a) => Object.fromEntries(Object.entries({ ...a, disabled: a.status === 'disabled' || undefined }).filter(([, v]) => v !== null && v !== undefined)));
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, `${JSON.stringify(out, null, 2)}\n`);
    fs.renameSync(tmp, this.file);
  }

  async getByUsername(username) { return this.load().find((a) => a.username.toLowerCase() === String(username || '').toLowerCase()) || null; }

  async getById(id) { return this.load().find((a) => a.id === id) || null; }

  async list() { return [...this.load()]; }

  async insert(account) {
    if (this.load().some((a) => a.id === account.id || a.username.toLowerCase() === account.username.toLowerCase())) {
      const err = new Error('Account already exists');
      err.code = 'conflict';
      throw err;
    }
    this.accounts.push({ ...account, createdAt: account.createdAt || new Date().toISOString() });
    this.persist();
    return this.getById(account.id);
  }

  async update(id, patch) {
    const a = this.load().find((x) => x.id === id);
    if (!a) return null;
    Object.assign(a, patch);
    this.persist();
    return { ...a };
  }

  async addToken(t) {
    const row = { id: require('crypto').randomUUID(), attempts: 0, usedAt: null, revokedAt: null, createdAt: new Date(), ...t };
    this.tokens.push(row);
    return { ...row };
  }

  async findToken(secretHash, purpose) { const t = this.tokens.find((x) => x.secretHash === secretHash && x.purpose === purpose); return t ? { ...t } : null; }

  async latestToken(accountId, purpose) {
    const t = this.tokens.filter((x) => x.accountId === accountId && x.purpose === purpose).sort((a, b) => b.createdAt - a.createdAt)[0];
    return t ? { ...t } : null;
  }

  async revokeOpenTokens(accountId, purpose) {
    let n = 0;
    for (const t of this.tokens) if (t.accountId === accountId && t.purpose === purpose && !t.usedAt && !t.revokedAt) { t.revokedAt = new Date(); n += 1; }
    return n;
  }

  async updateToken(id, patch) { const t = this.tokens.find((x) => x.id === id); if (t) Object.assign(t, patch); }

  async audit(e) { this.seq += 1; this.auditLog.push({ id: this.seq, at: new Date(), details: {}, ...e }); }

  async auditList({ limit = 100, targetId, action } = {}) {
    return this.auditLog.filter((e) => (!targetId || e.targetId === targetId) && (!action || e.action === action)).slice(-limit).reverse();
  }
}

/* ------------------------------ PostgreSQL store ------------------------------ */
class PgStore {
  constructor(url) {
    this.kind = 'postgres';
    // eslint-disable-next-line global-require
    const { Pool } = require('pg');
    this.pool = new Pool({
      connectionString: url,
      max: Number(process.env.AUTH_DB_POOL_MAX || 5),
      idleTimeoutMillis: 30000,
      connectionTimeoutMillis: 5000,
      ssl: process.env.DB_SSL === 'true' ? { rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED !== 'false' } : undefined,
    });
    this.pool.on('error', (err) => logger.error('auth db pool error', { error: err.message }));
  }

  async init() {
    for (let i = 1; ; i += 1) {
      try { await this.pool.query('SELECT 1'); break; } catch (err) {
        if (i >= 20) throw err;
        logger.warn('waiting for auth database', { attempt: i, error: err.message });
        await new Promise((r) => setTimeout(r, 1500));
      }
    }
    // eslint-disable-next-line global-require
    const { runMigrations } = require('../lib/migrations');
    await runMigrations(this.pool, path.join(__dirname, '../db/migrations'), logger);
    await this.importSeed();
  }

  /** Imports bootstrap accounts from users.json that the table does not have yet (existing rows always win). */
  async importSeed() {
    if (!fs.existsSync(config.usersFile)) return;
    const seed = JSON.parse(fs.readFileSync(config.usersFile, 'utf8')).map(fromSeed);
    let added = 0;
    for (const a of seed) {
      const { rowCount } = await this.pool.query(
        `INSERT INTO accounts (id, username, name, role, phone, patients, scopes, password_hash, status, created_by, activated_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,'bootstrap', CASE WHEN $9 = 'active' THEN now() END) ON CONFLICT DO NOTHING`,
        [a.id, a.username, a.name, a.role, a.phone, a.patients, a.scopes, a.passwordHash, a.status],
      );
      added += rowCount;
    }
    if (added) logger.info('bootstrap accounts imported', { added });
  }

  async getByUsername(username) { return fromRow((await this.pool.query('SELECT * FROM accounts WHERE lower(username) = lower($1)', [username])).rows[0]); }

  async getById(id) { return fromRow((await this.pool.query('SELECT * FROM accounts WHERE id = $1', [id])).rows[0]); }

  async list() { return (await this.pool.query('SELECT * FROM accounts ORDER BY role, name')).rows.map(fromRow); }

  async insert(a) {
    try {
      const { rows: [r] } = await this.pool.query(
        `INSERT INTO accounts (id, username, name, role, phone, patients, scopes, password_hash, status, created_by)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
        [a.id, a.username, a.name, a.role, a.phone, a.patients, a.scopes, a.passwordHash || null, a.status, a.createdBy],
      );
      return fromRow(r);
    } catch (err) {
      if (err.code === '23505') { const e = new Error('Account already exists'); e.code = 'conflict'; throw e; }
      throw err;
    }
  }

  async update(id, patch) {
    const keys = Object.keys(patch).filter((k) => COLUMN[k] && k !== 'id');
    if (!keys.length) return this.getById(id);
    const sets = keys.map((k, i) => `${COLUMN[k]} = $${i + 2}`).join(', ');
    const { rows: [r] } = await this.pool.query(`UPDATE accounts SET ${sets} WHERE id = $1 RETURNING *`, [id, ...keys.map((k) => patch[k])]);
    return fromRow(r);
  }

  async addToken(t) {
    const { rows: [r] } = await this.pool.query(
      `INSERT INTO account_tokens (account_id, purpose, secret_hash, expires_at, sent_to, delivery, created_by) VALUES ($1,$2,$3,$4,$5,$6,$7) RETURNING *`,
      [t.accountId, t.purpose, t.secretHash, t.expiresAt, t.sentTo || null, t.delivery || null, t.createdBy],
    );
    return tokenFromRow(r);
  }

  async findToken(secretHash, purpose) { return tokenFromRow((await this.pool.query('SELECT * FROM account_tokens WHERE secret_hash = $1 AND purpose = $2', [secretHash, purpose])).rows[0]); }

  async latestToken(accountId, purpose) {
    return tokenFromRow((await this.pool.query('SELECT * FROM account_tokens WHERE account_id = $1 AND purpose = $2 ORDER BY created_at DESC LIMIT 1', [accountId, purpose])).rows[0]);
  }

  async revokeOpenTokens(accountId, purpose) {
    return (await this.pool.query('UPDATE account_tokens SET revoked_at = now() WHERE account_id = $1 AND purpose = $2 AND used_at IS NULL AND revoked_at IS NULL', [accountId, purpose])).rowCount;
  }

  async updateToken(id, patch) {
    const map = { attempts: 'attempts', usedAt: 'used_at', delivery: 'delivery' };
    const keys = Object.keys(patch).filter((k) => map[k]);
    if (!keys.length) return;
    await this.pool.query(`UPDATE account_tokens SET ${keys.map((k, i) => `${map[k]} = $${i + 2}`).join(', ')} WHERE id = $1`, [id, ...keys.map((k) => patch[k])]);
  }

  async audit(e) {
    await this.pool.query('INSERT INTO account_audit (actor_id, actor_role, action, target_id, ip, details) VALUES ($1,$2,$3,$4,$5,$6)',
      [e.actorId, e.actorRole || null, e.action, e.targetId || null, e.ip || null, JSON.stringify(e.details || {})]);
  }

  async auditList({ limit = 100, targetId, action } = {}) {
    const where = [];
    const params = [];
    if (targetId) { params.push(targetId); where.push(`target_id = $${params.length}`); }
    if (action) { params.push(action); where.push(`action = $${params.length}`); }
    params.push(Math.min(Number(limit) || 100, 500));
    const { rows } = await this.pool.query(`SELECT * FROM account_audit ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY at DESC, id DESC LIMIT $${params.length}`, params);
    return rows.map(auditFromRow);
  }
}

const store = config.authDatabaseUrl ? new PgStore(config.authDatabaseUrl) : new FileStore(config.usersFile);
module.exports = { store, FileStore, PgStore };

'use strict';

/**
 * Server-side token state that makes the stateless JWTs revocable (Batch 2):
 *
 *   denied    jti -> exp          access tokens revoked before they expire (logout, POST /oauth/revoke)
 *   sessions  sid -> session      one refresh-token family per sign-in: the only refresh jti that may be
 *                                 used next, the previous one (for the reuse grace window), revocation
 *   users     userId -> epochSec  "every token issued before this moment is invalid" (admin kill switch)
 *
 * Entries are pruned once the tokens they guard have expired, so the store stays small.
 * Persisted to a JSON file (atomic temp file + rename, like users.json) so a gateway restart does not
 * un-revoke tokens. TOKEN_STORE_FILE=memory keeps it in memory only (tests).
 *
 * Scope: one gateway instance. Several gateway replicas would need a shared store (Redis/PostgreSQL)
 * behind the same interface.
 */
const fs = require('fs');
const path = require('path');
const logger = require('../lib/logger');

const now = () => Math.floor(Date.now() / 1000);

class TokenStore {
  constructor(file) {
    this.file = file && file !== 'memory' ? file : null;
    this.state = { denied: {}, sessions: {}, users: {} };
    if (this.file && fs.existsSync(this.file)) {
      try {
        const loaded = JSON.parse(fs.readFileSync(this.file, 'utf8'));
        this.state = { denied: loaded.denied || {}, sessions: loaded.sessions || {}, users: loaded.users || {} };
      } catch (err) {
        // Fail closed would lock every user out; fail open would un-revoke tokens. Start empty but loudly.
        logger.error('token store unreadable, starting empty', { file: this.file, error: err.message });
      }
    }
    this.prune();
  }

  prune() {
    const t = now();
    for (const [jti, exp] of Object.entries(this.state.denied)) if (exp < t) delete this.state.denied[jti];
    for (const [sid, s] of Object.entries(this.state.sessions)) if (s.exp < t) delete this.state.sessions[sid];
  }

  save() {
    this.prune();
    if (!this.file) return;
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(this.state), { mode: 0o600 });
    fs.renameSync(tmp, this.file);
  }

  /* ---- access-token deny-list ---- */
  denyJti(jti, exp) {
    if (!jti) return;
    this.state.denied[jti] = exp || now() + 3600;
    this.save();
  }

  isDenied(jti) {
    return Boolean(jti && this.state.denied[jti]);
  }

  /* ---- refresh-token sessions (rotation + reuse detection) ---- */
  createSession({ sid, userId, jti, exp }) {
    this.state.sessions[sid] = { userId, currentJti: jti, previousJti: null, rotatedAt: null, createdAt: now(), exp, revokedAt: null, reason: null };
    this.save();
  }

  getSession(sid) {
    return (sid && this.state.sessions[sid]) || null;
  }

  rotateSession(sid, newJti, exp) {
    const s = this.state.sessions[sid];
    s.previousJti = s.currentJti;
    s.currentJti = newJti;
    s.rotatedAt = now();
    s.exp = exp;
    this.save();
  }

  revokeSession(sid, reason) {
    const s = this.state.sessions[sid];
    if (!s || s.revokedAt) return false;
    s.revokedAt = now();
    s.reason = reason;
    this.save();
    return true;
  }

  /* ---- per-user revocation ---- */
  revokeUser(userId, reason = 'admin_revoked') {
    const t = now();
    this.state.users[userId] = t;
    let sessions = 0;
    for (const s of Object.values(this.state.sessions)) {
      if (s.userId === userId && !s.revokedAt) { s.revokedAt = t; s.reason = reason; sessions += 1; }
    }
    this.save();
    return { revokedBefore: t, sessions };
  }

  userRevokedBefore(userId) {
    return this.state.users[userId] || 0;
  }

  stats() {
    const sessions = Object.values(this.state.sessions);
    return {
      persistent: Boolean(this.file),
      activeSessions: sessions.filter((s) => !s.revokedAt).length,
      revokedSessions: sessions.filter((s) => s.revokedAt).length,
      deniedAccessTokens: Object.keys(this.state.denied).length,
    };
  }
}

module.exports = { TokenStore };

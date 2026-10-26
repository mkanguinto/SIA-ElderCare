'use strict';

/**
 * Team-lead nurses (team_role "lead" on a care team, kept by the clinic service) run their teams: they create
 * caregiver and family accounts, register and link elders to the teams they lead, and see the operations pages
 * (service health, message queues, audit log). Staff accounts, care-team structure and replays stay with the admin.
 *
 *   adminOrTeamLead      -> the admin, or a nurse who leads at least one team (req.user.leadTeams is set)
 *   leadTeamsFor(user)   -> the team ids a nurse leads ([] for everyone else)
 */
const config = require('../config');
const { ROLES } = require('../config/roles');
const { request } = require('../lib/resilientHttp');
const logger = require('../lib/logger');

const CACHE_MS = 30 * 1000;
const cache = new Map(); // userId -> { teams, at }

async function leadTeamsFor(user, requestId) {
  if (!user || user.role !== ROLES.CLINIC) return [];
  const hit = cache.get(user.id);
  if (hit && Date.now() - hit.at < CACHE_MS) return hit.teams;
  try {
    const r = await request('clinic', {
      method: 'GET', url: `${config.services.clinic}/internal/staff/${encodeURIComponent(user.id)}/lead-teams`,
      headers: { 'x-internal-token': config.internalServiceToken, 'x-request-id': requestId }, validateStatus: () => true,
    }, { retries: 1, timeoutMs: config.upstreamTimeoutMs });
    const teams = r.status === 200 && Array.isArray(r.data.teams) ? r.data.teams : [];
    cache.set(user.id, { teams, at: Date.now() });
    return teams;
  } catch (err) {
    logger.warn('team-lead lookup failed', { requestId, userId: user.id, error: err.message });
    return hit ? hit.teams : [];
  }
}

async function adminOrTeamLead(req, res, next) {
  if (!req.user) return res.status(401).json({ error: 'unauthorized', message: 'Authentication required' });
  if (req.user.role === ROLES.ADMIN) return next();
  const teams = await leadTeamsFor(req.user, req.id);
  if (!teams.length) return res.status(403).json({ error: 'forbidden', message: 'Only the admin or a team-lead nurse can do this' });
  req.user.leadTeams = teams;
  return next();
}

const isTeamLead = (req) => Boolean(req.user && req.user.role === ROLES.CLINIC && req.user.leadTeams && req.user.leadTeams.length);

module.exports = { adminOrTeamLead, leadTeamsFor, isTeamLead };

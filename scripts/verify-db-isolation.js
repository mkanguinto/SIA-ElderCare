#!/usr/bin/env node
// Proves the database-per-service rule with real logins (professor's evaluation: "each service connects
// using dedicated, non-shared database user credentials so cross-database SQL joins are strictly prevented").
//
// For every pair (service A's credentials, service B's database) it tries to connect and run a query.
// PASS = A reaches only its own database, and A's login is not a superuser.
//
//   npm run verify:db-isolation            # Docker stack (host ports 5433-5435, passwords from ./.env)
//   npm run verify:db-isolation -- --local # credentials from each service's .env (setup-local.js)
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
// eslint-disable-next-line import/no-dynamic-require
const pg = require(path.join(root, 'services/checkin-service/node_modules/pg'));

function readEnv(file) {
  if (!fs.existsSync(file)) return {};
  return Object.fromEntries(fs.readFileSync(file, 'utf8').split(/\r?\n/).map((l) => /^([A-Z0-9_]+)=(.*)$/.exec(l)).filter(Boolean).map((m) => [m[1], m[2]]));
}

function targets() {
  if (process.argv.includes('--local')) {
    return ['checkin-service', 'alert-service', 'clinic-risk-service'].map((s) => {
      const url = new URL(readEnv(path.join(root, 'services', s, '.env')).DATABASE_URL);
      return { service: s, user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), host: url.hostname, port: Number(url.port || 5432), db: url.pathname.slice(1) };
    });
  }
  const env = { ...readEnv(path.join(root, '.env')), ...process.env };
  return [
    { service: 'checkin-service', user: 'checkin_svc', password: env.CHECKIN_DB_PASSWORD || 'checkin_pass', port: 5433, db: 'checkin_db' },
    { service: 'alert-service', user: 'alert_svc', password: env.ALERT_DB_PASSWORD || 'alert_pass', port: 5434, db: 'alert_db' },
    { service: 'clinic-risk-service', user: 'clinic_svc', password: env.CLINIC_DB_PASSWORD || 'clinic_pass', port: 5435, db: 'clinic_db' },
  ].map((t) => ({ host: 'localhost', ...t }));
}

async function tryConnect(creds, db) {
  const c = new pg.Client({ host: db.host, port: db.port, database: db.db, user: creds.user, password: creds.password, connectionTimeoutMillis: 4000 });
  try {
    await c.connect();
    const { rows: [r] } = await c.query('SELECT current_user, (SELECT rolsuper FROM pg_roles WHERE rolname = current_user) AS superuser');
    return { ok: true, superuser: r.superuser };
  } catch (err) {
    return { ok: false, error: err.code || err.message };
  } finally {
    await c.end().catch(() => {});
  }
}

(async () => {
  const list = targets();
  let failures = 0;
  console.log('credentials of        -> database of           result');
  for (const a of list) {
    for (const b of list) {
      const r = await tryConnect(a, b);
      const own = a.service === b.service;
      let verdict;
      if (own) verdict = r.ok && !r.superuser ? 'PASS (own DB, non-superuser)' : r.ok ? 'FAIL (login is a superuser)' : `FAIL (cannot reach own DB: ${r.error})`;
      else verdict = r.ok ? 'FAIL (cross-service access allowed!)' : `PASS (refused: ${r.error})`;
      if (verdict.startsWith('FAIL')) failures += 1;
      console.log(`${a.service.padEnd(21)} -> ${b.service.padEnd(21)} ${verdict}`);
    }
  }
  console.log(failures ? `\n${failures} isolation check(s) failed` : '\nDatabase isolation verified: every service can only reach its own database.');
  process.exit(failures ? 1 : 0);
})();

#!/usr/bin/env node
// One-command local setup (no Docker). Creates every service's .env from its .env.example with
//   - one freshly generated INTERNAL_SERVICE_TOKEN shared by all services
//   - freshly generated JWT_SECRET / JWT_REFRESH_SECRET for the gateway
//   - DATABASE ISOLATION: each service gets its OWN PostgreSQL login (checkin_svc, alert_svc, clinic_svc, care_svc)
//     with a random password and CONNECT rights to its own database only. Cross-database access with
//     another service's credentials is refused by PostgreSQL itself (professor's evaluation, Section 18).
//   - messaging: --amqp <url> to use a local RabbitMQ, otherwise EVENT_TRANSPORT=http (direct REST fallback)
//   - SMS_DRY_RUN=true
//
//   node scripts/setup-local.js "YourPostgresSuperuserPassword"            # create missing .env files + DB roles
//   node scripts/setup-local.js "YourPostgresSuperuserPassword" --force    # regenerate everything
//   Options: --db-host localhost --db-port 5432 --db-user postgres --amqp amqp://guest:guest@localhost:5672
//
// The superuser password is used once to create the roles/databases and is never written to any .env.
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const args = process.argv.slice(2);
const flag = (name, def) => { const i = args.indexOf(`--${name}`); return i >= 0 ? args[i + 1] : def; };
const VALUE_FLAGS = ['--db-host', '--db-port', '--db-user', '--amqp'];
const password = args.find((a, i) => !a.startsWith('--') && !VALUE_FLAGS.includes(args[i - 1]));
if (!password) {
  console.error('Usage: node scripts/setup-local.js "YourPostgresSuperuserPassword" [--force] [--db-port 5432] [--db-user postgres] [--amqp amqp://guest:guest@localhost:5672]');
  process.exit(1);
}
const force = args.includes('--force');
const host = flag('db-host', 'localhost');
const port = flag('db-port', '5432');
const superUser = flag('db-user', 'postgres');
const amqp = flag('amqp', '');

const rand = (n) => crypto.randomBytes(n).toString('base64url');
const internalToken = `ec-internal-${crypto.randomBytes(24).toString('hex')}`;
const root = path.join(__dirname, '..');

// One database + one dedicated, non-shared login per microservice.
const DBS = {
  'services/checkin-service': { db: 'checkin_db', role: 'checkin_svc', password: rand(18) },
  'services/alert-service': { db: 'alert_db', role: 'alert_svc', password: rand(18) },
  'services/clinic-risk-service': { db: 'clinic_db', role: 'clinic_svc', password: rand(18) },
  'services/care-plan-service': { db: 'care_db', role: 'care_svc', password: rand(18) },
  'api-gateway': { db: 'auth_db', role: 'auth_svc', password: rand(18) },
};
const dbUrl = (d) => `postgres://${d.role}:${encodeURIComponent(d.password)}@${host}:${port}/${d.db}`;
const messaging = amqp ? { EVENT_TRANSPORT: 'rabbitmq', AMQP_URL: amqp } : { EVENT_TRANSPORT: 'http', AMQP_URL: '' };

const SERVICES = {
  'api-gateway': { INTERNAL_SERVICE_TOKEN: internalToken, JWT_SECRET: rand(48), JWT_REFRESH_SECRET: rand(48), AUTH_DATABASE_URL: dbUrl(DBS['api-gateway']), ACCOUNT_SMS_CAPTURE: 'true' },
  'services/checkin-service': { INTERNAL_SERVICE_TOKEN: internalToken, DATABASE_URL: dbUrl(DBS['services/checkin-service']), ...messaging },
  'services/alert-service': { INTERNAL_SERVICE_TOKEN: internalToken, DATABASE_URL: dbUrl(DBS['services/alert-service']), SMS_DRY_RUN: 'true', ...messaging },
  'services/clinic-risk-service': { INTERNAL_SERVICE_TOKEN: internalToken, DATABASE_URL: dbUrl(DBS['services/clinic-risk-service']), ...messaging },
  'services/legacy-emr-adapter': { INTERNAL_SERVICE_TOKEN: internalToken },
  'services/care-plan-service': { INTERNAL_SERVICE_TOKEN: internalToken, DATABASE_URL: dbUrl(DBS['services/care-plan-service']), SEED_DEMO_DATA: 'true' },
};

function isolationSql() {
  const lines = [];
  for (const d of Object.values(DBS)) {
    const pw = d.password.replace(/'/g, "''");
    lines.push(
      `DO $$ BEGIN IF NOT EXISTS (SELECT FROM pg_roles WHERE rolname = '${d.role}') THEN CREATE ROLE ${d.role} LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE; END IF; END $$;`,
      `ALTER ROLE ${d.role} WITH LOGIN PASSWORD '${pw}';`,
    );
  }
  return lines;
}

async function applyDatabaseIsolation() {
  let pg;
  try {
    // pg is installed in every service after `npm run install:all`
    // eslint-disable-next-line global-require, import/no-dynamic-require
    pg = require(path.join(root, 'services/checkin-service/node_modules/pg'));
  } catch {
    return false;
  }
  const admin = new pg.Client({ host, port: Number(port), user: superUser, password, database: 'postgres' });
  await admin.connect();
  try {
    for (const stmt of isolationSql()) await admin.query(stmt);
    for (const d of Object.values(DBS)) {
      const { rowCount } = await admin.query('SELECT 1 FROM pg_database WHERE datname = $1', [d.db]);
      if (!rowCount) await admin.query(`CREATE DATABASE ${d.db} OWNER ${d.role}`);
      else await admin.query(`ALTER DATABASE ${d.db} OWNER TO ${d.role}`);
      await admin.query(`REVOKE ALL ON DATABASE ${d.db} FROM PUBLIC`);
      await admin.query(`GRANT CONNECT, TEMP ON DATABASE ${d.db} TO ${d.role}`);
      // Schema-level grants + pgcrypto must be done inside each database.
      const inDb = new pg.Client({ host, port: Number(port), user: superUser, password, database: d.db });
      await inDb.connect();
      try {
        await inDb.query('CREATE EXTENSION IF NOT EXISTS pgcrypto');
        await inDb.query(`ALTER SCHEMA public OWNER TO ${d.role}`);
        await inDb.query(`REASSIGN OWNED BY ${superUser} TO ${d.role}`).catch(() => {}); // tables created by an older setup
      } finally {
        await inDb.end();
      }
    }
  } finally {
    await admin.end();
  }
  return true;
}

(async () => {
  let skipped = 0;
  for (const [dir, overrides] of Object.entries(SERVICES)) {
    const example = path.join(root, dir, '.env.example');
    const target = path.join(root, dir, '.env');
    if (fs.existsSync(target) && !force) {
      console.log(`skip    ${dir}/.env (already exists - use --force to overwrite)`);
      skipped += 1;
      continue;
    }
    const lines = fs.readFileSync(example, 'utf8').split(/\r?\n/);
    const seen = new Set();
    const out = lines.map((line) => {
      const m = /^([A-Z0-9_]+)=/.exec(line);
      if (m && Object.prototype.hasOwnProperty.call(overrides, m[1])) { seen.add(m[1]); return `${m[1]}=${overrides[m[1]]}`; }
      return line;
    });
    for (const [k, v] of Object.entries(overrides)) if (!seen.has(k)) out.push(`${k}=${v}`);
    fs.writeFileSync(target, out.join('\n'));
    console.log(`created ${dir}/.env`);
  }

  if (skipped === Object.keys(SERVICES).length) {
    console.log('\nNothing changed. Your existing .env files were kept.');
    return;
  }
  try {
    if (await applyDatabaseIsolation()) {
      console.log('\nDatabase isolation applied: checkin_svc -> checkin_db, alert_svc -> alert_db, clinic_svc -> clinic_db, care_svc -> care_db, auth_svc -> auth_db (no shared logins).');
    } else {
      const file = path.join(root, 'scripts', '.local-db-isolation.sql');
      const dbLines = Object.values(DBS).flatMap((d) => [`CREATE DATABASE ${d.db} OWNER ${d.role};`, `REVOKE ALL ON DATABASE ${d.db} FROM PUBLIC;`, `GRANT CONNECT, TEMP ON DATABASE ${d.db} TO ${d.role};`]);
      fs.writeFileSync(file, [...isolationSql(), ...dbLines, ''].join('\n'));
      console.log(`\nRun "npm run install:all" and then this script again with --force to create the database roles,`);
      console.log(`or apply ${path.relative(root, file)} with psql -U ${superUser} (it contains the generated passwords; it is git-ignored).`);
    }
  } catch (err) {
    console.error(`\nCould not create the database roles automatically: ${err.message}`);
    console.error('Check the superuser password / --db-user and run again with --force.');
    process.exitCode = 1;
  }
  console.log(`\nMessaging: ${amqp ? `RabbitMQ at ${amqp.replace(/\/\/[^@]*@/, '//***@')}` : 'EVENT_TRANSPORT=http (no broker). Pass --amqp amqp://guest:guest@localhost:5672 to use RabbitMQ.'}`);
  console.log('\nINTERNAL_SERVICE_TOKEN for SoapUI (project property "internalToken"):');
  console.log(`  ${internalToken}`);
  if (skipped) console.log('\nNote: some .env files were skipped, so tokens may now differ between services. Re-run with --force to regenerate all of them together.');
  console.log('\nVerify isolation any time with: npm run verify:db-isolation');
})();

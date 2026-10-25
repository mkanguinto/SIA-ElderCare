#!/usr/bin/env node
/**
 * Clears all patient data in the cloud (Neon) databases, for a clean start (e.g. before a presentation).
 *
 *   node scripts/reset-patient-data.mjs            show what would be cleared (counts only, changes nothing)
 *   node scripts/reset-patient-data.mjs --yes      clear it (permanent - there is no undo)
 *
 * Cleared: patients and everything about them - check-ins, medicines, risk cases, visits, handovers, care plans,
 * tasks and reports, concerns, family messages, alerts, notifications and SMS contacts. Caregiver and family
 * accounts are unlinked from their elders, and new patient numbers start again at P-1001.
 * Kept: every account (staff, caregiver, family), care teams and their nurses, nurse duty, alert rules, the
 * account audit log and the migration history.
 *
 * Needs NEON_DATABASE_URL in .env (the Neon owner login) and Docker (psql runs in a container, as in
 * deploy-render.mjs). Render must deploy with SEED_DEMO_DATA=false (the default of deploy-render.mjs), or the
 * demo patients come back at the next start-up.
 */
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readEnv = (file) => (fs.existsSync(file) ? Object.fromEntries(fs.readFileSync(file, 'utf8').split('\n')
  .filter((l) => /^[A-Z0-9_]+=/.test(l)).map((l) => { const i = l.indexOf('='); return [l.slice(0, i), l.slice(i + 1).replace(/^["']|["']$/g, '')]; })) : {});
const env = { ...readEnv(path.join(ROOT, '.env')), ...process.env };
const YES = process.argv.includes('--yes');

// Patient data, per database. Tables not listed are kept.
const CLEAR = {
  checkin_db: ['checkin_status_log', 'missed_checkin_flags', 'outbox_events', 'checkins', 'patient_medications', 'patients'],
  clinic_db: ['followup_actions', 'risk_queue', 'scheduled_visits', 'handover_record', 'care_assignment_log', 'patient_care',
    'contact_request_events', 'contact_requests', 'concern_events', 'care_concerns', 'outbox_events', 'processed_events'],
  care_db: ['task_completions', 'medication_reports', 'report_revisions', 'care_plan_events', 'care_tasks', 'care_plan_versions', 'care_plans'],
  alert_db: ['notification_log', 'alerts', 'alert_dedupe', 'subscribers', 'outbox_events', 'processed_events'],
};

// The URL goes in through an environment variable and the SQL through stdin, so neither appears in a process
// list or an error message (same as deploy-render.mjs).
function psql(url, sql) {
  try {
    return execFileSync('docker', ['run', '--rm', '-i', '-e', 'PGURL', 'postgres:16-alpine', 'sh', '-c', 'psql "$PGURL" -v ON_ERROR_STOP=1 -qAt'],
      { encoding: 'utf8', input: sql, env: { ...process.env, PGURL: url }, stdio: ['pipe', 'pipe', 'pipe'] }).trim();
  } catch (e) {
    const why = String(e.stderr || '').replace(/postgres(ql)?:\/\/\S+/g, '<database url>').trim();
    throw new Error(`Neon SQL failed: ${why.split('\n').slice(-3).join(' ') || 'docker or psql could not run (is Docker running?)'}`);
  }
}
const inDb = (db) => env.NEON_DATABASE_URL.replace(/\/[^/?]+(\?|$)/, `/${db}$1`);
const existing = (db, tables) => psql(inDb(db), `SELECT string_agg(t, ',') FROM unnest(ARRAY['${tables.join("','")}']) t WHERE to_regclass('public.' || t) IS NOT NULL`)
  .split(',').filter(Boolean);
const count = (db, tables) => Object.fromEntries(psql(inDb(db), tables.map((t) => `SELECT '${t}', count(*) FROM ${t};`).join('\n'))
  .split('\n').filter(Boolean).map((l) => { const [t, n] = l.split('|'); return [t, Number(n)]; }));

if (!env.NEON_DATABASE_URL) { console.error('NEON_DATABASE_URL is missing in .env'); process.exit(1); }

let total = 0;
for (const [db, wanted] of Object.entries(CLEAR)) {
  const tables = existing(db, wanted);
  const before = count(db, tables);
  const rows = Object.values(before).reduce((a, b) => a + b, 0);
  total += rows;
  console.log(`${db}: ${rows} rows in ${tables.length} tables  ${Object.entries(before).filter(([, n]) => n).map(([t, n]) => `${t} ${n}`).join(', ')}`);
  if (YES && tables.length) {
    // TRUNCATE (not DELETE): the record-keeping guards that stop deleting single prescriptions or plan events
    // do not apply to wiping the whole data set, which is what this script is for.
    psql(inDb(db), `TRUNCATE ${tables.join(', ')} RESTART IDENTITY CASCADE;${db === 'checkin_db' ? ' ALTER SEQUENCE IF EXISTS patient_id_seq RESTART WITH 1001;' : ''}`);
  }
}
const linked = psql(inDb('auth_db'), "SELECT count(*) FROM accounts WHERE cardinality(patients) > 0");
console.log(`auth_db: ${linked} account(s) linked to elders (accounts themselves are kept)`);
if (YES) psql(inDb('auth_db'), "UPDATE accounts SET patients = '{}' WHERE cardinality(patients) > 0");

console.log(YES
  ? `\nCleared ${total} patient-data rows and unlinked ${linked} account(s). New patients start at P-1001. Signed-in caregivers and family must sign out and in again.`
  : '\nNothing changed. Run again with --yes to clear these permanently.');

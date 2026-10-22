#!/usr/bin/env node
// Cross-platform helper:  node scripts/run-all.js install   |   node scripts/run-all.js test
'use strict';
const { execSync } = require('child_process');
const path = require('path');

const cmd = process.argv[2];
const SERVICES = ['api-gateway', 'services/checkin-service', 'services/alert-service', 'services/clinic-risk-service', 'services/legacy-emr-adapter', 'services/care-plan-service', 'integration/node-red'];
const RUN = { install: 'npm install --no-audit --no-fund', test: 'npm test' };
if (!RUN[cmd]) { console.error('Usage: node scripts/run-all.js <install|test>'); process.exit(1); }

let failed = 0;
for (const s of SERVICES) {
  console.log(`\n=== ${s}: ${RUN[cmd]}`);
  try { execSync(RUN[cmd], { cwd: path.join(__dirname, '..', s), stdio: 'inherit' }); } catch { failed += 1; }
}
console.log(failed ? `\n${failed} package(s) failed` : '\nall packages OK');
process.exit(failed ? 1 : 0);

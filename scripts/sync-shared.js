#!/usr/bin/env node
// Copies shared helpers (logger, resilient HTTP client, internal auth) into each service's src/lib,
// so every service stays independently buildable and deployable. Run after editing anything in shared/ (npm run sync-shared).
'use strict';
const fs = require('fs');
const path = require('path');

const root = path.join(__dirname, '..');
const MESSAGING = ['eventContracts.js', 'messageBus.js', 'outboxRelay.js', 'idempotency.js', 'eventing.js'];
const BASE = ['logger.js', 'resilientHttp.js', 'internalAuth.js'];
const targets = {
  'services/checkin-service': [...BASE, ...MESSAGING],
  'services/alert-service': [...BASE, ...MESSAGING],
  'services/clinic-risk-service': [...BASE, ...MESSAGING],
  'services/legacy-emr-adapter': BASE,
  'api-gateway': ['logger.js', 'resilientHttp.js'],
};
const contractsSrc = path.join(root, 'contracts', 'events');
for (const [dir, files] of Object.entries(targets)) {
  const lib = path.join(root, dir, 'src', 'lib');
  fs.mkdirSync(lib, { recursive: true });
  for (const f of files) fs.copyFileSync(path.join(root, 'shared', f), path.join(lib, f));
  // Services that publish/consume events carry their own copy of the event contracts (JSON Schema).
  if (files.includes('eventContracts.js')) {
    const dest = path.join(lib, 'contracts', 'events');
    fs.mkdirSync(dest, { recursive: true });
    for (const f of fs.readdirSync(contractsSrc)) fs.copyFileSync(path.join(contractsSrc, f), path.join(dest, f));
  }
}
console.log('shared helpers and event contracts synced');

#!/usr/bin/env node
// Writes random secrets for docker-compose.secrets.yml into ./secrets/ (git-ignored, mode 600).
//   npm run secrets:generate            # creates missing files only
//   npm run secrets:generate -- --force # replaces all of them (signs everyone out)
'use strict';
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const dir = path.join(__dirname, '..', 'secrets');
const force = process.argv.includes('--force');
fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

for (const name of ['jwt_secret', 'jwt_refresh_secret', 'internal_service_token']) {
  const file = path.join(dir, name);
  if (fs.existsSync(file) && !force) {
    console.log(`kept      secrets/${name}`);
    continue;
  }
  fs.writeFileSync(file, `${crypto.randomBytes(48).toString('base64url')}\n`, { mode: 0o600 });
  console.log(`generated secrets/${name}`);
}

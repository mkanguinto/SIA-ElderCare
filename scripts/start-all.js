#!/usr/bin/env node
// Start every service (and the web app) in ONE terminal, with coloured, prefixed logs.
//
//   npm run start:all            # 6 backend services + web dashboard
//   npm run start:all -- --no-web
//
// Ctrl+C stops everything. If one service crashes, the others keep running and the crash is reported.
// Uses each service's own .env (create them first with: node scripts/setup-local.js "YourPostgresPassword").
'use strict';
const { spawn, execSync } = require('child_process');
const fs = require('fs');
const http = require('http');
const path = require('path');

const root = path.join(__dirname, '..');
const isWin = process.platform === 'win32';
const withWeb = !process.argv.includes('--no-web');

// Order matters only for the first log lines: dependencies first, gateway last.
const APPS = [
  { name: 'emr', dir: 'services/mock-legacy-emr', port: 4005, color: 90 },
  { name: 'adapter', dir: 'services/legacy-emr-adapter', port: 4004, color: 35 },
  { name: 'clinic', dir: 'services/clinic-risk-service', port: 4003, color: 33 },
  { name: 'care', dir: 'services/care-plan-service', port: 4006, color: 94 },
  { name: 'alert', dir: 'services/alert-service', port: 4002, color: 31 },
  { name: 'checkin', dir: 'services/checkin-service', port: 4001, color: 32 },
  { name: 'gateway', dir: 'api-gateway', port: 8080, color: 36 },
];
const WEB = { name: 'web', dir: 'frontend/web', color: 34, cmd: 'npm', args: ['run', 'dev'] };

const width = Math.max(...APPS.map((a) => a.name.length), WEB.name.length);
const tag = (a) => `\x1b[${a.color}m${a.name.padEnd(width)} |\x1b[0m`;
const say = (msg) => console.log(`\x1b[1m${'start'.padEnd(width)} |\x1b[0m ${msg}`);

// ---- pre-flight checks: clear messages instead of cryptic crashes
const problems = [];
for (const a of APPS) {
  const dir = path.join(root, a.dir);
  if (a.name !== 'emr' && !fs.existsSync(path.join(dir, 'node_modules'))) problems.push(`${a.dir}: packages missing -> run "npm run install:all"`);
  if (['clinic', 'alert', 'checkin', 'care', 'gateway', 'adapter'].includes(a.name) && !fs.existsSync(path.join(dir, '.env'))) {
    problems.push(`${a.dir}: .env missing -> run node scripts/setup-local.js "YourPostgresPassword"`);
  }
}
if (problems.length) {
  console.error('Cannot start yet:\n  - ' + problems.join('\n  - '));
  process.exit(1);
}
if (withWeb && !fs.existsSync(path.join(root, WEB.dir, 'node_modules'))) {
  say('installing web packages (first run only)...');
  execSync('npm install --no-audit --no-fund', { cwd: path.join(root, WEB.dir), stdio: 'inherit', shell: true });
}

// ---- run
const children = [];
let stopping = false;

function pipe(stream, a) {
  let buf = '';
  stream.on('data', (chunk) => {
    buf += chunk.toString();
    const lines = buf.split(/\r?\n/);
    buf = lines.pop();
    for (const line of lines) if (line.trim()) console.log(`${tag(a)} ${line}`);
  });
}

function start(a) {
  const cmd = a.cmd || process.execPath; // run "node server.js" directly: no npm.cmd quirks on Windows
  const args = a.args || ['server.js'];
  const child = spawn(cmd, args, {
    cwd: path.join(root, a.dir),
    env: { ...process.env, FORCE_COLOR: '0' },
    shell: Boolean(a.cmd) && isWin, // only "npm run dev" needs a shell on Windows
    windowsHide: true,
  });
  pipe(child.stdout, a);
  pipe(child.stderr, a);
  child.on('exit', (code) => {
    if (!stopping) say(`\x1b[31m${a.name} stopped (exit code ${code}). Scroll up for its error; the other services keep running.\x1b[0m`);
  });
  children.push(child);
}

function stopAll() {
  if (stopping) return;
  stopping = true;
  say('stopping everything...');
  for (const c of children) {
    if (c.exitCode !== null) continue;
    try {
      if (isWin) execSync(`taskkill /pid ${c.pid} /T /F`, { stdio: 'ignore' });
      else c.kill('SIGTERM');
    } catch { /* already gone */ }
  }
  setTimeout(() => process.exit(0), 800);
}
process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

const health = (port) => new Promise((resolve) => {
  const req = http.get({ host: 'localhost', port, path: '/health', timeout: 1500 }, (res) => { res.resume(); resolve(res.statusCode < 500); });
  req.on('error', () => resolve(false));
  req.on('timeout', () => { req.destroy(); resolve(false); });
});

(async () => {
  // A port already in use usually means the services are still running in other terminals.
  const busy = [];
  for (const a of APPS) if (await health(a.port)) busy.push(`${a.name} (:${a.port})`);
  if (busy.length) {
    console.error(`Already running: ${busy.join(', ')}.\nStop those terminals first (Ctrl+C in each), then run this again.`);
    process.exit(1);
  }

  say(`starting ${APPS.length} services${withWeb ? ' + web dashboard' : ''}... (Ctrl+C stops all)`);
  for (const a of APPS) start(a);
  if (withWeb) start(WEB);

  // Report once everything answers /health (or after 60 s).
  const t0 = Date.now();
  let up = [];
  while (Date.now() - t0 < 60000 && !stopping) {
    await new Promise((r) => setTimeout(r, 1500));
    up = [];
    for (const a of APPS) if (await health(a.port)) up.push(a.name);
    if (up.length === APPS.length) break;
  }
  if (stopping) return;
  const down = APPS.filter((a) => !up.includes(a.name)).map((a) => a.name);
  console.log('');
  if (!down.length) {
    say('\x1b[32mall services are up\x1b[0m');
    say('  API gateway   http://localhost:8080/health');
    say('  SMS status    http://localhost:4002/health');
    if (withWeb) say('  Web app       see the "web |" line above for the address (usually http://localhost:5173)');
    say('  Run tests in another terminal: npm run smoke');
  } else {
    say(`\x1b[31mnot answering yet: ${down.join(', ')} - check their log lines above\x1b[0m`);
  }
  console.log('');
})();

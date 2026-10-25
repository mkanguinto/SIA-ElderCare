// Minimal headless-Chrome driver over the DevTools protocol (no dependencies, Node 22+ for the global WebSocket).
// Used by the browser tests in this folder:   node testing/browser/run.mjs
//   WEB_URL      the web app (default http://127.0.0.1:3000)
//   GATEWAY_URL  the API gateway (default http://localhost:8080), used for test setup through the API
//   CHROME_PATH  Chrome / Chromium binary (default: the macOS Google Chrome location, or google-chrome on PATH)
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const WEB = process.env.WEB_URL || 'http://127.0.0.1:3000';
export const GATEWAY = process.env.GATEWAY_URL || 'http://localhost:8080';
export const PASSWORD = process.env.DEMO_PASSWORD || 'ElderCare@2026';
const CHROME = process.env.CHROME_PATH
  || ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', '/usr/bin/google-chrome', '/usr/bin/chromium'].find((p) => fs.existsSync(p))
  || 'google-chrome';
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Calls the gateway directly (test setup / clean-up). */
export async function api(method, url, token, body) {
  const r = await fetch(GATEWAY + url, { method, headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) }, body: body ? JSON.stringify(body) : undefined });
  let j = null;
  try { j = await r.json(); } catch { /* empty body */ }
  return { s: r.status, j };
}
export const token = async (username) => (await api('POST', '/oauth/token', null, { grant_type: 'password', username, password: PASSWORD })).j.access_token;

export async function launch({ width = 390, height = 844 } = {}) {
  const port = 9400 + Math.floor(Math.random() * 400);
  const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'eldercare-chrome-'));
  const chrome = spawn(CHROME, ['--headless=new', `--remote-debugging-port=${port}`, '--disable-gpu', '--no-first-run', `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' });
  let ws;
  for (let i = 0; i < 60 && !ws; i += 1) {
    try {
      const page = (await (await fetch(`http://127.0.0.1:${port}/json`)).json()).find((t) => t.type === 'page');
      if (page) ws = new WebSocket(page.webSocketDebuggerUrl);
    } catch { /* not up yet */ }
    if (!ws) await sleep(200);
  }
  if (!ws) throw new Error(`Chrome did not start (${CHROME})`);
  await new Promise((r) => ws.addEventListener('open', r));
  let id = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
  });
  const send = (method, params = {}) => new Promise((resolve, reject) => {
    id += 1;
    pending.set(id, (m) => (m.error ? reject(new Error(`${method}: ${m.error.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await send('Page.enable');
  await send('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: width < 800 });

  const evaluate = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception ? r.exceptionDetails.exception.description : r.exceptionDetails.text);
    return r.result.value;
  };
  const page = {
    evaluate,
    async goto(p) { await send('Page.navigate', { url: WEB + p }); await sleep(600); },
    /**
     * Signs in through the web app's own /oauth proxy and stores the session the way the app does. The first-time
     * intro (caregiver / family) is marked as seen unless intro: true.
     */
    async login(username, { intro = false } = {}) {
      await page.goto('/');
      const seen = intro ? '' : "try{localStorage.setItem('eldercare.intro.'+JSON.parse(atob(d.access_token.split('.')[1].replace(/-/g,'+').replace(/_/g,'/'))).sub,'done')}catch(e){}";
      const ok = await evaluate(`fetch('/oauth/token',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({grant_type:'password',username:${JSON.stringify(username)},password:${JSON.stringify(PASSWORD)},device:'phone'})})
        .then(r=>r.json()).then(d=>{sessionStorage.clear();sessionStorage.setItem('eldercare.session',JSON.stringify({accessToken:d.access_token,refreshToken:d.refresh_token}));
          ${seen} return !!d.access_token})`);
      if (!ok) throw new Error(`login failed for ${username}`);
    },
    text: () => evaluate('document.body.innerText'),
    /** Waits until the page text contains `needle` (string) or `fn()` (JS expression) is truthy. */
    async waitFor(needle, ms = 8000) {
      const expr = typeof needle === 'string' ? `document.body.innerText.includes(${JSON.stringify(needle)})` : needle.expr;
      const t = Date.now();
      while (Date.now() - t < ms) { if (await evaluate(expr)) return true; await sleep(150); }
      return false;
    },
    /** Clicks the first visible button / link whose text includes `label` (optionally inside `within` selector). */
    async click(label, within = 'body') {
      const ok = await evaluate(`(() => { const el = [...document.querySelectorAll(${JSON.stringify(within)} + ' button, ' + ${JSON.stringify(within)} + ' a')]
        .find((b) => b.offsetParent !== null && !b.disabled && b.innerText.trim().includes(${JSON.stringify(label)})); if (el) el.click(); return !!el; })()`);
      if (!ok) throw new Error(`no clickable "${label}"`);
      await sleep(250);
    },
    /** Types into the n-th textarea / input matching `selector` (React-friendly). */
    async type(selector, value, n = 0) {
      const ok = await evaluate(`(() => { const el = document.querySelectorAll(${JSON.stringify(selector)})[${n}]; if (!el) return false;
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, ${JSON.stringify(value)}); el.dispatchEvent(new Event('input', { bubbles: true })); return true; })()`);
      if (!ok) throw new Error(`no field ${selector}[${n}]`);
    },
    /** full: the whole page, not just the viewport. */
    async screenshot(file, { full = false } = {}) {
      const size = full ? await evaluate('({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })') : null;
      const shot = await send('Page.captureScreenshot', full
        ? { format: 'png', captureBeyondViewport: true, clip: { x: 0, y: 0, width: size.w, height: size.h, scale: 1 } }
        : { format: 'png' });
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(shot.data, 'base64'));
    },
    async close() {
      try { ws.close(); } catch { /* closed */ }
      const exited = new Promise((r) => { chrome.once('exit', r); setTimeout(r, 3000); });
      chrome.kill();
      await exited;
      try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 3 }); } catch { /* temp folder, the OS cleans it */ }
    },
  };
  return page;
}

/** Tiny test harness: check(cond, message) and a summary line. */
export function harness(name) {
  let pass = 0;
  let fail = 0;
  const check = (cond, msg) => { if (cond) pass += 1; else fail += 1; console.log(`${cond ? 'PASS' : 'FAIL'} [${name}] ${msg}`); return cond; };
  return { check, result: () => ({ name, pass, fail }) };
}

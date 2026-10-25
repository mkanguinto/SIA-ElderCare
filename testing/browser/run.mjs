// Runs every *.test.mjs in this folder in headless Chrome against the running app.
//   node testing/browser/run.mjs [name-filter]        (npm run test:browser)
//   SHOTS=dir node testing/browser/run.mjs            also saves screenshots of key steps
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const dir = path.dirname(fileURLToPath(import.meta.url));
const filter = process.argv[2] || '';
const files = fs.readdirSync(dir).filter((f) => f.endsWith('.test.mjs') && f.includes(filter)).sort();
const results = [];
for (const f of files) {
  console.log(`\n-- ${f} --`);
  try {
    const mod = await import(pathToFileURL(path.join(dir, f)).href);
    results.push(await mod.default({ shots: process.env.SHOTS }));
  } catch (err) {
    console.log(`FAIL [${f}] crashed: ${err.message}`);
    results.push({ name: f, pass: 0, fail: 1 });
  }
}
const pass = results.reduce((a, r) => a + r.pass, 0);
const fail = results.reduce((a, r) => a + r.fail, 0);
console.log(`\nBrowser tests: ${pass} passed, ${fail} failed (${results.length} file${results.length === 1 ? '' : 's'})`);
process.exit(fail ? 1 : 0);

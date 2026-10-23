// ElderCare Connect - end-to-end smoke test (no dependencies, Node 18+).
// Start all six services (or docker compose up), then:   npm run smoke
// Optional: GATEWAY_URL=http://host:8080 npm run smoke
const B=process.env.GATEWAY_URL||'http://localhost:8080'; let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:fail++; console.log((c?'PASS ':'FAIL ')+m); };
const call=async(method,path,token,body)=>{const r=await fetch(B+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let j;try{j=await r.json()}catch{j=null}return {s:r.status,j};};
const login=async u=>(await call('POST','/oauth/token',null,{grant_type:'password',username:u,password:'ElderCare@2026'})).j.access_token;
const cg=await login('caregiver.maria'), fam=await login('family.jose'), nurse=await login('nurse.ana'), admin=await login('admin.harold');
ok(cg&&fam&&nurse&&admin,'4 role logins');
let r=await call('POST','/api/checkins',cg,{patientId:'P-1002',vitals:{systolic:126,diastolic:80,heartRate:72,temperatureC:36.6,spo2:97},medication:{taken:true}});
ok(r.s===201&&r.j.checkin.severity==='none','normal check-in 201, no anomaly');
r=await call('POST','/api/checkins',cg,{patientId:'P-1001',vitals:{systolic:400,diastolic:500}}); ok(r.s===422,'invalid vitals 422');
const key='offline-'+Date.now(); const a=await call('POST','/api/checkins',cg,{patientId:'P-1002',idempotencyKey:key,vitals:{heartRate:74}}); const b=await call('POST','/api/checkins',cg,{patientId:'P-1002',idempotencyKey:key,vitals:{heartRate:74}});
ok(a.s===201&&b.s===200&&b.j.duplicate&&a.j.checkin.id===b.j.checkin.id,'idempotent offline replay');
ok((await call('POST','/api/checkins',cg,{patientId:'P-1003',vitals:{heartRate:70}})).s===403,'unassigned patient 403');
ok((await call('GET','/api/clinic/queue',fam)).s===403,'family -> clinic queue 403');
ok((await call('GET','/api/patients/P-1002/history',fam)).s===403,'family -> other patient 403');
// saga
const t0=Date.now();
r=await call('POST','/api/checkins',cg,{patientId:'P-1001',vitals:{systolic:186,diastolic:118,heartRate:104,temperatureC:37.1,spo2:95},medication:{taken:false,missed:['Losartan']},notes:'headache'});
ok(r.s===201&&r.j.checkin.severity==='critical','critical check-in detected'); const cid=r.j.checkin.id;
let alert,item,tA,tC;
while(Date.now()-t0<5000&&(!alert||!item)){ if(!alert){const n=await call('GET','/api/alerts/notifications?patientId=P-1001',fam); alert=n.j.notifications.find(x=>x.metadata&&x.metadata.checkinId===cid); if(alert)tA=Date.now()-t0;}
 if(!item){const q=await call('GET','/api/clinic/queue',nurse); item=q.j.items.find(i=>i.patient.id==='P-1001'&&i.reasons.some(x=>x.checkinId===cid)); if(item)tC=Date.now()-t0;} await new Promise(r=>setTimeout(r,50)); }
ok(!!alert,`family alert raised in ${tA} ms`); ok(!!item&&['P1','P2'].includes(item.priority),`clinic queue item ${item&&item.priority} score ${item&&item.scores.total} in ${tC} ms`);
ok(Math.max(tA,tC)<2000,`end-to-end under 2.0 s objective (${Math.max(tA,tC)} ms)`);
await new Promise(r=>setTimeout(r,1500));
const n2=await call('GET','/api/alerts/notifications?patientId=P-1001',fam); const al=n2.j.notifications.find(x=>x.id===alert.id);
ok(al.delivery.filter(d=>d.channel==='sms').every(d=>['simulated','sent'].includes(d.status)),'SMS processed via BullMQ: '+al.delivery.map(d=>d.channel+':'+d.status).join(','));
r=await call('GET','/api/clinic/patients/P-1001/emr-history',nurse);
ok(r.s===200&&r.j.history.source==='legacy-emr'&&r.j.history.demographics.birthDate==='1946-03-14','legacy SOAP -> JSON via adapter, emrScore '+(r.j&&r.j.emrScore));
r=await call('PATCH','/api/clinic/queue/'+item.id,nurse,{status:'in_review',notes:'called caregiver',assignedTo:'U-CS-001'}); ok(r.s===200&&r.j.item.status==='in_review','triage status update');
ok((await call('PATCH','/api/clinic/queue/'+item.id,nurse,{status:'bogus'})).s===409,'invalid transition 409');
r=await call('POST','/api/alerts/dispatch',nurse,{patientId:'P-1001',message:'Nurse visit tomorrow 9AM'}); ok(r.s===202&&r.j.alertId,'manual dispatch 202');
ok((await call('POST','/api/alerts/dispatch',cg,{patientId:'P-1001',message:'hello there'})).s===403,'caregiver dispatch 403');
r=await call('POST','/api/alerts/weather-check',admin,{zipCode:'1012'}); ok([200,503].includes(r.s),'weather-check reachable ('+(r.s===503?'503 = OPENWEATHER_API_KEY not set':'200 = mashup ran')+')');
r=await call('GET','/api/admin/health',admin); ok(r.s===200,'admin health ('+r.j.overall+'): '+r.j.services.map(s=>s.name+'='+s.status).join(' '));
r=await call('GET','/api/patients/P-1001/history',fam); ok(r.s===200&&r.j.trends.totalCheckins>=1,'family history trends');
r=await call('GET','/api/admin/users',admin); ok(r.s===200&&r.j.users.every(u=>!u.passwordHash),'admin user list without password hashes');

// ------------------------------------------------------------------ v1.1 features
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const caseFor = async (pid) => (await call('GET', `/api/clinic/queue?patientId=${pid}`, nurse)).j.items[0];
const pollCase = async (pid, pred, ms = 4000) => { const t = Date.now(); let c; while (Date.now() - t < ms) { c = await caseFor(pid); if (c && pred(c)) return c; await wait(150); } return c; };

// Triage: a critical reading makes the case Urgent; a normal reading afterwards lowers it (QA vitals-sync bug)
await call('POST', '/api/checkins', cg, { patientId: 'P-1001', vitals: { systolic: 188, diastolic: 119, heartRate: 108 }, medication: { taken: false } });
let kase = await pollCase('P-1001', (c) => c.priority === 'P1');
ok(kase && kase.priority === 'P1' && kase.category === 'urgent', `critical reading -> Urgent (${kase && kase.priorityRule})`);
await call('POST', '/api/checkins', cg, { patientId: 'P-1001', vitals: { systolic: 124, diastolic: 80, heartRate: 72, temperatureC: 36.6, spo2: 98 }, medication: { taken: true } });
kase = await pollCase('P-1001', (c) => c.priority !== 'P1');
ok(kase && kase.priority !== 'P1' && kase.scores.health === 0 && (kase.scores.environment > 0 || kase.category === 'routine'),
  `normal reading de-escalates: ${kase && kase.priority} ${kase && kase.category} (${kase && kase.priorityRule})`);
ok(kase && kase.reasons[0].type === 'vitals_normal', 'normal check-in recorded as the latest reason');

// Visits: validation, scheduling, caregiver/family visibility, completion -> recent visits + case history
const tomorrow = new Date(Date.now() + 8 * 3600e3 + 86400e3).toISOString().slice(0, 10);
r = await call('POST', `/api/clinic/queue/${kase.id}/visits`, nurse, { visitDate: '2020-01-01', visitTime: '09:00', visitType: 'home_visit', destination: 'Home', location: 'x' });
ok(r.s === 422 && r.j.details.some((d) => d.includes('past')) && r.j.details.some((d) => d.startsWith('location')), 'visit validation rejects past date and short location (422)');
ok((await call('PATCH', `/api/clinic/queue/${kase.id}`, nurse, { status: 'scheduled' })).s === 422, 'status "scheduled" without visit details is rejected (422)');
r = await call('POST', `/api/clinic/queue/${kase.id}/visits`, nurse, { visitDate: tomorrow, visitTime: '09:30', visitType: 'home_visit', destination: "Patient's home", location: 'Tondo, Manila (near the chapel)', notes: 'Bring BP monitor' });
ok(r.s === 201 && r.j.item.status === 'scheduled' && r.j.visit.visitTime === '09:30' && r.j.visit.destination === "Patient's home", 'visit scheduled with date, time, destination, location (201)');
const visitId = r.j.visit && r.j.visit.id;
r = await call('GET', '/api/patients/P-1001/visits?view=upcoming', cg);
ok(r.s === 200 && r.j.visits.some((v) => v.id === visitId), 'caregiver sees the upcoming visit');
ok((await call('GET', '/api/patients/P-1002/visits', fam)).s === 403, 'family cannot see another patient\'s visits (403)');
r = await call('PATCH', `/api/clinic/visits/${visitId}`, nurse, { status: 'completed', outcome: 'BP 126/80 on recheck, medicines reviewed', resolveCase: true });
ok(r.s === 200 && r.j.visit.status === 'completed' && r.j.item.status === 'resolved', 'completing the visit resolves the case');
r = await call('GET', '/api/clinic/visits?view=recent&patientId=P-1001', nurse);
ok(r.s === 200 && r.j.visits[0].id === visitId, 'completed visit appears under Recent visits');
r = await call('GET', '/api/clinic/queue/history?patientId=P-1001', nurse);
ok(r.s === 200 && r.j.cases.some((c) => c.id === kase.id && c.resolutionNotes && c.visits.length), 'resolved case is in Case history with its visit');
ok(!(await caseFor('P-1001')), 'resolved case left the active queue');

// Prescribed medications
r = await call('GET', '/api/patients/P-1001/medications', cg);
ok(r.s === 200 && r.j.medications.length >= 1, `caregiver sees prescribed medicines (${r.j && r.j.medications.length})`);
ok((await call('GET', '/api/patients/P-1002/medications', fam)).s === 403, 'family cannot read another patient\'s medicines (403)');
ok((await call('POST', '/api/patients/P-1001/medications', cg, { name: 'X', dosage: '1', frequency: 'daily' })).s === 403, 'caregiver cannot prescribe (403)');

// Patient onboarding (fixed test identity: first run creates it, later runs hit the duplicate check)
const newPatient = { fullName: 'E2E Test Patient', birthDate: '1950-01-01', sex: 'F', addressLine: '1 Test St, Brgy 1, Manila', zipCode: '1000', conditions: ['hypertension'], medications: [{ name: 'Amlodipine', dosage: '5 mg', frequency: 'Once daily', times: ['08:00'] }] };
ok((await call('POST', '/api/patients', nurse, { fullName: 'X' })).s === 422, 'onboarding validation (422)');
r = await call('POST', '/api/patients', nurse, newPatient);
ok(r.s === 201 || r.s === 409, `onboarding creates a patient or detects the duplicate (${r.s} ${r.j.patient ? r.j.patient.id : r.j.patientId})`);
ok((await call('POST', '/api/patients', cg, newPatient)).s === 403, 'caregiver cannot onboard patients (403)');
r = await call('GET', '/api/directory/users?role=caregiver', nurse);
ok(r.s === 200 && r.j.users.length >= 1, 'clinic can list caregiver accounts for assignment');
r = await call('GET', '/api/alerts/subscribers?patientId=P-1001', nurse);
ok(r.s === 200 && Array.isArray(r.j.subscribers) && r.j.sms && typeof r.j.sms.live === 'boolean', `SMS contacts + mode: ${r.j.sms && r.j.sms.reason}`);

// ------------------------------------------------------------------ v2 Batch 2: API design + security
// Alert rules CRUD (admin), read by the weather mashup
r = await call('GET', '/api/alerts/rules?type=weather', nurse);
const heat = r.j && r.j.rules.find((x) => x.code === 'WEATHER_HEAT');
ok(r.s === 200 && heat && heat.trigger_condition.metric === 'heat_index_c' && heat.vulnerability_target.conditions.includes('hypertension') && heat.action.channels.includes('sms'),
  `alert rules listed with trigger_condition / vulnerability_target / action (${r.j && r.j.rules.map((x) => x.code).join(',')})`);
ok((await call('GET', '/api/alerts/rules', fam)).s === 403, 'family cannot read alert rules (403)');
const testRule = { code: 'SMOKE_TEST_HEAT', description: 'Smoke test heat rule', hazard: 'heat', enabled: false,
  trigger_condition: { metric: 'heat_index_c', operator: '>=', value: 45 }, vulnerability_target: { conditions: ['copd'] },
  action: { severity: 'high', channels: ['in_app'], create_clinic_item: false, cooldown_hours: 12 } };
await call('DELETE', `/api/alerts/rules/${testRule.code}`, admin); // leftover from an earlier run
ok((await call('POST', '/api/alerts/rules', nurse, testRule)).s === 403, 'clinic staff cannot create rules (403)');
r = await call('POST', '/api/alerts/rules', admin, testRule);
ok(r.s === 201 && r.j.code === testRule.code && r.j.action.cooldown_hours === 12 && r.j.updated_by, 'admin creates a weather rule (201)');
ok((await call('POST', '/api/alerts/rules', admin, testRule)).s === 409, 'duplicate rule code (409)');
r = await call('POST', '/api/alerts/rules', admin, { ...testRule, code: 'SMOKE_BAD', trigger_condition: { metric: 'rain', operator: '=', value: 'x' } });
ok(r.s === 422 && r.j.details.length >= 3, `invalid trigger_condition rejected (422: ${r.j.details && r.j.details[0]})`);
r = await call('PATCH', `/api/alerts/rules/${testRule.code}`, admin, { trigger_condition: { metric: 'heat_index_c', operator: '>', value: 38 } });
ok(r.s === 200 && r.j.trigger_condition.value === 38 && r.j.action.cooldown_hours === 12, 'admin updates the threshold (PATCH 200)');
ok((await call('PATCH', '/api/alerts/rules/HEALTH_ANOMALY', admin, { trigger_condition: { metric: 'wind_ms', operator: '>', value: 1 } })).s === 422, 'system rule trigger cannot be changed (422)');
ok((await call('DELETE', '/api/alerts/rules/HEALTH_ANOMALY', admin)).s === 409, 'system rule cannot be deleted (409)');
ok((await call('DELETE', `/api/alerts/rules/${testRule.code}`, admin)).s === 204 && (await call('GET', `/api/alerts/rules/${testRule.code}`, nurse)).s === 404, 'admin deletes the rule (204, then 404)');
r = await call('POST', '/api/alerts/weather-check', admin, { zipCode: '1012' });
if (r.s === 200) ok(r.j.results[0].rules.some((x) => x.code === 'WEATHER_HEAT'), `weather mashup evaluated the rules (${r.j.results[0].rules.map((x) => `${x.code}:${x.triggered}`).join(' ')})`);

// Pagination envelope on the batch history endpoints
const isPage = (p, page, size) => p && p.page === page && p.pageSize === size && typeof p.totalItems === 'number' && p.totalPages >= 1 && typeof p.hasNext === 'boolean';
const [p1, p2] = [await call('GET', '/api/patients?page=1&pageSize=2', nurse), await call('GET', '/api/patients?page=2&pageSize=2', nurse)];
ok(p1.s === 200 && p1.j.patients.length === 2 && isPage(p1.j.pagination, 1, 2) && p1.j.pagination.hasNext && p2.j.pagination.hasPrev
  && !p2.j.patients.some((x) => p1.j.patients.some((y) => y.id === x.id)), `patient list pages do not overlap (${p1.j.pagination && p1.j.pagination.totalItems} patients)`);
ok((await call('GET', '/api/patients?pageSize=0', nurse)).s === 422, 'invalid pageSize rejected (422)');
r = await call('GET', '/api/patients/P-1001/history?page=1&pageSize=3', fam);
ok(r.s === 200 && r.j.checkins.length <= 3 && isPage(r.j.pagination, 1, 3) && r.j.pagination.totalItems === r.j.trends.totalCheckins, 'check-in history is paged, trends cover the whole period');
r = await call('GET', '/api/alerts/notifications?patientId=P-1001&page=1&pageSize=2', fam);
ok(r.s === 200 && r.j.notifications.length <= 2 && isPage(r.j.pagination, 1, 2), `notifications paged (${r.j.pagination && r.j.pagination.totalItems} total)`);
r = await call('GET', '/api/clinic/queue?pageSize=1', nurse);
ok(r.s === 200 && r.j.items.length <= 1 && isPage(r.j.pagination, 1, 1) && r.j.summary, 'clinic queue paged, summary still covers the whole queue');
r = await call('GET', '/api/clinic/queue/history?page=1&pageSize=1', nurse);
ok(r.s === 200 && r.j.cases.length <= 1 && isPage(r.j.pagination, 1, 1), 'case history paged');
ok((await call('GET', '/api/patients/P-1001/history?limit=2', fam)).j.pagination.pageSize === 2, 'legacy limit= still works');

// JWT: refresh rotation + reuse detection, revocation, logout, key status
const tok = async (u) => (await call('POST', '/oauth/token', null, { grant_type: 'password', username: u, password: 'ElderCare@2026' })).j;
const refreshWith = (rt) => call('POST', '/oauth/token', null, { grant_type: 'refresh_token', refresh_token: rt });
const s1 = await tok('nurse.ana');
const s2 = (await refreshWith(s1.refresh_token)).j;
const s3 = await refreshWith(s2.refresh_token);
ok(s2.refresh_token && s2.refresh_token !== s1.refresh_token && s3.s === 200, 'refresh token rotates on every use');
r = await refreshWith(s1.refresh_token); // two rotations old: theft, not a race
ok(r.s === 400 && /already used/.test(r.j.error_description) && (await call('GET', '/api/clinic/queue', s3.j.access_token)).s === 401,
  'reused refresh token revokes the whole session');
const s4 = await tok('nurse.ana');
ok((await call('POST', '/oauth/revoke', null, { token: s4.access_token, token_type_hint: 'access_token' })).s === 200
  && (await call('GET', '/api/clinic/queue', s4.access_token)).s === 401 && (await refreshWith(s4.refresh_token)).s === 200, 'revoked access token is deny-listed (jti), session survives');
const s5 = await tok('family.jose');
ok((await call('POST', '/oauth/logout', s5.access_token)).s === 204 && (await call('GET', '/api/alerts/notifications', s5.access_token)).s === 401
  && (await refreshWith(s5.refresh_token)).s === 400, 'logout ends the session (access + refresh)');
r = await call('GET', '/api/admin/security', admin);
ok(r.s === 200 && r.j.jwt.access.activeKid && r.j.jwt.store.persistent === true, `key status: kid ${r.j.jwt && r.j.jwt.access.activeKid}, next rotation ${r.j.jwt && r.j.jwt.rotation.nextRotationDue}`);

// ------------------------------------------------------------------ v2 Batch 3: Node-RED EAI layer
// Needs the same TEXTBEE_WEBHOOK_SECRET as the gateway; DASHBOARD_* + NODE_RED_URL for the dashboard checks.
const tbSecret = process.env.TEXTBEE_WEBHOOK_SECRET;
if (!tbSecret) {
  console.log('SKIP Batch 3 SMS router checks (set TEXTBEE_WEBHOOK_SECRET to the gateway\'s value)');
} else {
  const { createHmac } = await import('node:crypto');
  const textbee = async (payload, { sign = true } = {}) => {
    const raw = JSON.stringify(payload);
    const sig = createHmac('sha256', tbSecret).update(raw).digest('hex');
    const res = await fetch(`${B}/webhooks/textbee`, { method: 'POST', headers: { 'content-type': 'application/json', ...(sign ? { 'x-signature': sig } : {}) }, body: raw });
    return { s: res.status, j: await res.json().catch(() => null) };
  };
  const inbound = (sender, message, smsId = `smoke${Date.now()}${Math.floor(Math.random() * 1e6)}`) => textbee({ webhookEvent: 'MESSAGE_RECEIVED', sender, message, smsId });
  const until = async (fn, ms = 4000) => { const t = Date.now(); let v; while (Date.now() - t < ms) { v = await fn(); if (v) return v; await wait(150); } return v; };
  const CAREGIVER = '+639175550102'; const FAMILY = '+639175550101';

  ok((await textbee({ webhookEvent: 'MESSAGE_RECEIVED', sender: CAREGIVER, message: 'SOS' }, { sign: false })).s === 401, 'unsigned TextBee webhook rejected at the gateway (401)');
  r = await inbound(CAREGIVER, 'HELP');
  ok(r.s === 200 && r.j.route === 'help', 'Node-RED acknowledges TextBee and routes HELP');

  const before = (await call('GET', '/api/patients/P-1002/history?days=1', nurse)).j.trends.totalCheckins;
  const smsId = `smoke${Date.now()}`;
  r = await inbound(CAREGIVER, 'CHECKIN P-1002 BP 128/82 HR 74 T 36.7 O2 97 MED Y', smsId);
  const after = await until(async () => { const n = (await call('GET', '/api/patients/P-1002/history?days=1', nurse)).j.trends.totalCheckins; return n > before ? n : 0; });
  ok(r.j && r.j.route === 'checkin' && after === before + 1, `SMS check-in routed to the check-in service (${before} -> ${after})`);
  await inbound(CAREGIVER, 'CHECKIN P-1002 BP 128/82 HR 74 T 36.7 O2 97 MED Y', smsId); // TextBee retry
  await wait(1500);
  ok((await call('GET', '/api/patients/P-1002/history?days=1', nurse)).j.trends.totalCheckins === after, 'redelivered SMS (same smsId) is not saved twice');

  r = await inbound(CAREGIVER, 'SOS nahulog si lola sa banyo');
  const sos = await until(async () => (await call('GET', '/api/alerts/notifications?patientId=P-1001&pageSize=5', fam)).j.notifications.find((n) => n.rule === 'SMS_SOS' && Date.now() - new Date(n.createdAt) < 60000));
  ok(r.j && r.j.route === 'emergency' && sos && sos.severity === 'critical' && !sos.delivery.some((d) => d.note && d.note.includes(CAREGIVER)), 'SOS -> critical family alert');

  const familySms = async () => (await call('GET', '/api/alerts/subscribers?patientId=P-1001', nurse)).j.subscribers.find((x) => x.phone === FAMILY).smsEnabled;
  await inbound(FAMILY, 'STOP');
  const off = await until(async () => (await familySms()) === false);
  await inbound(FAMILY, 'START');
  const on = await until(async () => (await familySms()) === true);
  ok(off && on, 'STOP turns SMS alerts off, START turns them back on');
  ok((await textbee({ webhookEvent: 'MESSAGE_DELIVERED', smsId: 'smoke-receipt-1' })).j.route === 'delivery_status', 'delivery receipt routed to status updates');

  const nr = process.env.NODE_RED_URL; const du = process.env.DASHBOARD_USER || 'ops'; const dp = process.env.DASHBOARD_PASSWORD;
  if (nr && dp) {
    const auth = { authorization: `Basic ${Buffer.from(`${du}:${dp}`).toString('base64')}` };
    ok((await fetch(`${nr}/dlq`)).status === 401, 'DLQ dashboard requires sign-in');
    const page = await fetch(`${nr}/dlq`, { headers: auth });
    ok(page.status === 200 && (await page.text()).includes('ElderCare DLQ monitor'), 'DLQ dashboard page served');
    const st = await until(async () => { const j = await (await fetch(`${nr}/dlq/api/status`, { headers: auth })).json(); return j.messaging && j.sms && j.sms.routes.checkin ? j : null; }, 20000);
    ok(st && st.messaging.services.length === 3 && st.messaging.services.every((x) => x.reachable), `DLQ monitor sees all services (${st && st.messaging.totalDeadLetters} dead letters)`);
    const rp = await fetch(`${nr}/dlq/api/replay`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify({ service: 'alert', queue: 'alert-service.sms-dispatch.dlq', limit: 5 }) });
    ok(rp.status === 200 && typeof (await rp.json()).replayed === 'number', 'replay button moves DLQ messages back (200)');
    await fetch(`${nr}/dlq/api/weather-run`, { method: 'POST', headers: auth });
    const wr = await until(async () => { const j = await (await fetch(`${nr}/dlq/api/status`, { headers: auth })).json(); return j.weather && Date.now() - new Date(j.weather.ranAt) < 60000 ? j.weather : null; }, 30000);
    ok(wr && ['ok', 'not_configured'].includes(wr.status), `weather orchestration run: ${wr && wr.status}, ${wr && wr.locations} locations, rules fired: ${wr && (wr.rulesFired.join(',') || 'none')}`);
  } else {
    console.log('SKIP dashboard checks (set NODE_RED_URL and DASHBOARD_PASSWORD)');
  }
  r = await call('GET', '/api/admin/health', admin);
  ok(r.j.services.some((x) => x.name === 'nodeRed' && x.status === 'up'), 'admin health includes Node-RED');
}

// ------------------------------------------------------------------ v2 Batch 4: care-plan service (caregiver duties)
r = await call('GET', '/api/care/categories', fam);
ok(r.s === 200 && r.j.categories.length === 8 && r.j.categories.every((c) => c.suggestions.length), `duty categories: ${r.j && r.j.categories.map((c) => c.code).join(', ')}`);
r = await call('GET', '/api/patients/P-1001/care-plan', cg);
ok(r.s === 200 && r.j.plan && r.j.tasks.length >= 5 && r.j.byCategory.length === 8, `caregiver reads the care plan (${r.j && r.j.tasks.length} tasks)`);
ok((await call('GET', '/api/patients/P-1002/care-plan', fam)).s === 403, 'family cannot read another patient\'s care plan (403)');
let checklist = (await call('GET', '/api/patients/P-1001/care-plan/checklist', cg)).j;
const meds = checklist.items.find((i) => i.title === 'Give morning medicines');
ok(meds && checklist.summary.total >= 5 && checklist.asNeeded.length >= 2, `today's checklist: ${JSON.stringify(checklist.summary)}`);
r = await call('POST', `/api/care/tasks/${meds.taskId}/completions`, cg, { slot: '08:00', status: 'done', note: 'after breakfast' });
const second = await call('POST', `/api/care/tasks/${meds.taskId}/completions`, cg, { slot: '08:00', status: 'done' });
ok([200, 201].includes(r.s) && second.s === 200 && second.j.id === r.j.id, 'ticking a duty twice updates it instead of duplicating');
checklist = (await call('GET', '/api/patients/P-1001/care-plan/checklist', cg)).j;
ok(checklist.items.find((i) => i.taskId === meds.taskId && i.slot === '08:00').status === 'done', 'checklist shows the duty as done');
ok((await call('POST', `/api/care/tasks/${meds.taskId}/completions`, cg, { slot: '08:00', status: 'skipped' })).s === 422, 'skipping needs a reason (422)');
ok((await call('POST', `/api/care/tasks/${meds.taskId}/completions`, cg, { slot: '09:15' })).s === 422, 'unscheduled slot rejected (422)');
ok((await call('POST', `/api/care/tasks/${meds.taskId}/completions`, cg, { date: '2099-01-01' })).s === 422, 'future date rejected (422)');
ok((await call('POST', `/api/care/tasks/${meds.taskId}/completions`, fam, {})).s === 403, 'family cannot tick off duties (403)');
const prn = checklist.asNeeded[0];
const l1 = await call('POST', `/api/care/tasks/${prn.taskId}/completions`, cg, { note: 'logged by smoke test' });
const l2 = await call('POST', `/api/care/tasks/${prn.taskId}/completions`, cg, {});
ok(l1.s === 201 && l2.s === 201 && l1.j.id !== l2.j.id, 'as-needed duty can be logged several times a day');
const newTask = { category: 'emotional_social', title: 'Smoke test: read the newspaper together', frequency: 'daily', times: ['15:00'] };
ok((await call('POST', '/api/patients/P-1001/care-plan/tasks', cg, newTask)).s === 403, 'caregiver cannot change the plan (403)');
ok((await call('POST', '/api/patients/P-1001/care-plan/tasks', nurse, { ...newTask, frequency: 'weekly' })).s === 422, 'weekly task without days rejected (422)');
r = await call('POST', '/api/patients/P-1001/care-plan/tasks', nurse, newTask);
const addedId = r.j && r.j.id;
ok(r.s === 201 && r.j.category === 'emotional_social', 'clinic staff add a duty (201)');
r = await call('PATCH', `/api/care/tasks/${addedId}`, nurse, { times: ['15:00', '19:00'] });
ok(r.s === 200 && r.j.times.length === 2, 'clinic staff change a duty (PATCH 200)');
ok((await call('DELETE', `/api/care/tasks/${addedId}`, nurse)).s === 204 && (await call('POST', `/api/care/tasks/${addedId}/completions`, cg, { slot: '15:00' })).s === 409, 'retired duty can no longer be ticked off (409)');
r = await call('GET', '/api/patients/P-1001/care-plan/history?page=1&pageSize=5', fam);
ok(r.s === 200 && typeof r.j.adherence.scheduled === 'number' && r.j.adherence.categories.length && r.j.pagination.pageSize === 5 && r.j.completions.length >= 1,
  `family sees adherence: ${r.j.adherence && r.j.adherence.rate}% of ${r.j.adherence && r.j.adherence.scheduled} scheduled duties this week`);
ok((await call('GET', '/api/admin/health', admin)).j.services.some((x) => x.name === 'care' && x.status === 'up'), 'admin health includes the care-plan service');

// ---- Batch 5.1: check-in monitoring status (Received -> Awaiting review -> Reviewed -> Action recorded) ----
console.log('\n-- Check-in status flow --');
r = await call('POST', '/api/checkins', cg, { patientId: 'P-1001', vitals: { systolic: 150, diastolic: 94 }, measurementDevice: { bp: 'wrist_digital' } });
const statusId = r.j && r.j.checkin && r.j.checkin.id;
ok(r.s === 201 && r.j.checkin.status === 'received' && r.j.checkin.measurementDevice.bp === 'wrist_digital', 'check-in saved as received with its measuring device');
let st = null;
for (let i = 0; i < 10; i++) {
  st = (await call('GET', `/api/checkins/${statusId}`, cg)).j;
  if (st && st.checkin && st.checkin.status === 'awaiting_review') break;
  await new Promise((res) => setTimeout(res, 500));
}
ok(st && st.checkin.status === 'awaiting_review' && st.statusLog.length === 2, 'moves to awaiting review once delivered to the clinic queue');
r = await call('GET', '/api/checkins/review-queue?pageSize=200', nurse);
ok(r.s === 200 && r.j.checkins.some((c) => c.id === statusId), 'nurse review queue lists it');
ok((await call('POST', `/api/checkins/${statusId}/review`, cg, {})).s === 403, 'caregiver cannot review (403)');
r = await call('POST', `/api/checkins/${statusId}/review`, nurse, { note: 'smoke test review' });
ok(r.s === 200 && r.j.checkin.status === 'reviewed' && r.j.checkin.review.byId === 'U-CS-001', 'nurse marks it reviewed');
ok((await call('POST', `/api/checkins/${statusId}/review`, nurse, {})).s === 409, 'cannot be reviewed twice (409)');
ok((await call('POST', `/api/checkins/${statusId}/action`, nurse, {})).s === 422, 'an action needs text (422)');
r = await call('POST', `/api/checkins/${statusId}/action`, nurse, { action: 'Smoke test: advised an upper-arm cuff' });
ok(r.s === 200 && r.j.checkin.status === 'action_recorded', 'nurse records the action');
r = await call('GET', `/api/checkins/${statusId}`, fam);
ok(r.s === 200 && r.j.statusLog.map((l) => l.status).join('>') === 'received>awaiting_review>reviewed>action_recorded', 'family sees the full timestamped timeline');
ok((await call('POST', `/api/checkins/${statusId}/review`, nurse, {})).s === 409, 'a reviewed check-in cannot be reviewed again (409, status history is immutable)');

// Missing readings are a reason, never zero
r = await call('POST', '/api/checkins', cg, { patientId: 'P-1002', vitals: { heartRate: 76 }, vitalsMissing: { bp: 'no_device', spo2: 'not_measured', bloodGlucose: 'unknown' } });
ok(r.s === 201 && r.j.checkin.vitalsMissing.bp === 'no_device' && r.j.checkin.vitals.systolic === null, 'check-in stores "no device / not measured / unknown" instead of a value');
r = await call('POST', '/api/checkins', cg, { patientId: 'P-1002', vitals: { spo2: 0 } });
ok(r.s === 422 && r.j.details.some((d) => d.includes('cannot be 0')), 'a zero reading is rejected (422)');
r = await call('POST', '/api/checkins', cg, { patientId: 'P-1002', vitals: { systolic: 130, diastolic: 82 }, vitalsMissing: { bp: 'unknown' } });
ok(r.s === 422, 'a value together with a missing reason is rejected (422)');

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);

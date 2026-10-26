import fs from 'node:fs';
// ElderCare Connect - end-to-end smoke test (no dependencies, Node 18+).
// Start all six services (or docker compose up), then:   npm run smoke
// Optional: GATEWAY_URL=http://host:8080 npm run smoke
const B=process.env.GATEWAY_URL||'http://localhost:8080'; let pass=0, fail=0;
const ok=(c,m)=>{ c?pass++:fail++; console.log((c?'PASS ':'FAIL ')+m); };
// Check-ins created by this test are demo data (archived at the end, never mixed with real records).
const call=async(method,path,token,body)=>{if(method==='POST'&&path==='/api/checkins'&&body&&!body.dataOrigin)body={...body,dataOrigin:'demo'};const r=await fetch(B+path,{method,headers:{'content-type':'application/json',...(token?{authorization:'Bearer '+token}:{})},body:body?JSON.stringify(body):undefined});let j;try{j=await r.json()}catch{j=null}return {s:r.status,j};};
const login=async u=>(await call('POST','/oauth/token',null,{grant_type:'password',username:u,password:'ElderCare@2026'})).j.access_token;
// One session per user (Batch 3a): signing in again ends the earlier session, so sections that test sign-in
// use separate devices (nurses: phone + desktop) or sign the shared users in again afterwards.
let cg=await login('caregiver.maria'), fam=await login('family.jose'), nurse=await login('nurse.ana'), admin=await login('admin.harold');
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
r=await call('POST','/api/alerts/weather-check',nurse,{zipCode:'1012'}); ok([200,503].includes(r.s),'weather-check reachable ('+(r.s===503?'503 = OPENWEATHER_API_KEY not set':r.s===200?'200 = mashup ran':`${r.s}: ${r.j&&(r.j.message||r.j.error)}`)+')');
ok((await call('POST','/api/alerts/weather-check',admin,{zipCode:'1012'})).s===403,'admin cannot run the clinical weather check (403)');
r=await call('GET','/api/admin/health',admin); ok(r.s===200,'admin health ('+r.j.overall+'): '+r.j.services.map(s=>s.name+'='+s.status).join(' '));
r=await call('GET','/api/patients/P-1001/history',fam); ok(r.s===200&&r.j.trends.totalCheckins>=1,'family history trends');
r=await call('GET','/api/admin/users',admin); ok(r.s===200&&r.j.users.every(u=>!u.passwordHash),'admin user list without password hashes');

// ------------------------------------------------------------------ v1.1 features
const wait = (ms) => new Promise((res) => setTimeout(res, ms));
const caseFor = async (pid) => (await call('GET', `/api/clinic/queue?patientId=${pid}`, nurse)).j.items[0];
const pollCase = async (pid, pred, ms = 4000) => { const t = Date.now(); let c; while (Date.now() - t < ms) { c = await caseFor(pid); if (c && pred(c)) return c; await wait(150); } return c; };

// Triage: a critical reading makes the case Urgent; a normal reading afterwards lowers it (QA vitals-sync bug)
const urgentCheckin = (await call('POST', '/api/checkins', cg, { patientId: 'P-1001', vitals: { systolic: 188, diastolic: 119, heartRate: 108 }, medication: { taken: false } })).j.checkin;
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
r = await call('GET', '/api/patients/P-1001/case', fam);
ok(r.s === 200 && r.j.case && r.j.case.closed && r.j.case.visitCompletedAt && r.j.case.closedAt, 'the family sees the case closed after the visit (Followed up)');
ok((await call('GET', '/api/patients/P-1001/case', cg)).s === 200 && (await call('GET', '/api/patients/P-1002/case', fam)).s === 403, "caregiver sees the case; family cannot see another elder's case (403)");
r = await call('GET', `/api/checkins/${urgentCheckin.id}`, nurse);
ok(r.s === 200 && !r.j.checkin.review && ['received', 'awaiting_review'].includes(r.j.checkin.status), 'resolving the case does not mark its check-in reviewed (reviewed and resolved stay separate)');
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

// Patient registration by the admin (fixed test identity: first run creates it, later runs hit the duplicate
// check); the nurse then records the clinical part (conditions, mobility).
const newPatient = { fullName: 'E2E Test Patient', birthDate: '1950-01-01', sex: 'F', addressLine: '1 Test St, Brgy 1, Manila', zipCode: '1000' };
ok((await call('POST', '/api/patients', admin, { fullName: 'X' })).s === 422, 'registration validation (422)');
ok((await call('POST', '/api/patients', admin, { ...newPatient, conditions: ['hypertension'] })).s === 422, 'the admin cannot record health conditions at registration (422)');
r = await call('POST', '/api/patients', admin, newPatient);
ok(r.s === 201 || r.s === 409, `the admin registers a patient or the duplicate is detected (${r.s} ${r.j.patient ? r.j.patient.id : r.j.patientId})`);
const e2ePid = r.j.patient ? r.j.patient.id : r.j.patientId;
ok((await call('POST', '/api/patients', await login('nurse.ben'), newPatient)).s === 403, 'a nurse who is not a team lead cannot register patients (403)');
ok((await call('POST', '/api/patients', cg, newPatient)).s === 403, 'caregiver cannot register patients (403)');
r = await call('PATCH', `/api/patients/${e2ePid}/health`, nurse, { conditions: ['hypertension', 'Heart disease'], mobilityRestricted: true });
ok(r.s === 200 && r.j.patient.conditions.includes('heart_disease') && r.j.patient.mobilityRestricted === true, 'the nurse records conditions and limited mobility');
ok((await call('PATCH', `/api/patients/${e2ePid}/health`, admin, { conditions: [] })).s === 403, 'the admin cannot change health conditions (403)');
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
// The nurse signs in on her phone here, so the desktop session used by the rest of the test stays open.
const tok = async (u, device = 'phone') => (await call('POST', '/oauth/token', null, { grant_type: 'password', username: u, password: 'ElderCare@2026', device })).j;
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
fam = await login('family.jose'); // s5 replaced the shared family session
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
const addedToDraft = Boolean(r.j && r.j.draft);
ok(r.s === 201 && r.j.category === 'emotional_social', 'clinic staff add a duty (201)');
r = await call('PATCH', `/api/care/tasks/${addedId}`, nurse, { times: ['15:00', '19:00'] });
ok(r.s === 200 && r.j.times.length === 2, 'clinic staff change a duty (PATCH 200)');
ok(addedToDraft, 'a new duty goes into a draft of the plan, not the plan in use');
ok((await call('DELETE', `/api/care/tasks/${addedId}`, nurse)).s === 204 && (await call('POST', `/api/care/tasks/${addedId}/completions`, cg, { slot: '15:00' })).s === 409, 'a draft duty cannot be ticked off (409)');
{ // leave the demo plan as it was: drop the draft this test started
  const d = (await call('GET', '/api/patients/P-1001/care-plan', nurse)).j.draft;
  ok(d && (await call('POST', `/api/care-plan/versions/${d.id}/discard`, nurse, { reason: 'Smoke test draft' })).s === 200, 'the smoke test draft is discarded (kept in the history)');
}
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
ok((await call('POST', `/api/checkins/${statusId}/review`, admin, {})).s === 403, 'admin cannot review check-ins (403, nurses only)');
r = await call('GET', `/api/checkins/${statusId}`, nurse);
ok(r.j.checkin.review.byId && r.j.checkin.review.at && r.j.checkin.dataOrigin === 'demo', 'review keeps the nurse id and time; test check-ins are marked demo');

// Pending lists: current, historical (older, still pending - never auto-reviewed), archived demo records
r = await call('GET', '/api/checkins/review-queue?view=historical', nurse);
ok(r.s === 200 && r.j.checkins.every((c) => !c.archived && ['received', 'awaiting_review'].includes(c.status)) && typeof r.j.counts.historical === 'number', `historical review list (${r.j.counts.current} current, ${r.j.counts.historical} historical, ${r.j.counts.archived} archived)`);
ok((await call('GET', '/api/checkins/review-queue?view=old', nurse)).s === 422, 'unknown list view rejected (422)');
ok((await call('POST', '/api/checkins', cg, { patientId: 'P-1002', vitals: { heartRate: 70 }, dataOrigin: 'test' })).s === 422, 'unknown dataOrigin rejected (422)');
ok((await call('POST', '/api/checkins/archive-demo', cg, {})).s === 403, 'caregiver cannot archive (403)');

// Missing readings are a reason, never zero
r = await call('POST', '/api/checkins', cg, { patientId: 'P-1002', vitals: { heartRate: 76 }, vitalsMissing: { bp: 'no_device', spo2: 'not_measured', bloodGlucose: 'unknown' } });
ok(r.s === 201 && r.j.checkin.vitalsMissing.bp === 'no_device' && r.j.checkin.vitals.systolic === null, 'check-in stores "no device / not measured / unknown" instead of a value');
r = await call('POST', '/api/checkins', cg, { patientId: 'P-1002', vitals: { spo2: 0 } });
ok(r.s === 422 && r.j.details.some((d) => d.includes('cannot be 0')), 'a zero reading is rejected (422)');
r = await call('POST', '/api/checkins', cg, { patientId: 'P-1002', vitals: { systolic: 130, diastolic: 82 }, vitalsMissing: { bp: 'unknown' } });
ok(r.s === 422, 'a value together with a missing reason is rejected (422)');

// ---- Batch 2: care team + nurse handover (the case moves only when the incoming nurse accepts) ----
console.log('\n-- Care team and handover --');
const ben = await login('nurse.ben'), carla = await login('nurse.carla');
const caseIds = async (t) => (await call('GET', '/api/clinic/my-cases', t)).j.cases.map((c) => c.patient.id);
// Start from a known state: whoever holds P-1001's case hands it to Ana (needed when the test is run again).
let care = (await call('GET', '/api/clinic/patients/P-1001/care', nurse)).j;
ok(care.careTeam && care.members.length >= 2 && care.monitoringPlan, `P-1001 belongs to a care team (${care.careTeam && care.careTeam.name}, ${care.members.length} nurses, plan ${care.monitoringPlan && care.monitoringPlan.id})`);
const due = new Date(Date.now() + 2 * 3600000).toISOString();
const hand = (from, to, extra = {}) => call('POST', '/api/clinic/handover', from, { patientId: 'P-1001', toNurseId: to, concern: 'BP 168/100 this morning, dizzy on standing', actionTaken: 'Called the caregiver, advised rest and fluids', pendingAction: 'Recheck BP at 6 PM and call the caregiver back', dueTime: due, ...extra });
for (const h of (await call('GET', '/api/clinic/queue/pending-handovers', nurse)).j.outgoing) await call('POST', `/api/clinic/handover/${h.id}/cancel`, nurse, {});
for (const h of (await call('GET', '/api/clinic/queue/pending-handovers', ben)).j.outgoing) await call('POST', `/api/clinic/handover/${h.id}/cancel`, ben, {});
if (care.caseNurse.id === 'U-CS-002') { const back = (await hand(ben, 'U-CS-001')).j.handover; await call('POST', `/api/clinic/handover/${back.id}/accept`, nurse, {}); }
ok((await caseIds(nurse)).includes('P-1001'), 'Ana holds the P-1001 case');
await call('POST', '/api/checkins', cg, { patientId: 'P-1001', vitals: { systolic: 172, diastolic: 104, heartRate: 96 } });
const openCase = await pollCase('P-1001', (c) => Boolean(c));
ok(openCase && openCase.assignedTo === 'U-CS-001', 'a new clinic case is assigned to the elder\'s case nurse (Ana)');

ok((await hand(ben, 'U-CS-001')).s === 403, 'a nurse who does not hold the case cannot hand it over (403)');
ok((await hand(nurse, 'U-CS-003')).s === 422, 'the incoming nurse must be on the care team (422)');
ok((await hand(nurse, 'U-CS-002', { pendingAction: '' })).s === 422, 'pending action is required (422)');
ok((await hand(cg, 'U-CS-002')).s === 403, 'caregiver cannot submit a handover (403)');
r = await hand(nurse, 'U-CS-002');
const hid = r.j && r.j.handover && r.j.handover.id;
ok(r.s === 201 && r.j.handover.status === 'pending', 'Ana submits the handover to Ben (201, pending)');
ok((await hand(nurse, 'U-CS-002')).s === 409, 'only one pending handover per elder (409)');
ok((await caseIds(nurse)).includes('P-1001') && !(await caseIds(ben)).includes('P-1001'), 'while pending, the case stays with Ana (not yet in Ben\'s cases)');
r = await call('GET', '/api/clinic/queue/pending-handovers', ben);
ok(r.s === 200 && r.j.incoming.some((h) => h.id === hid && h.pendingAction && h.dueTime), "Ben sees it under Pending handover with concern, action, pending action and due time");
ok((await call('GET', '/api/clinic/queue?patientId=P-1001', nurse)).j.items[0].handoverStatus === 'pending', 'queue item shows handover_status = pending');
ok((await call('POST', `/api/clinic/handover/${hid}/accept`, nurse, {})).s === 403, 'the outgoing nurse cannot accept her own handover (403)');
ok((await call('POST', `/api/clinic/handover/${hid}/accept`, carla, {})).s === 403, 'another nurse cannot accept it (403)');
r = await call('POST', `/api/clinic/handover/${hid}/accept`, ben, {});
ok(r.s === 200 && r.j.handover.status === 'accepted' && r.j.caseNurse.id === 'U-CS-002', 'Ben accepts (200)');
ok((await caseIds(ben)).includes('P-1001') && !(await caseIds(nurse)).includes('P-1001'), 'after acceptance the case is in Ben\'s My cases, not Ana\'s');
const qi = (await call('GET', '/api/clinic/queue?patientId=P-1001', nurse)).j.items[0];
ok(qi.id === openCase.id && qi.assignedTo === 'U-CS-002' && qi.handoverStatus === 'accepted', 'the open queue item follows the case to Ben (handover_status = accepted)');
ok((await call('POST', `/api/clinic/handover/${hid}/accept`, ben, {})).s === 409, 'a handover is answered once (409)');
care = (await call('GET', '/api/clinic/patients/P-1001/care', ben)).j;
const link = care.handovers.find((h) => h.id === hid);
ok(link && link.fromNurse.id === 'U-CS-001' && link.toNurse.id === 'U-CS-002' && link.respondedAt, 'handover chain logged: from, to, acceptance time');
ok((await call('PATCH', `/api/clinic/queue/${qi.id}`, nurse, { assignedTo: 'U-CS-001' })).s === 409, '"Assign to me" cannot take a case another nurse holds (409, handover required)');
ok((await call('GET', '/api/patients/P-1001', cg)).s === 200 && (await call('GET', '/api/patients/P-1001', fam)).s === 200, 'caregiver and family keep access after the nurse change');

// Decline keeps the case where it is; the chain shows it
r = await hand(ben, 'U-CS-001');
ok((await call('POST', `/api/clinic/handover/${r.j.handover.id}/decline`, nurse, {})).s === 422, 'declining needs a reason (422)');
ok((await call('POST', `/api/clinic/handover/${r.j.handover.id}/decline`, nurse, { note: 'Off duty from 2 PM, ask Carla' })).s === 200 && (await caseIds(ben)).includes('P-1001'), 'declined handover leaves the case with Ben');
// Hand it back so the demo starts from Ana again
r = await hand(ben, 'U-CS-001');
await call('POST', `/api/clinic/handover/${r.j.handover.id}/accept`, nurse, {});
ok((await caseIds(nurse)).includes('P-1001'), 'handed back to Ana');

// Duty coverage is separate from sessions
r = await call('PUT', '/api/clinic/duty/me', nurse, { onDuty: false });
ok(r.s === 200 && r.j.onDuty === false && r.j.cases >= 1 && r.j.warning, 'going off duty keeps the cases and warns (no automatic handover)');
await call('PUT', '/api/clinic/duty/me', nurse, { onDuty: true });
ok((await caseIds(nurse)).includes('P-1001'), 'duty change did not move the case');

// Admin: care teams without clinical content
r = await call('GET', '/api/clinic/care-teams', admin);
ok(r.s === 200 && r.j.teams.length >= 2 && r.j.monitoringPlans.length >= 3 && !JSON.stringify(r.j).includes('dizzy'), 'admin sees teams, elders and plans, without clinical notes');
ok((await call('GET', '/api/clinic/patients/P-1001/care', admin)).s === 403, 'admin cannot read the handover chain (clinical, 403)');
ok((await call('POST', '/api/clinic/handover', admin, {})).s === 403, 'admin cannot submit handovers (403)');
ok((await call('PUT', '/api/clinic/patients/P-1001/care', admin, { careTeamId: 'CT-MNL-A', caseNurseId: 'U-CS-002' })).s === 409, 'admin cannot move a held case (409, handover required)');
const teamId = 'CT-TEST-SMOKE'; // fixed id: created on the first run, reused afterwards
r = await call('POST', '/api/clinic/care-teams', admin, { id: teamId, name: 'Test team (smoke test)', clinicId: 'RHU-MNL-01' });
ok(r.s === 201 || r.s === 409, `admin creates a care team (${r.s === 201 ? 'created' : 'already there: 409'})`);
ok((await call('POST', `/api/clinic/care-teams/${teamId}/members`, admin, { nurseId: 'U-CS-003', nurseName: 'Carla Mendoza, RN' })).s === 201, 'admin adds a nurse to it');
ok((await call('DELETE', `/api/clinic/care-teams/CT-MNL-A/members/U-CS-001`, admin)).s === 409, 'a nurse holding cases cannot be removed from the team (409)');
ok((await call('DELETE', `/api/clinic/care-teams/${teamId}/members/U-CS-003`, admin)).s === 200, 'a nurse without cases can be removed');
r = await call('GET', '/api/clinic/care-log?limit=50', admin);
ok(r.s === 200 && r.j.entries.some((e) => e.action === 'handover_accepted' && e.details.handoverId === hid) && r.j.entries.some((e) => e.action === 'member_added'), 'assignment log records handovers and team changes with who and when');
ok((await call('GET', '/api/clinic/care-log', ben)).s === 403, 'a nurse who is not a team lead cannot read the assignment log (403)');

// ---- Batch 3a: accounts, sessions, admin limits ----
console.log('\n-- Accounts and sessions --');
const internalToken = process.env.INTERNAL_SERVICE_TOKEN || (() => {
  try { return (fs.readFileSync(new URL('../.env', import.meta.url), 'utf8').match(/^INTERNAL_SERVICE_TOKEN=(.*)$/m) || [])[1]; } catch { return undefined; }
})();
const capturedSms = async (to, purpose) => {
  const res = await fetch(`${B}/internal/test/account-sms?to=${encodeURIComponent(to)}&purpose=${purpose}`, { headers: { 'x-internal-token': internalToken || '' } });
  return res.status === 200 ? res.json() : null;
};
const uname = `caregiver.smoke${Date.now().toString(36)}`;
const phone = `0917${String(Date.now()).slice(-7)}`;
r = await call('POST', '/api/admin/accounts', admin, { username: uname, name: 'Smoke Test Caregiver', role: 'caregiver', phone, patients: ['P-1003'] });
ok(r.s === 201 && r.j.account.status === 'pending_activation' && r.j.activation.sentTo && !/[A-Z0-9]{4}-[A-Z0-9]{4}/.test(JSON.stringify(r.j)), `admin creates a caregiver account; activation code sent to ${r.j && r.j.activation && r.j.activation.sentTo} (${r.j && r.j.activation && r.j.activation.delivery}), not shown to the admin`);
const newId = r.j.account && r.j.account.id;
ok(r.j.activation && r.j.activation.delivery !== 'delivered' && (r.j.activation.delivery !== 'simulated' || /NOT|ALLOWLIST|DRY_RUN|not/i.test(r.j.activation.note || '')),
  `a number off the allow-list is reported as ${r.j.activation && r.j.activation.delivery} (${r.j.activation && r.j.activation.note}), never as delivered`);
r = await call('GET', '/api/admin/sms-check', admin);
ok(r.s === 200 && typeof r.j.ready === 'boolean' && Array.isArray(r.j.problems) && (r.j.mode.live || !r.j.ready),
  `SMS check: ${r.j.ready ? 'ready' : `not ready (${(r.j.problems || []).join('; ')})`}, ${r.j.mode && r.j.mode.reason}`);
{
  const tag = Date.now().toString(36);
  const nurseRes = await call('POST', '/api/admin/accounts', admin, { username: `nurse.smoke${tag}`, name: `Smoke Nurse ${tag}`, role: 'clinic_staff', phone: `0918${String(Date.now()).slice(-7)}` });
  const sid = nurseRes.j.account && nurseRes.j.account.staffId;
  const adm = await call('POST', '/api/admin/accounts', admin, { username: `admin.smoke${tag}`, name: `Smoke Nurse ${tag}`, role: 'system_admin', phone: `0918${String(Date.now()).slice(-7)}`, staffId: sid });
  const trail = await call('GET', `/api/admin/audit?staffId=${sid}&action=account_created`, admin);
  ok(nurseRes.s === 201 && adm.s === 201 && adm.j.account.staffId === sid && adm.j.account.id !== nurseRes.j.account.id
    && trail.j.entries.length === 2 && trail.j.entries.every((e) => e.targetStaffId === sid),
    `admin who is also a nurse: two separate accounts (${nurseRes.j.account && nurseRes.j.account.id}, ${adm.j.account && adm.j.account.id}) under staff ${sid}, linked in the audit log`);
}
r = await call('POST', '/oauth/token', null, { grant_type: 'password', username: uname, password: 'whatever-1' });
ok(r.s === 400 && r.j.reason === 'account_pending', 'cannot sign in before activation');
const sms = await capturedSms(phone, 'activation');
if (sms) {
  const code = sms.body.match(/code is ([A-Z0-9]{4}-[A-Z0-9]{4})/)[1];
  ok((await call('POST', '/auth/activate', null, { username: uname, code, password: 'short' })).s === 422, 'weak password rejected at activation (422)');
  r = await call('POST', '/auth/activate', null, { username: uname, code, password: 'Kalamansi2026' });
  ok(r.s === 200 && r.j.activated, 'caregiver activates with the SMS code and an own password');
  r = await call('POST', '/oauth/token', null, { grant_type: 'password', username: uname, password: 'Kalamansi2026' });
  ok(r.s === 200 && r.j.role === 'caregiver', 'and signs in');
  ok((await call('POST', '/auth/activate', null, { username: uname, code, password: 'Kalamansi2026' })).s === 400, 'the activation code works once');
  r = await call('POST', `/api/admin/accounts/${newId}/password-reset`, admin, {});
  ok(r.s === 200 && !JSON.stringify(r.j).includes('#'), 'admin sends a password-reset code by SMS without seeing it');
  ok((await call('POST', `/api/admin/accounts/${newId}/disable`, admin, { reason: 'Smoke test account' })).s === 200, 'admin disables the test account');
} else {
  console.log('SKIP activation checks (ACCOUNT_SMS_CAPTURE is off or INTERNAL_SERVICE_TOKEN unknown)');
}
const fam1 = (await call('POST', '/oauth/token', null, { grant_type: 'password', username: 'family.jose', password: 'ElderCare@2026' })).j;
const fam2 = (await call('POST', '/oauth/token', null, { grant_type: 'password', username: 'family.jose', password: 'ElderCare@2026' })).j;
r = await call('GET', '/api/patients/P-1001', fam1.access_token);
ok(r.s === 401 && r.j.reason === 'session_replaced' && (await call('GET', '/api/patients/P-1001', fam2.access_token)).s === 200, 'signing in again ends the earlier session (single session)');
fam = fam2.access_token;
const nPhone = (await call('POST', '/oauth/token', null, { grant_type: 'password', username: 'nurse.ana', password: 'ElderCare@2026', device: 'phone' })).j;
ok((await call('GET', '/api/clinic/my-cases', nPhone.access_token)).s === 200 && (await call('GET', '/api/clinic/my-cases', nurse)).s === 200, 'a nurse keeps one phone and one desktop session');
ok((await call('POST', '/oauth/lock', nPhone.access_token)).s === 204 && (await call('GET', '/api/clinic/my-cases', nPhone.access_token)).j.reason === 'session_locked', 'a locked session is refused until the password is entered');
r = await call('POST', '/oauth/unlock', null, { refresh_token: nPhone.refresh_token, password: 'ElderCare@2026' });
ok(r.s === 200 && (await call('GET', '/api/clinic/my-cases', r.j.access_token)).s === 200, 'unlock with the password');
for (const [m, p] of [['GET', '/api/patients/P-1001'], ['GET', '/api/clinic/queue'], ['GET', '/api/checkins/review-queue'], ['POST', '/api/alerts/dispatch']]) {
  ok((await call(m, p, admin, m === 'POST' ? {} : undefined)).s === 403, `admin cannot ${m} ${p} (403)`);
}
r = await call('GET', '/api/clinic/queue/summary', admin);
ok(r.s === 200 && typeof r.j.open.total === 'number' && !JSON.stringify(r.j).includes('Lola'), `admin digest is counts only (${r.j.open && r.j.open.total} open cases, no names)`);
r = await call('GET', '/api/admin/audit?limit=100', admin);
ok(r.s === 200 && ['account_created', 'login', 'session_locked'].every((a) => r.j.entries.some((e) => e.action === a)), 'account audit log records who did what and when');

// Archive this run's pending demo check-ins: they leave the pending lists without being marked reviewed.
const lastDemo = (await call('POST', '/api/checkins', cg, { patientId: 'P-1002', vitals: { heartRate: 71 } })).j.checkin;
r = await call('POST', '/api/checkins/archive-demo', nurse, {});
ok(r.s === 200 && r.j.archived >= 1, `nurse archives pending demo check-ins (${r.j && r.j.archived})`);
r = await call('GET', `/api/checkins/${lastDemo.id}`, nurse);
ok(r.j.checkin.archived && r.j.checkin.status !== 'reviewed' && !r.j.checkin.review, 'an archived demo record is not marked reviewed');
ok((await call('POST', `/api/checkins/${lastDemo.id}/review`, nurse, {})).s === 409, 'archived demo record cannot be reviewed (409)');
r = await call('GET', '/api/checkins/review-queue?view=pending&pageSize=200', nurse);
ok(!r.j.checkins.some((c) => c.dataOrigin === 'demo'), 'no demo record left in the pending review lists');

// ---- Team-lead nurse: caregiver / family accounts, elder registration for own teams, operations (read) ----
console.log('\n-- Team-lead nurse --');
{
  const lead = await login('nurse.ana'); // lead of Team A
  const plain = await login('nurse.ben'); // nurse on Team A, not a lead
  r = await call('GET', '/api/me', lead);
  ok(r.s === 200 && r.j.teamLead === true && r.j.leadTeams.includes('CT-MNL-A'), `Ana is a team lead (${r.j && r.j.leadTeams})`);
  ok((await call('GET', '/api/me', plain)).j.teamLead === false, 'Ben is not a team lead');
  const t = Date.now().toString(36).slice(-6);
  r = await call('POST', '/api/admin/accounts', lead, { username: `caregiver.lead${t}`, name: 'Lead Made Caregiver', role: 'caregiver', phone: `0917${String(Date.now()).slice(-7)}` });
  ok(r.s === 201, `team lead creates a caregiver account (${r.s})`);
  const leadCg = r.j.account && r.j.account.id;
  ok((await call('POST', '/api/admin/accounts', lead, { username: `nurse.lead${t}`, name: 'Not Allowed', role: 'clinic_staff', phone: '09175550123' })).s === 403, 'team lead cannot create staff accounts (403)');
  ok((await call('POST', '/api/admin/accounts', plain, { username: `caregiver.ben${t}`, name: 'Not Allowed', role: 'caregiver', phone: '09175550124' })).s === 403, 'a nurse who is not a lead cannot create accounts (403)');
  r = await call('GET', '/api/admin/accounts', lead);
  ok(r.s === 200 && r.j.accounts.every((a) => ['caregiver', 'family_member'].includes(a.role)), 'team lead sees caregiver and family accounts only');
  ok((await call('GET', '/api/admin/audit?limit=5', lead)).s === 200 && (await call('GET', '/api/admin/health', lead)).s === 200 && (await call('GET', '/api/admin/messaging', lead)).s === 200, 'team lead reads the audit log, service health and message queues');
  {
    const accts = (await call('GET', '/api/admin/accounts', admin)).j.accounts;
    const community = new Set(accts.filter((x) => ['caregiver', 'family_member'].includes(x.role)).map((x) => x.id));
    const entries = (await call('GET', '/api/admin/audit?limit=200', lead)).j.entries;
    ok(entries.length > 0 && entries.every((e) => community.has(e.targetId)), `team lead's audit log shows only caregiver and family accounts (${entries.length} entries)`);
  }
  ok((await call('GET', '/api/admin/accounts/U-CS-002/sessions', lead)).s === 403 && (await call('GET', '/api/admin/security', lead)).s === 403, 'sessions and security settings stay with the admin (403)');
  r = await call('POST', '/api/patients', lead, { fullName: `Lead Registered Elder ${t}`, birthDate: '1945-02-02', sex: 'M', addressLine: 'Brgy 5, Manila', zipCode: '1000' });
  ok(r.s === 201, `team lead registers an elder (${r.s})`);
  const lp = r.j.patient && r.j.patient.id;
  ok((await call('PUT', `/api/clinic/patients/${lp}/care`, lead, { patientName: `Lead Registered Elder ${t}`, careTeamId: 'CT-MNL-B', monitoringPlanId: 'MP-DAILY' })).s === 403, 'team lead cannot link an elder to a team they do not lead (403)');
  r = await call('PUT', `/api/clinic/patients/${lp}/care`, lead, { patientName: `Lead Registered Elder ${t}`, careTeamId: 'CT-MNL-A', monitoringPlanId: 'MP-DAILY', caseNurseId: 'U-CS-002' });
  ok(r.s === 201, `team lead links the elder to Team A with Ben as case nurse (${r.s})`);
  ok((await call('PUT', `/api/directory/users/${leadCg}/patients`, lead, { add: [lp] })).s === 200, 'team lead links the caregiver to the elder');
  ok((await call('POST', '/api/patients', plain, { fullName: `Not Allowed ${t}`, birthDate: '1945-02-02', addressLine: 'x street', zipCode: '1000' })).s === 403, 'a nurse who is not a lead cannot register elders (403)');
  ok((await call('GET', '/api/clinic/care-log?limit=20', lead)).j.entries.every((e) => !e.teamId || e.teamId === 'CT-MNL-A'), "team lead reads the assignment log of their own team");
}

console.log(`\n${pass} passed, ${fail} failed`); process.exit(fail?1:0);

#!/usr/bin/env python3
"""Generates ../flows.json (the Node-RED flows) from readable source.

Run after editing: python3 integration/node-red/tools/build-flows.py
Function-node code is plain JavaScript here; logic worth testing lives in src/eldercare.js.
"""
import json, os

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, '..', 'flows.json')
nodes = []

def node(id, type, z, x, y, wires=None, **props):
    n = {'id': id, 'type': type, 'z': z, **props, 'x': x, 'y': y}
    if wires is not None:
        n['wires'] = wires
    nodes.append(n)
    return n

def fn(id, z, name, code, x, y, wires, outputs=1):
    return node(id, 'function', z, x, y, wires, name=name, func=code.strip() + '\n', outputs=outputs,
                timeout=0, noerr=0, initialize='', finalize='', libs=[])

def http_in(id, z, name, url, method, x, y, wires):
    return node(id, 'http in', z, x, y, wires, name=name, url=url, method=method, upload=False, swaggerDoc='')

def http_out(id, z, x, y, name=''):
    return node(id, 'http response', z, x, y, [], name=name, statusCode='', headers={})

def http_req(id, z, name, x, y, wires):
    # method/url/headers come from msg (set by the preceding function node)
    return node(id, 'http request', z, x, y, wires, name=name, method='use', ret='obj', paytoqs='ignore', url='',
                tls='', persist=False, proxy='', insecureHTTPParser=False, authType='', senderr=False, headers=[])

def debug(id, z, name, x, y, complete='payload'):
    return node(id, 'debug', z, x, y, [], name=name, active=True, tosidebar=True, console=True, tostatus=False,
                complete=complete, targetType='msg', statusVal='', statusType='auto')

def comment(id, z, name, info, x, y):
    return node(id, 'comment', z, x, y, None, name=name, info=info)

def inject(id, z, name, repeat, once_delay, x, y, wires):
    return node(id, 'inject', z, x, y, wires, name=name, props=[{'p': 'payload'}], repeat=str(repeat), crontab='',
                once=True, onceDelay=str(once_delay), topic='', payload='', payloadType='date')

INTERNAL_HEADERS = r"""
const internalHeaders = (requestId) => ({
    'content-type': 'application/json',
    'x-internal-token': env.get('INTERNAL_SERVICE_TOKEN'),
    'x-request-id': requestId || msg._msgid,
    'x-user-id': 'node-red',
});
"""

# ============================================================================ Tab 1: SMS router
T1 = 'tab_sms'
nodes.append({'id': T1, 'type': 'tab', 'label': 'TextBee SMS router', 'disabled': False,
              'info': 'EAI Content-Based Router. The API gateway verifies the TextBee X-Signature on the raw body, then forwards the webhook here with X-Internal-Token. TextBee is acknowledged at once (it needs a 2xx within 10 s); the message is then routed by its content to one alert-service endpoint.'})
comment('c_sms', T1, 'TextBee webhook -> authenticate -> ack -> route by content -> alert-service',
        'Routes: delivery receipt, CHECKIN / bare vitals, SOS, STOP, START, HELP, anything else. Rules: src/eldercare.js classifyTextbeeEvent().', 330, 40)
http_in('sms_in', T1, 'TextBee webhook (via gateway)', '/webhooks/textbee', 'post', 160, 120, [['sms_classify']])
fn('sms_classify', T1, 'Authenticate gateway + classify', r"""
const ec = global.get('eldercare');
if (!ec.checkInternalToken(msg.req.get('x-internal-token'), env.get('INTERNAL_SERVICE_TOKEN'))) {
    node.warn('rejected webhook without a valid X-Internal-Token');
    msg.statusCode = 401;
    msg.payload = { error: 'unauthorized' };
    return [msg, null];
}
const c = ec.classifyTextbeeEvent(msg.payload);
const ack = { _msgid: msg._msgid, req: msg.req, res: msg.res, statusCode: 200, payload: { ok: true, route: c.route } };
const work = { route: c.route, classification: c, requestId: msg.req.get('x-request-id') || msg._msgid };
node.status({ fill: 'blue', shape: 'dot', text: c.route });
return [ack, work];
""", 420, 120, [['sms_ack'], ['sms_switch']], outputs=2)
http_out('sms_ack', T1, 680, 80, 'ack TextBee')

routes = ['delivery_status', 'checkin', 'emergency', 'opt_out', 'opt_in', 'help', 'unknown', 'ignored']
node('sms_switch', 'switch', T1, 680, 220, [[f'sms_prep_{r}'] for r in routes],
     name='Route by content', property='route', propertyType='msg',
     rules=[{'t': 'eq', 'v': r, 'vt': 'str'} for r in routes], checkall='false', repair=False, outputs=len(routes))

labels = {
    'delivery_status': 'Receipt -> /internal/sms/status',
    'checkin': 'Check-in -> /internal/sms/checkin',
    'emergency': 'SOS -> /internal/sms/emergency',
    'opt_out': 'STOP -> /internal/sms/opt_out',
    'opt_in': 'START -> /internal/sms/opt_in',
    'help': 'HELP -> /internal/sms/help',
    'unknown': 'Unknown -> /internal/sms/unknown',
}
for i, r in enumerate(routes):
    y = 120 + i * 50
    if r == 'ignored':
        fn(f'sms_prep_{r}', T1, 'Ignored (no action)', r"""
node.log(`ignored TextBee event: ${msg.classification.reason}`);
const stats = global.get('smsRouter') || { since: new Date().toISOString(), routes: {}, last: [] };
stats.routes.ignored = (stats.routes.ignored || 0) + 1;
global.set('smsRouter', stats);
return null;
""", 960, y, [[]])
        continue
    body = "msg.classification.status" if r == 'delivery_status' else "msg.classification.sms"
    path = 'status' if r == 'delivery_status' else r
    fn(f'sms_prep_{r}', T1, labels[r], INTERNAL_HEADERS + rf"""
msg.method = 'POST';
msg.url = `${{env.get('ALERT_SERVICE_URL')}}/internal/sms/{path}`;
msg.headers = internalHeaders(msg.requestId);
msg.payload = {body};
msg.requestTimeout = 15000;
return msg;
""", 960, y, [['sms_call']])

http_req('sms_call', T1, 'alert-service', 1220, 270, [['sms_result']])
fn('sms_result', T1, 'Record outcome', r"""
const ok = msg.statusCode === 200;
const stats = global.get('smsRouter') || { since: new Date().toISOString(), routes: {}, last: [] };
stats.routes[msg.route] = (stats.routes[msg.route] || 0) + 1;
if (!ok) stats.failures = (stats.failures || 0) + 1;
stats.last = [{ at: new Date().toISOString(), route: msg.route, status: msg.statusCode, duplicate: Boolean(msg.payload && msg.payload.duplicate) }, ...stats.last].slice(0, 20);
global.set('smsRouter', stats);
node.status({ fill: ok ? 'green' : 'red', shape: 'dot', text: `${msg.route}: ${msg.statusCode}` });
if (!ok) node.error(`alert-service ${msg.route} failed: ${msg.statusCode} ${JSON.stringify(msg.payload).slice(0, 200)}`);
return msg;
""", 1400, 270, [['sms_debug']])
debug('sms_debug', T1, 'SMS route result', 1600, 270)
node('sms_catch', 'catch', T1, 160, 560, [['sms_catch_dbg']], name='SMS router errors', scope=None, uncaught=False)
debug('sms_catch_dbg', T1, 'error', 380, 560, complete='error')

# ============================================================================ Tab 2: weather orchestration
T2 = 'tab_weather'
nodes.append({'id': T2, 'type': 'tab', 'label': 'Weather orchestration', 'disabled': False,
              'info': 'Process manager for the OpenWeatherMap mashup (replaces the alert service\'s own timer, WEATHER_POLL_ENABLED=false). Every 30 minutes: fetch the monitored zip codes from the check-in service, split them, throttle to one OpenWeatherMap check every 2 s, call the alert service per zip (it applies the admin alert rules and warns families / opens triage items), then aggregate one run summary for the dashboard.'})
comment('c_weather', T2, 'every 30 min -> locations -> split -> throttle -> weather-check per zip -> aggregate',
        'EAI: Splitter + Aggregator + throttling. One run at a time; a run that does not finish in 5 minutes is abandoned.', 370, 40)
inject('w_tick', T2, 'every 30 minutes', 1800, 30, 150, 120, [['w_start']])
node('w_link_in', 'link in', T2, 150, 170, [['w_start']], name='run weather now', links=['dash_weather_link'])
fn('w_start', T2, 'Start run: get locations', INTERNAL_HEADERS + r"""
const running = flow.get('runningSince');
if (running && Date.now() - running < 5 * 60000) {
    node.warn('weather run already in progress, skipping this tick');
    return null;
}
const runId = msg._msgid;
flow.set('runningSince', Date.now());
flow.set('run', { id: runId, startedAt: Date.now(), expected: null, parts: [] });
node.status({ fill: 'blue', shape: 'ring', text: 'fetching locations' });
return { _msgid: runId, runId, method: 'GET', url: `${env.get('CHECKIN_SERVICE_URL')}/internal/locations`, headers: internalHeaders(runId), requestTimeout: 10000 };
""", 380, 140, [['w_locations']])
http_req('w_locations', T2, 'check-in: /internal/locations', 620, 140, [['w_split']])
fn('w_split', T2, 'Split per location', r"""
const ec = global.get('eldercare');
const run = flow.get('run');
if (msg.statusCode !== 200 || !msg.payload || !Array.isArray(msg.payload.locations)) {
    const summary = ec.summarizeWeatherRun([{ zipCode: '*', status: msg.statusCode, body: msg.payload }], run.startedAt);
    global.set('weatherLastRun', summary);
    flow.set('runningSince', null);
    node.status({ fill: 'red', shape: 'dot', text: `locations failed: ${msg.statusCode}` });
    return [null, { payload: summary }];
}
const locations = msg.payload.locations;
run.expected = locations.length;
flow.set('run', run);
if (!locations.length) {
    const summary = ec.summarizeWeatherRun([], run.startedAt);
    global.set('weatherLastRun', summary);
    flow.set('runningSince', null);
    return [null, { payload: summary }];
}
node.status({ fill: 'blue', shape: 'dot', text: `${locations.length} locations` });
return [locations.map((loc) => ({ runId: msg.runId, location: loc })), null];
""", 860, 140, [['w_throttle'], ['w_debug']], outputs=2)
node('w_throttle', 'delay', T2, 380, 260, [['w_prep']], name='1 check / 2 s (OpenWeatherMap limits)',
     pauseType='rate', timeout='5', timeoutUnits='seconds', rate='1', nbRateUnits='2', rateUnits='second',
     randomFirst='1', randomLast='5', randomUnits='seconds', drop=False, allowrate=False, outputs=1)
fn('w_prep', T2, 'Prepare weather-check', INTERNAL_HEADERS + r"""
const loc = msg.location;
msg.method = 'POST';
msg.url = `${env.get('ALERT_SERVICE_URL')}/api/alerts/weather-check`;
msg.headers = internalHeaders(msg.runId);
msg.payload = { zipCode: String(loc.zipCode), countryCode: loc.countryCode || 'PH' };
msg.requestTimeout = 30000;
return msg;
""", 620, 260, [['w_check']])
http_req('w_check', T2, 'alert: weather-check (applies alert rules)', 860, 260, [['w_aggregate']])
fn('w_aggregate', T2, 'Aggregate run summary', r"""
const ec = global.get('eldercare');
const run = flow.get('run');
if (!run || run.id !== msg.runId) return null; // a late reply from an abandoned run
run.parts.push({ zipCode: msg.location.zipCode, status: msg.statusCode, body: msg.payload });
flow.set('run', run);
node.status({ fill: 'blue', shape: 'dot', text: `${run.parts.length}/${run.expected}` });
if (run.parts.length < run.expected) return null;
const summary = ec.summarizeWeatherRun(run.parts, run.startedAt);
global.set('weatherLastRun', summary);
flow.set('runningSince', null);
node.status({ fill: summary.status === 'ok' ? 'green' : 'yellow', shape: 'dot', text: `${summary.status}: ${summary.patientsWarned} warned` });
return { payload: summary };
""", 1110, 260, [['w_debug']])
debug('w_debug', T2, 'weather run summary', 1120, 140)
node('w_catch', 'catch', T2, 150, 380, [['w_catch_dbg']], name='weather errors', scope=None, uncaught=False)
debug('w_catch_dbg', T2, 'error', 370, 380, complete='error')

# ============================================================================ Tab 3: DLQ monitor + dashboard
T3 = 'tab_dlq'
nodes.append({'id': T3, 'type': 'tab', 'label': 'DLQ monitor + dashboard', 'disabled': False,
              'info': 'Polls every service\'s /internal/messaging every 15 s (RabbitMQ connection, queue and dead-letter queue depths, outbox). Serves a dashboard at /dlq (HTTP Basic: DASHBOARD_USER / DASHBOARD_PASSWORD) with replay buttons, the last weather run and SMS router counters.'})
comment('c_dlq', T3, 'poll /internal/messaging (3 services) -> summary -> /dlq dashboard + replay',
        'EAI: Dead Letter Channel monitoring + Message Store replay. Replays go through each service\'s own /internal/messaging/replay, which logs an audit entry.', 380, 40)
inject('d_tick', T3, 'every 15 s', 15, 5, 130, 120, [['d_poll']])
fn('d_poll', T3, 'Poll each service', INTERNAL_HEADERS + r"""
const pollId = msg._msgid;
flow.set('poll', { id: pollId, parts: [] });
const services = { checkin: env.get('CHECKIN_SERVICE_URL'), alert: env.get('ALERT_SERVICE_URL'), clinic: env.get('CLINIC_SERVICE_URL') };
return [Object.entries(services).map(([service, base]) => ({
    pollId, service, method: 'GET', url: `${base}/internal/messaging`, headers: internalHeaders(pollId), requestTimeout: 5000,
}))];
""", 330, 120, [['d_status']])
http_req('d_status', T3, 'GET /internal/messaging', 560, 120, [['d_collect']])
fn('d_collect', T3, 'Collect + detect new dead letters', r"""
const ec = global.get('eldercare');
const poll = flow.get('poll');
if (!poll || poll.id !== msg.pollId) return null;
poll.parts.push({ service: msg.service, status: msg.statusCode, body: msg.payload });
flow.set('poll', poll);
if (poll.parts.length < 3) return null;
const summary = ec.summarizeMessaging(poll.parts);
const before = (global.get('messaging') || {}).totalDeadLetters || 0;
global.set('messaging', summary);
node.status({ fill: summary.healthy ? 'green' : 'red', shape: 'dot', text: `${summary.totalDeadLetters} dead letters` });
if (summary.totalDeadLetters > before) {
    node.warn(`dead-letter queues grew: ${before} -> ${summary.totalDeadLetters} ${JSON.stringify(summary.deadLetters)}`);
    return { payload: summary.deadLetters, topic: 'dlq-alert' };
}
return null;
""", 800, 120, [['d_alert_dbg']])
debug('d_alert_dbg', T3, 'DLQ grew', 1020, 120)

AUTH = r"""
const ec = global.get('eldercare');
if (!ec.checkBasicAuth(msg.req.get('authorization'), env.get('DASHBOARD_USER'), env.get('DASHBOARD_PASSWORD'))) {
    msg.statusCode = 401;
    msg.headers = { 'WWW-Authenticate': 'Basic realm="ElderCare DLQ dashboard", charset="UTF-8"' };
    msg.payload = env.get('DASHBOARD_PASSWORD') ? 'Sign in required' : 'Dashboard disabled: set DASHBOARD_PASSWORD';
    return [null, msg];
}
"""
http_in('dash_page_in', T3, 'GET /dlq', '/dlq', 'get', 120, 240, [['dash_page_auth']])
fn('dash_page_auth', T3, 'Basic auth', AUTH + "return [msg, null];", 300, 240, [['dash_page_tpl'], ['dash_page_out']], outputs=2)
DASHBOARD_HTML = open(os.path.join(HERE, 'dashboard.html'), encoding='utf-8').read()
node('dash_page_tpl', 'template', T3, 480, 220, [['dash_page_hdr']], name='dashboard.html', field='payload', fieldType='msg',
     format='html', syntax='plain', template=DASHBOARD_HTML, output='str')
fn('dash_page_hdr', T3, 'HTML headers', r"""
msg.headers = { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' };
return msg;
""", 660, 220, [['dash_page_out']])
http_out('dash_page_out', T3, 860, 240)

http_in('dash_status_in', T3, 'GET /dlq/api/status', '/dlq/api/status', 'get', 140, 320, [['dash_status_auth']])
fn('dash_status_auth', T3, 'Basic auth + status', AUTH + r"""
msg.headers = { 'cache-control': 'no-store' };
msg.payload = {
    messaging: global.get('messaging') || null,
    weather: global.get('weatherLastRun') || null,
    sms: global.get('smsRouter') || null,
    replays: global.get('replayLog') || [],
};
return [msg, null];
""", 360, 320, [['dash_status_out'], ['dash_status_out']], outputs=2)
http_out('dash_status_out', T3, 580, 320)

http_in('dash_replay_in', T3, 'POST /dlq/api/replay', '/dlq/api/replay', 'post', 140, 400, [['dash_replay_auth']])
fn('dash_replay_auth', T3, 'Basic auth + validate replay', AUTH + INTERNAL_HEADERS + r"""
const { errors, value } = ec.validateReplay(msg.payload);
if (errors.length) {
    msg.statusCode = 422;
    msg.payload = { error: 'validation_failed', details: errors };
    return [null, msg];
}
const bases = { checkin: env.get('CHECKIN_SERVICE_URL'), alert: env.get('ALERT_SERVICE_URL'), clinic: env.get('CLINIC_SERVICE_URL') };
msg.replay = value;
msg.method = 'POST';
msg.url = `${bases[value.service]}/internal/messaging/replay`;
msg.headers = { ...internalHeaders(), 'x-user-id': `node-red-dashboard:${env.get('DASHBOARD_USER')}` };
msg.payload = { queue: value.queue, limit: value.limit };
msg.requestTimeout = 15000;
return [msg, null];
""", 380, 400, [['dash_replay_call'], ['dash_replay_out']], outputs=2)
http_req('dash_replay_call', T3, 'POST /internal/messaging/replay', 620, 380, [['dash_replay_done']])
fn('dash_replay_done', T3, 'Audit + respond', r"""
const ok = msg.statusCode === 200;
const entry = { at: new Date().toISOString(), ...msg.replay, status: msg.statusCode, result: ok ? msg.payload : null };
global.set('replayLog', [entry, ...(global.get('replayLog') || [])].slice(0, 20));
node.warn(`DLQ replay ${JSON.stringify(entry)}`);
msg.headers = { 'cache-control': 'no-store' }; // drop the upstream response headers
if (typeof msg.statusCode !== 'number') { msg.statusCode = 502; msg.payload = { error: 'bad_gateway', message: String(msg.payload) }; }
return msg;
""", 860, 380, [['dash_replay_out']])
http_out('dash_replay_out', T3, 1060, 400)

http_in('dash_weather_in', T3, 'POST /dlq/api/weather-run', '/dlq/api/weather-run', 'post', 150, 480, [['dash_weather_auth']])
fn('dash_weather_auth', T3, 'Basic auth', AUTH + r"""
msg.statusCode = 202;
msg.payload = { started: true, note: 'summary appears on the dashboard when the run finishes' };
return [msg, null];
""", 380, 480, [['dash_weather_out', 'dash_weather_link'], ['dash_weather_out']], outputs=2)
http_out('dash_weather_out', T3, 600, 460)
node('dash_weather_link', 'link out', T3, 575, 520, None, name='to weather orchestration', mode='link', links=['w_link_in'])

http_in('health_in', T3, 'GET /health', '/health', 'get', 120, 580, [['health_fn']])
fn('health_fn', T3, 'health', r"""
const m = global.get('messaging');
msg.payload = { status: 'up', service: 'node-red', flows: ['sms-router', 'weather-orchestration', 'dlq-monitor'], lastPoll: m ? m.checkedAt : null };
return msg;
""", 290, 580, [['health_out']])
http_out('health_out', T3, 450, 580)
node('d_catch', 'catch', T3, 120, 640, [['d_catch_dbg']], name='monitor errors', scope=None, uncaught=False)
debug('d_catch_dbg', T3, 'error', 320, 640, complete='error')

# link-in references need the link-out id (set above)
for n in nodes:
    if n['id'] == 'dash_weather_link':
        n['wires'] = []

with open(OUT, 'w', encoding='utf-8') as f:
    json.dump(nodes, f, indent=2, ensure_ascii=False)
    f.write('\n')
print(f'wrote {len(nodes)} nodes to flows.json')

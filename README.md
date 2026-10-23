# ElderCare Connect

Integrated community-based elderly health monitoring and emergency response platform
(TIP Manila · Systems Integration and Architecture 1 · IT31S1 Group 6).

Node.js + Express microservices behind an API Gateway, PostgreSQL per service, OAuth 2.0/JWT + RBAC,
OpenWeatherMap × patient-profile mashup, **RabbitMQ** message-oriented middleware (topic exchange, retry tiers,
dead-letter queues, idempotent consumers), **TextBee** SMS, and a SOAP/XML adapter for
legacy RHU clinic EMRs. React web dashboards and a React Native caregiver app are included.

### Documentation
- `docs/MESSAGING.md` – RabbitMQ topology, event catalogue + JSON Schemas, DLQ, idempotency (v2 · Batch 1)
- `docs/SECURITY.md` – token revocation, refresh rotation + reuse detection, `kid` key rotation, Docker secrets (v2 · Batch 2)
- `docs/NODE_RED.md` – Node-RED EAI flows: TextBee SMS content-based router, weather orchestration, DLQ monitor + replay dashboard (v2 · Batch 3)
- `docs/CARE_PLAN.md` – Care Plan Service: caregiver duties by category, daily checklist, adherence (v2 · Batch 4)
- `docs/EVALUATION_RESPONSE.md` – each item of the professor's evaluation → where it is addressed
- `docs/PROPOSAL_TRACEABILITY.md` – every proposal section mapped to code and verification evidence
- `docs/SUBMISSION_GUIDE.md` – frontend, cloud deployment, middleware data flows (with measured results), JMeter, CI/CD, demo script
- `testing/README.md` – Postman, SoapUI, JMeter and failure-test commands

### Verified results (v2 Docker run, 2026-10-22: PostgreSQL 16, RabbitMQ 3.13, Node-RED 4.1, all services)
| Check | Result |
|---|---|
| Unit tests | 110 / 110 passing (7 packages) |
| End-to-end smoke test | 95 / 95 passing (all batches) |
| Postman collection (Postman CLI) | 95 requests, 157 assertions, 0 failures |
| SoapUI test cases (replayed) | 4 / 4 passing |
| Database isolation | every service reaches only its own database (4 × 4 login checks) |
| Check-in → family alert → clinic queue | **95 ms / 39 ms** (objective ≤ 2.0 s) |
| Alert service down during a check-in | check-in accepted; event held in RabbitMQ and delivered as soon as the service was back |
| Heatwave (heat index 46.8 °C) / typhoon (24 m/s) | correct at-risk patients warned; P1 / P2 triage items created (v1.1 fake-OWM run; thresholds are now alert rules) |
| OpenWeatherMap unreachable | stale cached data used, outage logged |
| TextBee unreachable | RabbitMQ retry tiers 5 s / 30 s / 2 min, then DLQ; in-app alert kept |
| Forged TextBee webhook | rejected (401, HMAC `X-Signature`) |

### Where the Section 10 / 11 / 12 deliverables live
| Task | Files |
|---|---|
| 1 · API Gateway & security | `api-gateway/server.js`, `api-gateway/src/middleware/authMiddleware.js`, `api-gateway/src/middleware/roleMiddleware.js`, `api-gateway/src/routes/oauth.js`, `api-gateway/src/auth/*` |
| 2 · API routing contracts | `api-gateway/src/routes/index.js`, `api-gateway/src/lib/proxy.js` |
| 3 · Weather × SMS mashup | `services/alert-service/src/weatherAlertMashup.js`, `weatherRisk.js`, `textbeeClient.js`, `smsWorker.js` |
| Middleware (RabbitMQ) | `shared/messageBus.js`, `shared/outboxRelay.js`, `shared/idempotency.js`, `contracts/events/*.schema.json` |
| Legacy SOAP/XML adapter | `services/legacy-emr-adapter/` (+ mock EMR and WSDL in `services/mock-legacy-emr/`) |

---

## 1. Architecture

```mermaid
flowchart TB
  subgraph Clients
    CA[Caregiver App<br/>React Native]
    FD[Caregiver & Family<br/>phone apps]
    CP[Clinic Portal / Admin View<br/>React]
  end
  CA & FD & CP -->|HTTPS + Bearer JWT| GW[API Gateway :8080<br/>OAuth 2.0 token endpoint · JWT · RBAC · rate limit · routing]
  GW --> CK[Daily Check-In Logger :4001]
  GW --> AL[Family Alert & Notification :4002]
  GW --> CL[Clinic Risk Queue :4003]
  GW --> CPS[Care Plan :4006<br/>caregiver duties]
  CK -- "checkin.* (outbox)" --> MQ[[RabbitMQ<br/>exchange eldercare.events<br/>retry tiers · DLQs]]
  AL -- "weather.risk_detected<br/>notification.sms.requested" --> MQ
  MQ -- alert-service.checkin-events --> AL
  MQ -- alert-service.sms-dispatch --> SW[TextBee SMS worker<br/>in alert service]
  MQ -- clinic-risk-service.events --> CL
  CK --- CKDB[(checkin_db<br/>login checkin_svc)]
  AL --- ALDB[(alert_db<br/>login alert_svc)]
  CL --- CLDB[(clinic_db<br/>login clinic_svc)]
  CPS --- CPDB[(care_db<br/>login care_svc)]
  AL -->|REST| OWM[OpenWeatherMap API]
  SW -->|REST| TB[TextBee SMS gateway<br/>Android phone]
  TB -->|webhook, X-Signature| GW
  GW -->|verified webhook| NR[Node-RED EAI :1880<br/>SMS router · weather orchestration · DLQ monitor]
  NR -->|/internal/sms/*, weather-check, DLQ replay| AL
  NR -.->|/internal/messaging| CK & CL
  EMR[Legacy Clinic EMR<br/>mock :4005] ==>|"SOAP 1.1 XML (inbound data)"| AD[Legacy Integration Layer :4004<br/>SOAP/XML → JSON adapter]
  AD ==>|"JSON patient history"| CL
```

| Component | Folder | Owns |
|---|---|---|
| API Gateway | `api-gateway/` | Nothing persistent – auth, RBAC, routing |
| Daily Check-In Logger | `services/checkin-service/` | patients, check-ins, vital trends, baselines, outbox |
| Family Alert & Notification | `services/alert-service/` | alert rules, alerts, notification logs, subscribers, weather cache |
| Clinic Risk Queue | `services/clinic-risk-service/` | risk scores, triage items, follow-up actions |
| Care Plan | `services/care-plan-service/` | care plans, caregiver duty tasks, task completions (Batch 4) |
| Node-RED EAI layer | `integration/node-red/` | none (flows): SMS content-based router, weather orchestration, DLQ dashboard (Batch 3) |
| Legacy EMR Adapter | `services/legacy-emr-adapter/` | none (stateless translator) |
| Mock Legacy EMR | `services/mock-legacy-emr/` | demo data for SoapUI / dev (zero dependencies) |
| Web app | `frontend/web/` | React (Vite) – phone-first caregiver, family and nurse apps, desktop clinic pages, admin console |
| Caregiver mobile | `frontend/mobile/` | React Native (Expo), offline-first check-ins |
| Test assets | `testing/` | Postman, JMeter, SoapUI |

**Data ownership rule:** each service talks only to its own database, with its **own non-superuser login**
(`checkin_svc`, `alert_svc`, `clinic_svc`, `care_svc`); another service's credentials are refused by PostgreSQL itself
(`npm run verify:db-isolation`). Cross-service data moves over REST (`/internal/*` endpoints) or RabbitMQ
events – never by reading another service's tables.

**Legacy EMR direction (Figure 7 correction):** data flows **inbound** – Legacy Clinic EMR ⇒ Legacy
Integration Layer (SOAP/XML → JSON) ⇒ Clinic Risk Queue Service. The Clinic service initiates the request,
but patient history travels from the legacy system into the platform, never the other way.

### The Check-in → Alert → Clinic Queue saga (Section 15)
1. Caregiver `POST /api/checkins` → gateway validates JWT, role `caregiver`, and that the patient is in the token's `patients` claim.
2. Check-in service validates vitals, runs anomaly detection, and in **one DB transaction** stores the check-in **and** one outbox event.
3. The outbox relay publishes `checkin.anomaly_detected` to the RabbitMQ topic exchange `eldercare.events` (persistent, publisher-confirmed). The broker fans it out to `alert-service.checkin-events` and `clinic-risk-service.events`. If the broker is down the row stays pending and is retried – never silently dropped.
4. Alert service writes the in-app alert and one `notification.sms.requested` event per subscriber (same transaction); the TextBee SMS worker sends them (retry tiers 5 s / 30 s / 2 min, then DLQ; in-app alert is the fallback channel).
5. Clinic service upserts the patient's single active triage item and recomputes the weighted score/priority.
Both consumers are idempotent on `eventId` (recorded in the same transaction as their change), so at-least-once delivery is safe. Failed messages are retried through TTL retry queues and then parked in a DLQ for replay (`GET /api/admin/messaging`). Details: `docs/MESSAGING.md`.

---

## 2. Quick start (Docker – recommended)

Requirements: Docker Desktop (or Docker Engine + Compose v2).

```bash
cp .env.example .env
# edit .env: set strong JWT_SECRET, JWT_REFRESH_SECRET, INTERNAL_SERVICE_TOKEN
#            RABBITMQ_PASSWORD, optionally OPENWEATHER_API_KEY and TEXTBEE_* (SMS stays in dry-run until SMS_DRY_RUN=false)
docker compose up --build
```

Gateway: <http://localhost:8080> · RabbitMQ UI: <http://localhost:15672> (vhost `eldercare`) · Mock EMR WSDL: <http://localhost:4005/emr?wsdl>
· Node-RED DLQ dashboard: <http://localhost:1880/dlq> (`DASHBOARD_USER` / `DASHBOARD_PASSWORD`) and editor <http://localhost:1880/admin>

Upgrading an existing v1 stack: run `docker compose down -v` once so the new database init script can create the per-service logins.

Smoke test:
```bash
TOKEN=$(curl -s localhost:8080/oauth/token -H 'Content-Type: application/json' \
  -d '{"grant_type":"password","username":"caregiver.maria","password":"ElderCare@2026"}' | node -pe 'JSON.parse(require("fs").readFileSync(0)).access_token')

curl -s localhost:8080/api/checkins -H "Authorization: Bearer $TOKEN" -H 'Content-Type: application/json' \
  -d '{"patientId":"P-1001","vitals":{"systolic":186,"diastolic":118,"heartRate":104},"medication":{"taken":false}}'
```

Web dashboards:
```bash
cd frontend/web && npm install && npm run dev      # http://localhost:3000 (proxies /api and /oauth to :8080)
```
Open it, tap **Get started** and pick a role (one-tap demo sign-in, on in development or with `VITE_DEMO_LOGIN=true`).
Caregivers and families use only the phone app (`/m/caregiver`, `/m/family`; on a computer it shows in a phone-sized
frame); nurses get `/m/nurse` on a phone and the desktop clinic pages (`/clinic`) on a computer; admins get the web
console (`/admin`), which also exports the daily digest as JSON / XML. Set `VITE_CLINIC_PHONE` to the
health center hotline to enable the "Call the clinic" buttons. Use Chrome DevTools' device toolbar to see the phone layout.
Caregiver app (Expo Go on your phone): set `expo.extra.apiBaseUrl` in `frontend/mobile/app.json` to your computer's LAN IP, then `cd frontend/mobile && npm install && npx expo start`.

### Demo accounts (password `ElderCare@2026` – change before any real use)
| Username | Role | Patients |
|---|---|---|
| `caregiver.maria` | caregiver | P-1001, P-1002 |
| `family.jose` | family_member | P-1001 |
| `nurse.ana` | clinic_staff | all |
| `admin.harold` | system_admin | all |

Users live in `api-gateway/data/users.json` with scrypt hashes. New hash: `node api-gateway/scripts/hash-password.js "NewPassword"`.

---

## 3. Running without Docker (Windows / macOS / Linux)

You need Node 18+ and PostgreSQL 14+. RabbitMQ is optional locally: without `--amqp` the services use `EVENT_TRANSPORT=http` (direct REST delivery; the SMS queue runs in-process with the same retry/DLQ rules).

```powershell
# 1. create the three databases (psql, pgAdmin, or:)
createdb -U postgres checkin_db
createdb -U postgres alert_db
createdb -U postgres clinic_db

# 2. from the project root: generate every .env and install all backend packages
node scripts/setup-local.js "YourPostgresPassword"
npm run install:all
```
`setup-local.js` creates all five `.env` files with:
- one shared, freshly generated `INTERNAL_SERVICE_TOKEN`
- random JWT secrets
- `DATABASE_URL`s for `localhost:5432` (special characters in the password are encoded for you)
- one dedicated PostgreSQL login per service (`checkin_svc`, `alert_svc`, `clinic_svc`), created for you
- `EVENT_TRANSPORT=http` (or RabbitMQ with `--amqp amqp://guest:guest@localhost:5672`) and `SMS_DRY_RUN=true`

Re-run it with `--force` to regenerate. Use `--db-port`, `--db-user` or `--amqp <url>` if your setup differs.

```powershell
# 3. start each service in its own terminal tab (order matters only for the first log lines)
cd services\mock-legacy-emr;     node server.js   # :4005
cd services\legacy-emr-adapter;  npm start        # :4004
cd services\clinic-risk-service; npm start        # :4003
cd services\alert-service;       npm start        # :4002
cd services\checkin-service;     npm start        # :4001
cd api-gateway;                  npm start        # :8080

# 4. verify (new tab, project root)
npm test          # 38 unit tests
npm run smoke     # 21 end-to-end checks through the gateway
```
Each service creates its own tables (and demo data) on first start.

If PowerShell refuses to run `npm` ("running scripts is disabled"), run this once and reopen the terminal: `Set-ExecutionPolicy -Scope CurrentUser RemoteSigned`.

---

## 4. API reference (public, via the gateway)

All `/api/*` routes need `Authorization: Bearer <access_token>`.

**Pagination (v2 · Batch 2).** List endpoints (patient list, check-in history, notifications, clinic queue,
case history, alert rules) take `?page=1&pageSize=50` and return the items plus
`"pagination": {"page", "pageSize", "totalItems", "totalPages", "hasNext", "hasPrev"}`. `limit=` still
works as an alias for `pageSize`; invalid `page` / `pageSize` values return `422`.

| Method | Path | Roles | Service | Notes |
|---|---|---|---|---|
| POST | `/oauth/token` | public | gateway | `grant_type=password` or `refresh_token` (RFC 6749); refresh tokens rotate, reuse revokes the session |
| POST | `/oauth/revoke` | token holder | gateway | `{token, token_type_hint?}` (RFC 7009) – always 200 |
| POST | `/oauth/logout` | any signed-in user | gateway | ends the session: access + refresh tokens stop working → 204 |
| POST | `/api/checkins` | caregiver (assigned patient) | Check-In | 201 + anomalies; 422 validation; `idempotencyKey` for offline replay |
| GET | `/api/patients/:id/history?days=30&page=&pageSize=` | caregiver, family (own), clinic, admin | Check-In | check-ins + trends + baseline |
| GET | `/api/patients/:id` | same as above | Check-In | profile |
| POST | `/api/alerts/dispatch` | clinic, admin | Alert | `{patientId, message, severity?, title?, channels?}` → 202 |
| GET | `/api/alerts/notifications?patientId=` | family, caregiver | Alert | in-app alert feed for own patients |
| POST | `/api/alerts/weather-check` | clinic, admin | Alert | run weather mashup now (`{zipCode?}`); result lists every rule evaluated |
| GET | `/api/alerts/rules?type=weather\|system&hazard=&enabled=` | clinic, admin | Alert | **alert rules** the weather mashup applies |
| GET | `/api/alerts/rules/:code` | clinic, admin | Alert | one rule |
| POST | `/api/alerts/rules` | admin | Alert | `{code, description, hazard, trigger_condition, vulnerability_target, action, enabled?}` → 201 (+ `Location`), 409 duplicate, 422 field errors |
| PATCH | `/api/alerts/rules/:code` | admin | Alert | partial update; system rules: only `description`, `enabled`, `action` |
| DELETE | `/api/alerts/rules/:code` | admin | Alert | 204; system rules → 409 (disable them instead) |
| GET | `/api/clinic/queue?status=&priority=&clinic=` | clinic, admin | Clinic | prioritised triage queue |
| PATCH | `/api/clinic/queue/:itemId` | clinic | Clinic | `{status?, notes?, assignedTo?}` with transition rules |
| GET | `/api/clinic/patients/:id/emr-history` | clinic, admin | Clinic → Adapter → SOAP EMR | translated legacy history; boosts risk score |
| GET | `/api/admin/health` | admin | gateway | health of every service + circuit breakers |
| GET | `/api/admin/users` | admin | gateway | user accounts and roles (never password hashes) |
| GET | `/api/patients?search=&page=&pageSize=` | clinic, admin | Check-In | patient list for the clinic (with last check-in) |
| POST | `/api/patients` | clinic, admin | Check-In | **onboard a patient** (+ optional medicines); 422 field errors, 409 duplicate name + birth date |
| GET | `/api/patients/:id/medications?includeInactive=` | caregiver, family (own), clinic, admin | Check-In | **prescribed medicines** + today's dose schedule |
| POST / PATCH | `/api/patients/:id/medications[/:medId]` | clinic | Check-In | prescribe / change / stop (`active:false`) |
| GET | `/api/patients/:id/visits?view=upcoming\|recent\|all` | caregiver, family (own), clinic, admin | Clinic | visits for one patient |
| POST | `/api/clinic/queue/:itemId/visits` | clinic | Clinic | **schedule a visit** `{visitType, visitDate, visitTime, destination, location, contactPhone?, notes?}` |
| PATCH | `/api/clinic/visits/:visitId` | clinic | Clinic | `{status: completed\|cancelled\|no_show, outcome?, resolveCase?}` |
| GET | `/api/clinic/visits?view=upcoming\|recent&days=30` | clinic, admin | Clinic | visit board / **Recent Visits** |
| GET | `/api/clinic/queue/history?patientId=&outcome=&from=&to=` | clinic, admin | Clinic | **resolved / dismissed cases** with follow-ups and visits |
| GET | `/api/directory/users?role=` | clinic, admin | gateway | caregiver/family accounts for assignment |
| PUT | `/api/directory/users/:userId/patients` | clinic, admin | gateway | `{add:[], remove:[]}` link patients to an account |
| GET / POST / DELETE | `/api/alerts/subscribers` | clinic, admin | Alert | SMS alert contacts per patient; shows whether real SMS is live |
| POST | `/webhooks/textbee` | TextBee (HMAC-verified) | Alert | delivery receipts + inbound SMS check-ins |
| GET | `/api/admin/messaging` | admin | gateway → services | RabbitMQ connection, queue + **DLQ depths**, outbox counts |
| POST | `/api/admin/messaging/replay` | admin | gateway → service | `{service, queue, limit?}` replay parked DLQ messages |
| GET | `/api/care/categories` | all roles | Care Plan | 8 duty categories with suggested tasks |
| GET | `/api/patients/:id/care-plan` | caregiver, family (own), clinic, admin | Care Plan | goals, notes and duty tasks |
| PUT | `/api/patients/:id/care-plan` | clinic | Care Plan | `{goals?, notes?}` |
| POST | `/api/patients/:id/care-plan/tasks` | clinic | Care Plan | `{category, title, frequency: daily\|weekly\|once\|as_needed, times?, daysOfWeek?, dueDate?, instructions?}` → 201 |
| PATCH / DELETE | `/api/care/tasks/:taskId` | clinic | Care Plan | change / retire a duty (history kept) |
| GET | `/api/patients/:id/care-plan/checklist?date=` | caregiver, family (own), clinic, admin | Care Plan | the day's duties: done / skipped / pending / overdue / missed + as-needed list |
| POST | `/api/care/tasks/:taskId/completions` | caregiver (own patient) | Care Plan | `{slot?, status: done\|skipped, note?, date?}` – ticking again corrects it |
| GET | `/api/patients/:id/care-plan/history?from=&to=&page=&pageSize=` | caregiver, family (own), clinic, admin | Care Plan | adherence per category + completions (max 31 days) |
| GET | `/api/admin/security` | admin | gateway | active / verify-only key ids, rotation due date, token-store counters (no key material) |
| POST | `/api/admin/users/:id/revoke-sessions` | admin | gateway | sign a user out everywhere |

Example check-in body:
```json
{
  "patientId": "P-1001",
  "idempotencyKey": "mob-5b1c...",
  "recordedAt": "2026-10-10T07:30:00+08:00",
  "vitals": { "systolic": 150, "diastolic": 92, "heartRate": 80, "temperatureC": 36.8, "spo2": 96, "bloodGlucose": 140 },
  "medication": { "taken": false, "missed": ["Losartan"] },
  "mobilityStatus": "normal",
  "mood": "neutral",
  "notes": "Slept poorly"
}
```

Example alert rule (`POST /api/alerts/rules`):
```json
{
  "code": "HEAT_SENIOR_CENTER",
  "description": "Heat index above 38 C for COPD and heart patients",
  "hazard": "heat",
  "trigger_condition":   { "metric": "heat_index_c", "operator": ">", "value": 38 },
  "vulnerability_target": { "conditions": ["copd", "cardiovascular"], "mobility_restricted": null },
  "action": { "severity": "high", "channels": ["sms", "in_app"], "create_clinic_item": true, "cooldown_hours": 24 }
}
```
`metric`: `heat_index_c`, `temperature_c`, `humidity`, `wind_ms`; `operator`: `>`, `>=`, `<`, `<=`;
`include_advisories: true` (storm rules) also fires on official typhoon advisories and severe weather codes.
An empty `vulnerability_target` targets everyone in the area.

Errors are JSON: `{ "error": "<code>", "message": "..." }` (+ `details[]` for 422, `requestId` for 5xx).
Every response carries `X-Request-Id`, which appears in every service's structured logs.

---

### Triage rules (Routine vs Urgent)

Every queue item gets a total score (0–100) from health (latest check-in), environment (weather) and clinic records (EMR), then a priority:

| Priority | Category | Rule (first match wins) |
|---|---|---|
| P4 | Routine | health score **= 0** and environment score **= 0** (normal vitals, no weather risk) |
| P1 | Urgent | health score **≥ 85** (critical vitals), whatever the total |
| P1 | Urgent | total **≥ 85** |
| P2 | High | total **65–84** |
| P3 | Watch | total **35–64** |
| P4 | Routine | total **< 35** |

* A **normal check-in** (no anomalies) publishes `checkin.normal`; the clinic service sets the health score of the patient's open case to 0 and re-classifies it (this fixes "patient stays URGENT after normal vitals"). It never opens a new case.
* Out-of-order events are ignored: an older check-in cannot overwrite a newer one (`health_at`).
* Weather risk expires after `ENV_RISK_TTL_HOURS` (24 h) without a new weather event.
* The queue is sorted by priority, then total score; `GET /api/clinic/queue` returns the thresholds.

### Visits and Recent Visits

* "Schedule visit" opens a form; the API validates a real date, `HH:MM` time (Manila), visit type, destination (2–120 chars) and location (3–300 chars). Not in the past, at most 180 days ahead, home/clinic visits between 06:00 and 19:59. Setting a case to `scheduled` without a visit is rejected (422).
* **Recent Visits trigger:** a visit appears under Recent Visits when a nurse marks it **completed** (`PATCH /api/clinic/visits/:id {status:"completed"}`); it stays there for `RECENT_VISIT_DAYS` (30). `completed + resolveCase:true` also resolves the case; `no_show`/`cancelled` re-open it.
* **Case history:** resolving or dismissing a case stores `resolved_at`, `resolved_by`, `resolution_notes`; `GET /api/clinic/queue/history` lists them with their follow-ups and visits.

---

## 5. Security (Section 12)

- **OAuth 2.0 + JWT:** short-lived access tokens (15 min default) and refresh tokens signed with a separate secret. HS256 by default; set `JWT_ALGORITHM=RS256` + `JWT_PUBLIC_KEY` to verify tokens from an external IdP (Keycloak, Auth0, Cognito).
- **Strict verification:** algorithm whitelist (blocks `alg=none`), key chosen by the header's `kid`, issuer, audience, expiry, token type (`refresh` tokens can't call APIs), known role.
- **Revocation and rotation (Batch 2, [docs/SECURITY.md](docs/SECURITY.md)):** `jti` deny-list, `POST /oauth/revoke` and `/oauth/logout`, refresh-token rotation with reuse detection (a replayed refresh token ends the session), admin "sign out everywhere", `kid`-based signing keys with a 90-day rotation schedule.
- **RBAC at the gateway** (`roleMiddleware.js`) + **patient scoping** for caregivers/families from the `patients` claim. Services re-check scope as defence in depth.
- **Internal trust:** services accept requests only with `X-Internal-Token`; client-supplied `X-User-*` headers are stripped and replaced by the gateway.
- **Brute-force protection:** 20 failed logins / 15 min per IP; 300 API requests / min per IP (tune `RATE_LIMIT_*`).
- **Secrets outside the code:** `OPENWEATHER_API_KEY`, `TEXTBEE_*`, `RABBITMQ_PASSWORD`, JWT secrets, DB passwords come from env vars or **Docker secrets** (`NAME_FILE=/run/secrets/name`, `docker-compose.secrets.yml`, `npm run secrets:generate`). `.env` and `secrets/` are git-ignored. Logs redact `authorization`, `password`, `token`, `phone`, `appid`.
- **Transport/at rest:** terminate TLS at the load balancer in front of the gateway; set `DB_SSL=true` for managed Postgres (e.g. AWS RDS with storage encryption = AES-256).
- **Helmet** security headers and CORS allow-list (`CORS_ORIGINS`).

---

## 6. Weather mashup (Section 11)

`services/alert-service/src/weatherAlertMashup.js`

1. Every `WEATHER_POLL_INTERVAL_MINUTES` the alert service asks the check-in service for the distinct monitored zip codes.
2. `fetchWeatherByZip(zip, 'PH')` calls OpenWeatherMap current weather (falls back to patient coordinates if OWM has no record for the zip; optional One Call 3.0 advisories with `OPENWEATHER_ONECALL_ENABLED=true`).
3. The response is normalised into an internal risk profile; heat index = max(OWM `feels_like`, NOAA heat index from temp + humidity).
4. The thresholds are **alert rules** managed by admins (`/api/alerts/rules`). Each enabled weather rule is evaluated against the profile; for each hazard, a patient gets only the most severe matching rule's warning (SMS + in-app, once per `cooldown_hours`) and, if `create_clinic_item`, a preventive Clinic Risk Queue item. Seeded rules:
   * `WEATHER_HEAT`: heat index **> 40 °C** → hypertension / cardiovascular / heart disease / diabetes / kidney disease / COPD, severity high, once per day.
   * `WEATHER_HEAT_EXTREME`: heat index **≥ 52 °C** (PAGASA *extreme danger*) → same patients, severity critical.
   * `WEATHER_STORM`: wind ≥ 17.2 m/s, typhoon/storm advisory or severe condition code → mobility-restricted patients, evacuation-prep SMS, every 6 h.
5. Change a threshold without redeploying: `PATCH /api/alerts/rules/WEATHER_HEAT {"trigger_condition": {"metric": "heat_index_c", "operator": ">", "value": 38}}`.
6. **Resilience:** results cached per zip for 60 min (rate limits); if OWM is down, the last cached data up to 24 h old is used and the outage is logged.

Try it without a database:
```bash
cd services/alert-service && npm install
OPENWEATHER_API_KEY=xxx node src/weatherAlertMashup.js --zip 1012 --country PH
OPENWEATHER_API_KEY=xxx TEXTBEE_API_KEY=... TEXTBEE_DEVICE_ID=... SMS_DRY_RUN=false SMS_RECIPIENT_ALLOWLIST=+63917XXXXXXX \
  node src/weatherAlertMashup.js --zip 1012 --country PH --threshold 30 --send-to +63917XXXXXXX
```

---

## 6b. SMS via TextBee

TextBee turns an Android phone into the SMS gateway. The alert service sends:

```http
POST https://api.textbee.dev/api/v1/gateway/send-sms
x-api-key: <TEXTBEE_API_KEY>
Content-Type: application/json

{ "deviceId": "<TEXTBEE_DEVICE_ID>", "recipients": ["+639171234567"], "message": "[ElderCare Connect] ALERT for ..." }
```

(`src/textbeeClient.js`, called by the RabbitMQ SMS worker `src/smsWorker.js`; 4xx except 408/429 are permanent → DLQ; a timeout is *ambiguous* → `unconfirmed` + DLQ so no duplicate SMS is sent.)

Setup (`services/alert-service/.env`, never commit it):
```
SMS_PROVIDER=textbee
TEXTBEE_API_KEY=<from textbee.dev dashboard>
TEXTBEE_DEVICE_ID=<your device id>
SMS_DRY_RUN=false
SMS_RECIPIENT_ALLOWLIST=+63917XXXXXXX     # your own number(s) while testing
```
Safety: the demo contacts (+63917555010x) are not real people's phones, so outside `NODE_ENV=production` only allow-listed numbers receive real texts; everything else is logged as *Simulated*. `SMS_DAILY_LIMIT` stops sending before the free-plan cap. The clinic profile page shows the current mode under **SMS alert contacts**.

Optional webhook (delivery receipts + caregivers texting in): in the TextBee dashboard add `https://<public gateway>/webhooks/textbee` with a secret and put the same value in `TEXTBEE_WEBHOOK_SECRET`. The gateway verifies the signature and the **Node-RED content-based router** routes each message ([docs/NODE_RED.md](docs/NODE_RED.md)):

| Caregiver / family texts | Result |
|---|---|
| `CHECKIN P-1001 BP 150/90 HR 80 T 36.8 O2 96 MED Y` (or just `BP 150/90 …`) | check-in saved (same saga as the app), reply with the result |
| `SOS …` / `EMERGENCY` / `SAKLOLO` | critical alert to the patient's other contacts, reply "call 911 if life is in danger" |
| `STOP` / `START` | SMS alerts off / on for that number |
| `HELP` / `TULONG` / `?` | format help |

A message TextBee delivers twice (same `smsId`) is handled once. `TEXTBEE_WEBHOOK_TARGET=alert` bypasses Node-RED (check-ins and receipts only).

---

## 7. Failure handling

| Failure | Behaviour |
|---|---|
| TextBee down / carrier error | SMS retried via RabbitMQ retry queues (5 s, 30 s, 2 min) then parked in `alert-service.sms-dispatch.dlq`; permanent errors (invalid number, bad key) go straight to the DLQ; in-app alert already delivered |
| RabbitMQ down | check-ins still succeed; events wait in each service's outbox and are published when the broker returns |
| OpenWeatherMap down | stale cache (≤ 24 h) used, outage logged; health endpoint shows last fetch |
| Alert or Clinic service down | check-in still succeeds (201); its events wait in the service's durable queue and drain after restart |
| Any service slow/down behind gateway | per-service circuit breaker → fast 503 instead of hung requests; GETs retried, POSTs never auto-retried |
| Legacy EMR down / slow | adapter returns 502/503; clinic queue keeps working without EMR enrichment |
| Duplicate event delivery | consumers de-duplicate on `eventId` |
| Phone offline (rural) | mobile app stores check-ins locally and syncs later; `idempotencyKey` prevents duplicates |
| No mobile data at all | caregiver texts the check-in to the TextBee phone; TextBee's webhook creates it and replies with the result |

Simulate: `docker compose stop alert-service`, submit a critical check-in, watch `alert-service.checkin-events` grow in the RabbitMQ UI, restart it and watch it drain.
Slow EMR: `MOCK_EMR_DELAY_MS=8000 docker compose up -d mock-legacy-emr`.

---

## 8. Testing (Section 13)

| Layer | Tool | Asset |
|---|---|---|
| Unit | `node --test` | `*/test/*.test.js` – 60 tests: vitals + patient validation, anomaly rules, heat index, triage thresholds, visit validation, TextBee client + webhook signature, SMS parsing, EMR mapping, gateway auth/RBAC |
| End-to-end smoke | Node script | `testing/e2e-smoke.mjs` (`npm run smoke`) – 41 checks through the gateway (incl. triage de-escalation, visits, history, medicines, onboarding) |
| Weather demo / failure | fake OpenWeatherMap | `testing/mocks/fake-openweathermap.js` – heatwave + typhoon on demand, no API key |
| Functional + security | Postman | `testing/postman/ElderCare_Connect.postman_collection.json` (folders 0–4) |
| Integration (saga) | Postman / Newman | folder **5. Integration** – check-in → family alert → clinic queue → EMR history → triage update |
| v1.1 features | Postman / Newman | folder **6. v1.1** – normal vitals de-escalate, schedule/complete visit, Recent Visits, case history, medicines, onboarding |
| SMS without a phone | fake TextBee | `testing/mocks/fake-textbee.js` – accepts `x-api-key: test-key`, `GET /__sent` lists messages |
| Legacy SOAP | SoapUI | `testing/soapui/ElderCare_Legacy_EMR-soapui-project.xml` |
| Load / stress | JMeter | `testing/jmeter/ElderCare_Connect_Load_Stress.jmx` |

See `testing/README.md` for exact commands.

---

## 9. Configuration reference

Every service has a `.env.example`. Most important:

| Variable | Where | Purpose |
|---|---|---|
| `JWT_SECRET`, `JWT_REFRESH_SECRET` | gateway | token signing (≥ 32 random chars); `*_FILE` variants for Docker secrets |
| `JWT_KID`, `JWT_PREVIOUS_KEYS`, `JWT_REFRESH_KID`, `JWT_PREVIOUS_REFRESH_KEYS` | gateway | active signing key id + verify-only keys during a rotation (docs/SECURITY.md) |
| `JWT_KEY_ROTATED_AT`, `JWT_KEY_ROTATION_DAYS` | gateway | rotation schedule shown by `GET /api/admin/security` (default every 90 days) |
| `REFRESH_REUSE_GRACE_SECONDS` | gateway | parallel refreshes within this window are not treated as token theft (default 10) |
| `TOKEN_STORE_FILE` | gateway | revoked tokens + refresh sessions (Docker: `gateway-state` volume); `memory` = not persisted |
| `TEXTBEE_WEBHOOK_TARGET`, `NODE_RED_URL` | gateway | `node-red` (Docker default: verify signature, route via Node-RED) or `alert` (direct) |
| `DASHBOARD_USER`, `DASHBOARD_PASSWORD` | node-red | DLQ dashboard sign-in; empty password = dashboard closed |
| `NODE_RED_ADMIN_PASSWORD`, `NODE_RED_PORT` | node-red | flow editor at `/admin` (empty = editor disabled); host port (default 1880, bound to 127.0.0.1) |
| `INTERNAL_SERVICE_TOKEN` | all | gateway ↔ service trust (same value everywhere) |
| `DATABASE_URL` | checkin, alert, clinic | own PostgreSQL database |
| `OPENWEATHER_API_KEY` | alert | weather mashup |
| `SMS_PROVIDER` | alert | `textbee` or `none` (empty = auto) |
| `EVENT_TRANSPORT`, `AMQP_URL` | checkin, alert, clinic | `rabbitmq` + broker URL (Docker default) or `http` fallback |
| `RABBITMQ_USER`, `RABBITMQ_PASSWORD` | compose | broker login (vhost `eldercare`) |
| `SMS_RETRY_DELAYS_MS`, `SMS_RETRY_ON_TIMEOUT` | alert | SMS retry tiers; resend after an ambiguous timeout (default `false`) |
| `TEXTBEE_API_KEY`, `TEXTBEE_DEVICE_ID` | alert | TextBee SMS gateway (Android phone) |
| `TEXTBEE_WEBHOOK_SECRET` | alert | verifies `/webhooks/textbee` (HMAC-SHA256 of the raw body, `X-Signature`) |
| `SMS_RECIPIENT_ALLOWLIST` | alert | numbers that may get **real** texts; empty outside production = all simulated |
| `SMS_DAILY_LIMIT` | alert | real SMS per day (default 40; TextBee free plan is 50/day) |
| `SMS_DRY_RUN` | alert | `true` = log instead of send |
| `ENV_RISK_TTL_HOURS`, `RECENT_VISIT_DAYS`, `VISIT_TZ_OFFSET` | clinic | weather-risk expiry (24), Recent Visits window (30), visit time zone (+08:00) |
| `LEGACY_EMR_URL` | adapter | partner RHU SOAP endpoint |
| `ANOMALY_*` | checkin | clinical thresholds – have the partner RHU physician approve them |

---

## 10. Deploying to the cloud (Section 14)

Single VM (EC2 / Azure VM / GCP): `docker compose -f docker-compose.yml -f docker-compose.cloud.yml up -d --build`. Only the gateway is exposed (on 127.0.0.1, behind a TLS proxy); databases, RabbitMQ and internal services stay private. Full walkthrough: `docs/SUBMISSION_GUIDE.md` §2.

Managed AWS outline:

- Build/push each image to ECR; run each as an ECS Fargate service (2+ tasks each for availability).
- Only the gateway sits behind a public Application Load Balancer (HTTPS via ACM). Services live in private subnets and reach each other through ECS Service Connect / Cloud Map names (`http://checkin-service:4001`, …).
- Three RDS PostgreSQL instances (or three databases on one instance for a student budget), `DB_SSL=true`, encryption at rest on.
- Amazon MQ for RabbitMQ (or a RabbitMQ container on the VM). Secrets in AWS Secrets Manager injected as env vars.
- Point the TextBee webhook at `https://<your-domain>/webhooks/textbee`.

---

## 11. Troubleshooting

| Symptom | Fix |
|---|---|
| `Missing required environment variable` on start | copy `.env.example` to `.env` and fill it in |
| 401 `invalid_token` | token expired (15 min) → use refresh grant; or gateway restarted with a different `JWT_SECRET` |
| 403 from gateway | role not allowed, or patient not in your token's `patients` claim |
| 401 `Missing or invalid internal service token` from a service | `INTERNAL_SERVICE_TOKEN` differs between gateway and service |
| 429 during JMeter runs | raise `RATE_LIMIT_MAX` for the test |
| SMS not arriving | `SMS_DRY_RUN=true` (default), number not in `SMS_RECIPIENT_ALLOWLIST`, TextBee phone offline, or the message is in `alert-service.sms-dispatch.dlq` (`GET /api/admin/messaging`) |
| `weather-check` returns 503 | `OPENWEATHER_API_KEY` not set (new keys can take up to 2 h to activate) |
| Clinic queue empty after a check-in | `GET /api/admin/messaging`: checkin `outbox.pending` = broker unreachable; messages in `clinic-risk-service.events` = clinic service down; a `.dlq` count = failed processing (replay after fixing) |

## Disclaimer
Anomaly thresholds and risk weights are screening heuristics for a student prototype, not a medical device.
Clinical rules must be validated by licensed clinicians before real-world use, and real deployments must
comply with the Philippine Data Privacy Act (RA 10173) – including a privacy impact assessment and consent
for every SMS recipient.

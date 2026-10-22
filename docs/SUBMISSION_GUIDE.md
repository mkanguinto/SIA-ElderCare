# Submission Guide – Frontend, Cloud, Middleware, Load Testing, CI/CD

How to run, demonstrate and explain each part of ElderCare Connect v2.
For the proposal-by-section checklist see `PROPOSAL_TRACEABILITY.md`; for the evaluation items see
`EVALUATION_RESPONSE.md`.

v2 replaced Twilio with **TextBee** (an Android phone as the SMS gateway) and BullMQ/Redis with **RabbitMQ**.
It also added **Node-RED** for the integration flows.

---

## 1. Frontend interfaces

### React web app – `frontend/web`
| View | File | Role | Gateway endpoints used |
|---|---|---|---|
| Login | `src/pages/Login.jsx` | all | `POST /oauth/token` |
| Caregiver Check-In | `src/pages/CaregiverCheckIn.jsx` | caregiver | `POST /api/checkins`, `GET /api/patients/:id/history` |
| Care Duties | `src/pages/CareDuties.jsx` | caregiver | `GET …/care-plan/checklist`, `POST /api/care/tasks/:id/completions` |
| Family Dashboard | `src/pages/FamilyDashboard.jsx` | family_member | `/history`, `GET /api/alerts/notifications`, care checklist + adherence |
| Clinic Portal | `src/pages/ClinicQueue.jsx`, `PatientProfile.jsx`, `CaseHistory.jsx` | clinic_staff, system_admin | queue, visits, case history (paged), EMR history, care plan editor |
| Alert Rules | `src/pages/AlertRules.jsx` | admin (edit), clinic (read) | `GET/POST/PATCH/DELETE /api/alerts/rules` |
| Admin View | `src/pages/AdminView.jsx` | system_admin | `/api/admin/health`, `/api/admin/users`, `/api/admin/security`, `POST /api/admin/users/:id/revoke-sessions`, link to the Node-RED DLQ dashboard |

How tokens are handled (`src/api.js`):
- Login stores the access and refresh tokens in `sessionStorage`, which is cleared when the tab closes.
- Every request sends `Authorization: Bearer …`.
- On a 401 the app refreshes the token once and retries. Parallel requests share **one** refresh, because
  the gateway rotates refresh tokens and treats a reused one as theft (`docs/SECURITY.md`).
- **Sign out** revokes the session on the server (`POST /oauth/revoke`), so the tokens stop working at once.
- The role is read from the JWT, and `main.jsx` routes each role to its own pages. The server still
  enforces RBAC; client-side routing only decides which pages to show.

```powershell
cd frontend\web
npm install
npm run dev          # http://localhost:3000  (proxies /api and /oauth to the gateway on :8080)
npm run build        # production bundle in dist/
```
For production, serve `dist/` on the same domain as the gateway, or set `VITE_API_BASE_URL` and add the
site to the gateway's `CORS_ORIGINS`. `VITE_DLQ_DASHBOARD_URL` changes the Admin View's link to the
Node-RED dashboard (default `http://localhost:1880/dlq`).

### React Native caregiver app – `frontend/mobile/App.js`
- **Check-in tab:** blood pressure, heart rate, temperature, SpO₂, medication taken/missed, fall flag and notes.
- **Duties tab:** today's care-plan checklist; tap **Done** to tick a duty off.
- **Offline-first:** check-ins and duty ticks made without a connection are saved on the phone and synced
  when the app returns to the foreground. Check-ins carry an `idempotencyKey`, and a duty tick is one
  record per task + day + time, so a replay never creates a duplicate.
```powershell
cd frontend\mobile
npm install
npx expo start       # scan the QR code with Expo Go
```
Set `expo.extra.apiBaseUrl` in `app.json` to your PC's LAN IP (e.g. `http://192.168.1.10:8080`). The phone
and PC must be on the same Wi-Fi, and the firewall must allow port 8080.

### SMS (no app, no internet) – TextBee + Node-RED
A caregiver whose number is registered as an SMS contact texts the TextBee phone. The gateway verifies
TextBee's signature, and the Node-RED **content-based router** sends each text to the right action
(`docs/NODE_RED.md`):

| Text | Result |
|---|---|
| `CHECKIN P-1001 BP 150/90 HR 80 T 36.8 O2 96 MED Y` | check-in saved; reply "Saved check-in for P-1001. All readings normal." or the anomaly summary |
| `SOS …` / `EMERGENCY` / `SAKLOLO` | critical alert to the patient's family; reply "call 911 if life is in danger" |
| `STOP` / `START` | SMS alerts off / on for that number |
| `HELP` / `TULONG` | the format |

Setup: in the TextBee dashboard → Webhooks, add `https://<public gateway>/webhooks/textbee` with a
secret, and put the same secret in `.env` as `TEXTBEE_WEBHOOK_SECRET`. Locally you can expose the gateway
with a tunnel such as ngrok, or simulate a text without a phone:
```bash
TEXTBEE_WEBHOOK_SECRET=<same value> node testing/mocks/send-sms.mjs +639175550102 "CHECKIN P-1001 BP 150/90 HR 80 MED Y"
```

---

## 2. Cloud deployment

### Files
- `*/Dockerfile`: `node:20-alpine` (Node-RED: `nodered/node-red:4.1.7-22`), production dependencies only
  via `npm ci`, non-root user, HEALTHCHECK.
- `docker-compose.yml`: the full local stack.
  - Four PostgreSQL databases (check-in, alert, clinic, care plan), each with its own non-superuser login.
  - RabbitMQ with its management UI.
  - Node-RED.
  - The gateway, five services, the SOAP adapter and the mock EMR.
- `docker-compose.cloud.yml`: production overrides for a single cloud VM.
  - Databases, RabbitMQ, the adapter and the mock EMR are not reachable from outside.
  - The gateway binds to `127.0.0.1:8080` behind a TLS proxy; Node-RED binds to `127.0.0.1:1880`.
  - `restart: always`, memory limits, log rotation.
  - Demo seed data is off by default.
- `docker-compose.secrets.yml`: Docker secrets for the JWT keys and the internal service token
  (`npm run secrets:generate`).

### Single-VM deployment (AWS EC2 / Azure VM / GCP Compute Engine)
```bash
# on an Ubuntu VM with Docker installed
git clone https://github.com/mkanguinto/SIA-ElderCare.git && cd SIA-ElderCare
cp .env.example .env && nano .env        # strong secrets, RABBITMQ_PASSWORD, OPENWEATHER_API_KEY, TEXTBEE_*,
                                          # TEXTBEE_WEBHOOK_SECRET, DASHBOARD_PASSWORD, SMS_DRY_RUN=false
npm run secrets:generate                  # optional: JWT + internal token as Docker secrets
docker compose -f docker-compose.yml -f docker-compose.cloud.yml -f docker-compose.secrets.yml up -d --build
docker compose ps                         # all services "healthy"
```
Put HTTPS in front of the gateway. The simplest option is Caddy
(`caddy reverse-proxy --from api.yourdomain.com --to 127.0.0.1:8080`), which gets a free TLS certificate
automatically. This covers "data in transit" from Risk 2. Open the Node-RED dashboard over an SSH tunnel
(`ssh -L 1880:127.0.0.1:1880 vm`) instead of publishing it.

### Managed AWS option (for the report)
| Proposal component | AWS service |
|---|---|
| API Gateway container | ECS Fargate service behind an Application Load Balancer (HTTPS via ACM) |
| Microservices, adapter, Node-RED | ECS Fargate services in private subnets, 2+ tasks each (Risk 4); Node-RED 1 task |
| 4 PostgreSQL databases | Amazon RDS for PostgreSQL with storage encryption (AES-256, Risk 2) |
| RabbitMQ | Amazon MQ for RabbitMQ (managed broker, same AMQP 0-9-1 protocol) |
| Secrets | AWS Secrets Manager mounted as files (`*_FILE`) or task environment variables |
| Gateway token store | ElastiCache or RDS behind the `TokenStore` interface once there is more than one gateway task |
| Logs | CloudWatch Logs (the services already emit structured JSON) |
| SMS | TextBee (Android phone at the health center) – no AWS equivalent needed |
| Legacy EMR at the RHU | stays on-prem; reached over Site-to-Site VPN (hybrid cloud, Section 14) |

---

## 3. Middleware and external integrations – verified data flows

Measured on 2026-10-22 against the Docker stack (PostgreSQL 16, RabbitMQ 3.13, all services) unless noted.

### A. Check-in → Alert → Clinic Queue (saga over RabbitMQ)
```
Caregiver ──POST /api/checkins──► Gateway (JWT ✓, role ✓, patient scope ✓)
   └─► Check-In service: validate → detect anomalies → ONE transaction { insert check-in, insert outbox row }
          └─► outbox relay ──publish (confirms)──► exchange eldercare.events  (checkin.anomaly_detected)
                 ├─► queue alert-service.checkin-events       → alert + in-app + notification.sms.requested
                 └─► queue clinic-risk-service.events          → upsert triage item, weighted score
```
- **Measured:** a critical check-in reached the family alert feed in **95 ms** and the clinic queue (P1)
  in **39 ms** (`npm run smoke`). The objective is ≤ 2.0 s.
- **Resilience (re-run on v2):** with the alert service stopped, a critical check-in still returned
  `201`. The event waited in the durable queue `alert-service.checkin-events` (1 message). After the
  service restarted, the family alert appeared at once.
- **Idempotency:** consumers record each `eventId` in the same transaction as their work, so a
  redelivered event never alerts twice. The same `idempotencyKey` returns the original check-in.
- **Failures:** transient errors go through retry queues at 5 s, 30 s and 2 min, then to a dead-letter
  queue. Contract errors go straight to the DLQ. Replay from the Node-RED dashboard (`docs/MESSAGING.md`).

### B. OpenWeatherMap × patient zip codes (rule-driven mashup, orchestrated by Node-RED)
```
Node-RED every 30 min (or "Run now" on the dashboard)
  └─► GET checkin-service /internal/locations          (distinct zip codes of monitored patients)
      split per zip → throttle 1 request / 2 s
      └─► alert-service weather-check {zipCode}
            weather_cache fresh (< 60 min)? ── yes ─► use cache
                                              no ──► GET api.openweathermap.org/data/2.5/weather?zip=<zip>,PH
                                                      └─ fails? use cached data ≤ 24 h, log outage
            normalise → risk profile (heat index = max(OWM feels_like, NOAA formula))
            evaluate the enabled alert rules (admin CRUD, /api/alerts/rules):
              WEATHER_HEAT         heat index > 40 °C → hypertension / cardiovascular / diabetes / kidney / COPD
              WEATHER_HEAT_EXTREME heat index ≥ 52 °C → same patients, critical
              WEATHER_STORM        wind ≥ 17.2 m/s or advisory → mobility-restricted patients
              (most severe matching rule per hazard; once per cooldown_hours)
              └─► SMS + in-app warning + clinic triage item (weather.risk_detected), in one outbox transaction
      aggregate → run summary on the dashboard
```
- **Measured on v2:** the orchestration ran over the 4 monitored zip codes with the real OpenWeatherMap
  API and reported `ok` (no rule fired that evening). Changing a threshold is
  `PATCH /api/alerts/rules/WEATHER_HEAT`; there is no redeploy.

**Measured in v1.1 with the fake OWM server** (same thresholds, which are now rules):
| Zip | Fake weather | Result |
|---|---|---|
| 1012 | 34 °C, 70 % RH → heat index 46.8 °C | P-1001 (hypertension, cardiovascular): warned, clinic item P1 |
| 1119 | 24 m/s wind, heavy rain | P-1002 (mobility-restricted): warned, clinic item P2 |
| 1008 | normal | P-1003: no action |
| second run | | served from cache (no API call), duplicate alerts suppressed |
| fake OWM stopped, cache aged 3 h | | `cache=stale`, mashup still ran, outage logged |

**Demo it in the defense:**
```bash
node testing/mocks/fake-openweathermap.js          # listens on :4999
# .env: OPENWEATHER_API_KEY=demo-key  OPENWEATHER_BASE_URL=http://host.docker.internal:4999
docker compose up -d alert-service                  # picks up the new settings
# then open http://localhost:1880/dlq and click "Run now", or "Run weather check" in the Clinic Portal
```

### C. SMS through RabbitMQ to TextBee
```
dispatchAlert() → alerts row (in-app, delivered immediately)
               → notification_log row per subscriber (status queued) + notification.sms.requested in the outbox
outbox relay → queue alert-service.sms-dispatch → SMS worker (prefetch 1)
   claim queued → sending (atomic; terminal states are never resent)
   TextBee POST /gateway/send-sms
     success                 → sent (later delivered / failed through the webhook receipt)
     408 / 429 / 5xx         → retry queues 5 s → 30 s → 2 min → DLQ
     other 4xx               → failed, DLQ (permanent)
     timeout after sending   → unconfirmed, DLQ: an operator checks the phone before replaying,
                               so no duplicate SMS
   the in-app alert is the fallback channel throughout
```
Covered by `services/alert-service/test/smsWorker.test.js` and `messaging.test.js` (state machine,
retry tiers, DLQ, replay). `testing/mocks/fake-textbee.js` with `FAKE_TEXTBEE_FAIL=503` reproduces an
outage end to end.

### D. Caregiver duties (care-plan service)
Clinic staff build a plan from eight duty categories based on caringinfo.org's caregiver-duties list
(`docs/CARE_PLAN.md`). The caregiver ticks duties off in the web or mobile app. Family and clinic see
today's checklist and adherence per category. Verified by 18 smoke checks, covering role and scope rules,
upsert on a second tick, skip reasons and retired tasks.

---

## 4. Load and stress testing with JMeter

Plan file: `testing/jmeter/ElderCare_Connect_Load_Stress.jmx`

| Thread group | Simulates | Default |
|---|---|---|
| setUp | obtains caregiver and nurse tokens once, shared via JMeter properties | 1 thread |
| LOAD – Caregiver check-in rush | morning/evening check-ins with random vitals | 50 users, 60 s ramp-up, 300 s |
| LOAD – Clinic queue reads | nurses reading the queue (paged), history, visits, medicines, alert rules, care checklist and adherence | 10 users |
| STRESS – Typhoon spike (disabled) | abnormal vitals → alerts + queue updates | 500 users, 120 s ramp-up, 600 s |

Assertions: HTTP 201/200 and response time ≤ 2000 ms (Section 4 objective).

**Before you run it:**
1. The gateway allows 300 requests/min per IP by default. For the test, set `RATE_LIMIT_MAX=100000` and
   `JWT_ACCESS_TTL=120m` in `.env`, then run `docker compose up -d api-gateway`. Set them back afterwards.
2. Close other heavy apps. JMeter and the whole stack share your CPU, so record your machine specs in the
   report.

```powershell
# Load test (CLI mode = accurate numbers; the GUI is only for editing)
jmeter -n -t testing\jmeter\ElderCare_Connect_Load_Stress.jmx -Jusers=50 -JclinicUsers=10 -Jduration=300 -l testing\jmeter\results\load.jtl -e -o testing\jmeter\results\load-report
```
For the stress test, open the plan in the GUI, enable **STRESS – Typhoon alert spike**, disable the two
LOAD groups, save, then:
```powershell
jmeter -n -t testing\jmeter\ElderCare_Connect_Load_Stress.jmx -JstressUsers=300 -JstressRampUp=120 -JstressDuration=300 -l testing\jmeter\results\stress.jtl -e -o testing\jmeter\results\stress-report
```
Increase `stressUsers` (300 → 500 → 800) until the error rate rises above 1 % or p95 latency goes above 2 s.
Watch the RabbitMQ UI (<http://localhost:15672>) during the spike: queues should grow and drain rather than
fail.

**What to report** (from `load-report/index.html`):
- Throughput (requests/s)
- Average, p90, p95 and p99 latency per endpoint
- Error %
- The user count where the system started to degrade, which is your breaking point

Link the breaking point to Section 14: "beyond N concurrent users we would scale the check-in service horizontally".

---

## 5. CI/CD – `.github/workflows/ci.yml`

Runs on every push to `main`, `feature/**` and `fix/**`, and on pull requests to `main`:

| Job | What it proves |
|---|---|
| `contracts-in-sync` | every service's copy of the shared code and event contracts matches `shared/` and `contracts/` |
| `unit-tests` (matrix of 7 packages) | `npm ci` from the lockfiles + `npm test` (110 unit tests: gateway 29, alert 38, clinic 13, check-in 12, care plan 8, Node-RED 8, adapter 2) |
| `frontend-build` | the React web app compiles (`vite build`) |
| `docker-build` (after unit tests) | every Dockerfile builds |
| `integration` (after docker-build) | starts the full stack, runs the Postman collection with Newman, then `testing/e2e-smoke.mjs` (all batches, including the signed TextBee webhook and the DLQ dashboard) |

To show it in the defense:
1. Push to GitHub.
2. Open the **Actions** tab and show the green run.
3. Optionally, protect `main` (Settings → Branches → require status checks) so pull requests can only
   merge when CI passes. This matches the workflow in Section 16.

---

## Demo script (about 12 minutes)

1. **Admin View:** all services up, circuit breakers closed, sign-in security (key ID, rotation date,
   sessions), users and roles. Open the **DLQ dashboard**: queues empty, last weather run, SMS router counts.
2. **Caregiver** (phone app or web): submit normal vitals, then BP 186/118 with medication missed. Open
   **Care duties** and tick off "Give morning medicines".
3. **Family Dashboard:** the critical alert appears; show that the SMS was queued (alert-service log).
   Below it, the caregiver's duties for today and the adherence bars.
4. **Clinic Portal:** P1 item at the top with its score breakdown. Open the patient to show the legacy EMR
   history (SOAP translated to JSON) and the **care plan editor**; add a duty from a suggestion.
5. **Alert rules:** lower `WEATHER_HEAT` to 30 °C, click **Run now** on the DLQ dashboard (or use the fake
   OWM server), and the heat warnings and triage items appear. Set the rule back.
6. **SMS:** `node testing/mocks/send-sms.mjs +639175550102 "SOS nahulog si lola"` → the critical family alert
   appears; `… +639175550101 STOP` turns that number's SMS alerts off.
7. **Resilience:** `docker compose stop alert-service`, submit a check-in (still 201), show the waiting
   message in the RabbitMQ UI, `docker compose start alert-service`, and the alert arrives.
8. **Security:** in Postman, family → clinic queue = 403, a tampered token = 401, a reused refresh token
   ends the session, logout makes the old token fail.
9. **CI:** show the green GitHub Actions run.

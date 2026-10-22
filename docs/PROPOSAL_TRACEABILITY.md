# Proposal → Implementation Traceability

Every commitment in the project proposal (*ElderCare Connect – Project Proposal*, TIP Manila, SIA 1)
mapped to where it is implemented and how it was verified.

Legend: ✅ implemented and verified · ◑ implemented, verification is manual or deployment-time · ⬜ documented only (out of scope for a prototype)

Updated for v2 (Batches 1–5): RabbitMQ replaced BullMQ/Redis, TextBee replaced Twilio, Node-RED added for the
integration flows, and the Care Plan Service added for caregiver duties. Evidence was re-run on 2026-10-22
against the Docker stack.

## Section 4 – Specific objectives

| Objective | Status | Where / evidence |
|---|---|---|
| Integrate the 3 microservices with REST + JSON | ✅ | `services/*/src/routes.js`; services call each other only via REST (`/internal/*`) and events |
| API Gateway as single secure entry point | ✅ | `api-gateway/server.js`, `src/routes/index.js`, `src/lib/proxy.js` |
| API mashup with an external weather API | ✅ | `services/alert-service/src/weatherAlertMashup.js` – verified with heatwave + typhoon scenarios |
| RBAC + OAuth 2.0 / JWT on all services | ✅ | `authMiddleware.js`, `roleMiddleware.js`, `tokenService.js`; 29 gateway tests (forged, expired, `alg=none`, refresh-as-access, spoofed headers, revocation, refresh reuse, key rotation) |
| Evaluate resilience, mediation, load, degradation with Postman, JMeter, SoapUI | ✅ | `testing/postman`, `testing/jmeter`, `testing/soapui`, failure scenarios in `testing/README.md` |
| End-to-end check-in → family alert → clinic queue **≤ 2.0 s** | ✅ | Measured **95 ms** (family alert) and **39 ms** (clinic P1) over RabbitMQ (`npm run smoke`, Postman folder 5) |
| Each service owns its data; exposed only via REST | ✅ | Separate DB and non-superuser login per service (4 databases); `npm run verify:db-isolation` shows every cross-service login is refused |

## Section 5 – Stakeholders → interfaces

| Stakeholder | Interface | Status |
|---|---|---|
| Primary Caregiver | React Native app (`frontend/mobile`: check-in + duties), web check-in and **Care duties** pages, **SMS check-in / SOS** | ✅ |
| Family Member / Sponsor | Family Dashboard (`FamilyDashboard.jsx`): trends, alerts, caregiver duties + adherence; SMS alerts with STOP/START | ✅ |
| Clinic Staff / Nurse | Clinic Portal risk queue + legacy EMR history + care plan editor (`ClinicQueue.jsx`, `PatientProfile.jsx`) | ✅ |
| System Administrator | Admin View: service health, circuit breakers, accounts and roles, sign-in security, "sign out everywhere"; Alert Rules; Node-RED DLQ dashboard | ✅ |

## Section 7 – TO-BE architecture (including the "Note on Diagram Flow")

| Item | Status | Notes |
|---|---|---|
| Client tier → API Gateway → services → own databases | ✅ | `docker-compose.yml`: gateway, 4 data-owning services with 4 PostgreSQL databases, RabbitMQ, Node-RED, SOAP adapter + mock EMR |
| Legacy EMR flow is **inbound** (EMR → Adapter → Clinic Risk Queue) | ✅ | Clinic service pulls history through the adapter (`GET /api/clinic/patients/:id/emr-history`) |
| OpenWeatherMap mashup result feeds the **Clinic Risk Queue** | ✅ | The Alert service queries OWM (Section 11) and sends `weather.risk_detected` to the Clinic service, which creates the preventive triage item |
| Rate limiting and request validation at the gateway | ✅ | `express-rate-limit` (API + brute-force login limits), JSON size limits, per-service validation |

> **Defense tip:** the OpenWeatherMap calls live in the **Family Alert & Notification Service**, exactly as Section 11 says
> ("Periodically queries the OpenWeatherMap API…"). The Clinic Risk Queue **receives** the environmental trigger and
> scores it. Describe it this way, not as "the Clinic service calls OpenWeatherMap".

## Section 9 – Service decomposition

| Service | Responsibility from proposal | Status |
|---|---|---|
| Daily Check-In Logger | validate vitals with range checks, timestamp, trend analysis | ✅ `validation.js`, `anomaly.js`, `/history` trends |
| Family Alert & Notification | SMS/push from internal anomalies **and** weather data; missed check-ins | ✅ events + rule-driven mashup (`alertRules.js`) + `missedCheckinJob.js` + TextBee SMS worker |
| Clinic Risk Queue | weighted score: internal severity + environmental exposure | ✅ `riskScore.js` (base + compounding + vulnerability + EMR) |
| Legacy EMR Adapter | stateless SOAP/XML → JSON | ✅ owns no tables |
| Care Plan (v2 Batch 4) | caregiver duties by category, daily checklist, adherence | ✅ `services/care-plan-service` with its own `care_db` |

## Section 10 – API plan

| Endpoint | Status |
|---|---|
| `POST /api/checkins` | ✅ |
| `GET /api/patients/{id}/history` | ✅ |
| `POST /api/alerts/dispatch` | ✅ |
| `GET /api/clinic/queue` | ✅ |
| SOAP `GetPatientHistory` (XML in → JSON out) | ✅ WSDL at `services/mock-legacy-emr/GetPatientHistory.wsdl` |
| Pagination on batch history endpoints (evaluation item 6) | ✅ `page` / `pageSize` + `pagination` envelope |
| Admin CRUD for alert rules (evaluation item 5) | ✅ `GET/POST/PATCH/DELETE /api/alerts/rules` |

## Section 11 – External API and mashup

| Commitment | Status | Evidence |
|---|---|---|
| Heat index > 40 °C → dehydration SMS to caregivers + preventive clinic item | ✅ | Heat index 46.8 °C → hypertensive patient warned, P1 item (v1.1 fake-OWM run); threshold is now the admin rule `WEATHER_HEAT` |
| Storm advisory → flag **mobility-restricted** patients + clinic item | ✅ | 24 m/s wind → only the mobility-restricted patient flagged, P2 item (v1.1); now rule `WEATHER_STORM` |
| Cache per zip code to respect rate limits | ✅ | 60-minute cache; second run makes no API call |
| OWM unreachable → last cached data, outage logged | ✅ | Stale data up to 24 h used; "using stale cached weather data" logged |
| SMS failure → queued retry + in-app fallback | ✅ | TextBee SMS worker on RabbitMQ: retry 5 s / 30 s / 2 min, then DLQ; a timeout is `unconfirmed` (no duplicate SMS); in-app alert already delivered (`smsWorker.test.js`) |

## Section 12 – Security

| Commitment | Status | Notes |
|---|---|---|
| OAuth 2.0 + JWT bearer tokens | ✅ | `/oauth/token` (password + refresh_token grants); revocation (`/oauth/revoke`, `/oauth/logout`), refresh rotation with reuse detection, `kid` key rotation – `docs/SECURITY.md` |
| RBAC with role claims, domain isolation | ✅ | Family member → clinic queue = 403 (tested) |
| API keys in environment variables | ✅ | Never in code or browser; `.env` git-ignored; logs redact secrets; Docker secrets (`*_FILE`) supported |
| 4 roles | ✅ | caregiver, family_member, clinic_staff, system_admin |
| PII/PHI protection | ◑ | Patient scoping per token; TLS + AES-256 at rest are deployment settings (load balancer + RDS encryption) – see `docs/SUBMISSION_GUIDE.md` §2 |

## Section 13 – Testing strategy

| Layer | Tool | Status |
|---|---|---|
| Functional | Postman | ✅ folders 0–4, 6–9 (95 requests; Postman CLI run: 0 failures) |
| Integration | Postman / Newman | ✅ folder 5 (+ `npm run smoke`, 95 checks across all batches) |
| Legacy/protocol | SoapUI | ✅ 4 test cases incl. WSDL schema compliance and fault mapping (replayed against the v2 stack: all pass) |
| Failure | mock servers + JMeter | ✅ fake OpenWeatherMap (`testing/mocks`), mock EMR delay/failure knobs, service-down scenarios |
| Load | JMeter | ◑ plan provided; run on your machine and record results |
| Stress | JMeter | ◑ plan provided (typhoon spike group) |

## Section 14 – Cloud

| Commitment | Status |
|---|---|
| Containerised services, independently deployable | ✅ one Dockerfile per service |
| Cloud deployment (AWS / Azure / GCP) | ◑ `docker-compose.cloud.yml` for a single VM; ECS/RDS outline in the guide |
| Each service keeps its own DB in the cloud | ✅ |
| Hybrid: legacy EMR stays on-prem behind a secured integration layer | ◑ set `LEGACY_EMR_URL` to the RHU endpoint over VPN / private link |

## Section 15 – EAI and middleware

| Concern | Status | Implementation |
|---|---|---|
| Routing | ✅ | Gateway; clients never see internal addresses |
| Protocol mediation (OWM JSON → risk profile; SOAP → JSON) | ✅ | `weatherRisk.toRiskProfile()`, `emrMapper.js` |
| Message queue for SMS retry | ✅ | RabbitMQ: topic exchange, durable queues, retry tiers, DLQs, publisher confirms (`docs/MESSAGING.md`) |
| EAI flows | ✅ | Node-RED: TextBee content-based router, weather process manager (splitter / aggregator / throttling), DLQ monitor + replay dashboard (`docs/NODE_RED.md`) |
| Logging / monitoring in Admin View | ✅ | Structured JSON logs with request IDs; Admin View health + circuit breakers. A central log store (e.g. CloudWatch) is a deployment choice. |
| Saga across services | ✅ | Transactional outbox + idempotent consumers; v2 re-run: alert service stopped → check-in 201, event held in RabbitMQ, alert delivered after restart |
| Authentication centralised at the gateway | ✅ | Services trust `X-Internal-Token` and gateway-forwarded identity |

## Section 16 – Git / DevOps

| Item | Status |
|---|---|
| Feature branches, PR to `main`, automated tests, build verification | ✅ one branch + PR per batch; `.github/workflows/ci.yml` (shared-code drift check, unit tests ×7 packages, web build, Docker build, Newman + smoke integration run) |

## Section 17 – Interfaces

| Interface | Status |
|---|---|
| Login View | ✅ |
| Caregiver Check-In | ✅ web + React Native + SMS; **care duties** checklist (web + mobile) |
| Family Dashboard | ✅ trends, sparklines, alert feed, caregiver duties + adherence, auto-refresh |
| Clinic Risk Queue | ✅ priority summary, score breakdown, reasons, triage actions, EMR panel, case history (paged), care plan editor |
| Admin View | ✅ service health, circuit breakers, **user accounts & roles**, sign-in security, alert rules, link to the DLQ dashboard |

## Section 20 – Risks

| Risk | Mitigation promised | Status |
|---|---|---|
| 1. External API downtime | 1-day weather store, SMS resend, in-app backup | ✅ |
| 2. Privacy / breaches | OAuth/JWT, TLS, AES-256 at rest, DPIA, weekly log audits | ◑ code-side done; TLS/encryption/DPIA are deployment and process tasks |
| 3. Rural connectivity | offline-first app, sync later, **SMS-based check-in** | ✅ offline queue in the app for check-ins and duty ticks (AsyncStorage, functionally equivalent to SQLite for this queue) + SMS check-in / SOS via TextBee, routed by Node-RED |
| 4. Cascading failures | 2+ instances, circuit breakers, queues, 99 % SLA | ✅ circuit breakers + outbox + queues in code; ◑ replicas at deployment |
| 5. Rate limits | 1-hour cache, throttling, usage monitoring | ✅ weather cache, Node-RED throttle (1 OWM call / 2 s), one SMS at a time + `SMS_DAILY_LIMIT` (TextBee free plan), gateway rate limits |

## Known prototype limits (state them openly in the defense)

- Clinical thresholds are screening heuristics; they need sign-off from a licensed physician.
- Users are stored in `api-gateway/data/users.json`; a production system would use an identity provider (Keycloak, Auth0, Cognito) with RS256 – already supported via `JWT_ALGORITHM=RS256`.
- The gateway's token store (revoked tokens, refresh sessions) is a file on one gateway instance; several gateway replicas would need a shared store (Redis / PostgreSQL) behind the same interface.
- Push notifications to phones are represented by the in-app alert feed; native push (FCM/APNs) is not wired.
- JMeter load/stress numbers depend on your hardware – run the plan and put your own results in the report.

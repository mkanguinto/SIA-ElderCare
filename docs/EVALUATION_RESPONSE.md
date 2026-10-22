# Response to the G6 evaluation (91 / 100) and v2 roadmap

Tools for v2: **RabbitMQ** (message-oriented middleware), **Node-RED** (EAI flows), **TextBee** (SMS).
Twilio and BullMQ/Redis were removed. Work is delivered in batches; each batch is one branch / PR.

## Professor's findings → status

| # | Finding (criterion, deduction) | Fix | Batch | Status |
|---|---|---|---|---|
| 1 | Figure 7 shows top-down flow into the Legacy EMR (TO-BE, −2) | README architecture diagram now shows **inbound** flow: Legacy Clinic EMR ⇒ Legacy Integration Layer ⇒ Clinic Risk Queue Service. *Redraw Figure 7 in the paper the same way.* | 1 | done (code docs) |
| 2 | No message payload schemas, DLQ or worker idempotency (Cloud/EAI/Middleware, −2) | RabbitMQ topology with retry tiers + DLQs, JSON Schemas for every event (`contracts/events/`), idempotent consumers, SMS worker state machine – `docs/MESSAGING.md` | 1 | done |
| 3 | Database isolation: dedicated, non-shared DB credentials | Per-service non-superuser logins (`checkin_svc`, `alert_svc`, `clinic_svc`) in Docker and in local setup; `npm run verify:db-isolation` proves cross-DB access is refused | 1 | done |
| 4 | Unified docker-compose with 3 isolated DBs, broker, gateway, mock SOAP | `docker-compose.yml`: 3 PostgreSQL containers + isolated logins, RabbitMQ (management UI), gateway, services, mock SOAP EMR, Node-RED (Batch 3) | 1, 3 | done |
| 5 | Missing admin CRUD for heatwave/typhoon alert rules (API design, −3 with #6) | `GET/POST/PATCH/DELETE /api/alerts/rules` with `trigger_condition`, `vulnerability_target`, `action`; weather mashup reads thresholds from the rules (most severe matching rule per hazard; seeded heat 40 °C / extreme heat 52 °C / storm) | 2 | done |
| 6 | No explicit pagination on batch history endpoints | `page`/`pageSize` + `pagination{}` envelope on history, notifications, queue, case history, patient list (and alert rules); `limit=` kept for v1 clients | 2 | done |
| 7 | JWT: no revocation, refresh rotation, key rotation, secret management (Security, −1) | jti deny-list (`POST /oauth/revoke`, `/oauth/logout`, admin "revoke all sessions"), refresh-token rotation with reuse detection, `kid`-based signing keys with rotation schedule (`GET /api/admin/security`), Docker secrets (`*_FILE`, `docker-compose.secrets.yml`) – `docs/SECURITY.md` | 2 | done |
| 8 | Scope monitoring for 6 members | batch plan below, one PR per batch, CI on every `feature/**` branch | all | ongoing |

## Course lessons → where they show up

| Lesson | Applied in |
|---|---|
| Topic 1–3 Enterprise architecture, EA modeling | README architecture (AS-IS/TO-BE), corrected inbound EMR flow |
| Topic 5 Microservices | database-per-service with isolated logins, independent deploys |
| Topic 6 Data representation | JSON Schema event contracts, SOAP/XML → JSON adapter |
| Topic 7 REST / web services | gateway API, pagination + rules CRUD (Batch 2), SOAP/WSDL |
| Topic 8 Testing | unit tests for bus/DLQ/idempotency, Postman, SoapUI, JMeter (updated in Batch 5) |
| Topic 9 / Lesson 13 Cloud integration | externalized config, compose cloud override, hybrid (on-prem EMR) |
| Topic 10 DevOps | feature branches per batch, CI on `feature/**`, shared-code drift check |
| Topic 11 EAI | publish–subscribe, idempotent receiver, dead letter channel; Node-RED content-based router (TextBee SMS), process manager + splitter/aggregator (weather), DLQ monitor/replay – `docs/NODE_RED.md` |
| Topic 12 Middleware | RabbitMQ: topic exchange, durable queues, confirms, ACK-after-commit, prefetch, DLX/DLQ, outbox, saga |
| IT governance | admin DLQ replay audit log, least-privilege DB logins, secrets outside code |

## Batch plan

| Batch | Branch | Content |
|---|---|---|
| 1 | `feature/batch-1-rabbitmq-middleware` | RabbitMQ + TextBee only (Twilio/BullMQ removed), event contracts, DLQ, idempotency, DB isolation, diagram fix |
| 2 | `feature/batch-2-api-security` | alert-rules CRUD, pagination, token revocation / rotation / key management |
| 3 | `feature/batch-3-node-red-eai` | Node-RED container + flows (TextBee inbound SMS router, weather orchestration, DLQ monitor) |
| 4 | `feature/batch-4-caregiver-duties` | care-plan service for caregiver duties (daily personal care, meals, mobility, medication administration, home safety, appointments/transport, emotional support, records) |
| 5 | `feature/batch-5-ui-docs-tests` | web/mobile screens for batches 2–4, Postman/JMeter/SoapUI updates, final docs |

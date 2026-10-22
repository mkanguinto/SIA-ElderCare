# Node-RED EAI layer (v2 · Batch 3)

`integration/node-red/` adds an Enterprise Application Integration layer next to RabbitMQ. It runs three
flows (shown as editor tabs):

| Flow | EAI pattern | What it does |
|---|---|---|
| **TextBee SMS router** | Content-Based Router | Routes every TextBee webhook by its content to exactly one alert-service action. |
| **Weather orchestration** | Process Manager, Splitter, Aggregator, throttling | Every 30 min: check the weather for every monitored zip code against the admin alert rules. |
| **DLQ monitor + dashboard** | Dead Letter Channel monitoring, Message Store replay | Polls the services' queue / DLQ / outbox status and serves an operator dashboard with replay buttons. |

```
TextBee phone ──HTTPS──► API Gateway ──(X-Signature verified, X-Internal-Token)──► Node-RED /webhooks/textbee
                                                                                    │ ack 200 at once
                                                       ┌──── switch on content ─────┘
     MESSAGE_SENT/DELIVERED/FAILED ─► /internal/sms/status      (notification_log)
     CHECKIN P-1001 BP 150/90 …    ─► /internal/sms/checkin     (→ check-in service → saga)
     SOS / EMERGENCY / SAKLOLO     ─► /internal/sms/emergency   (critical family alert)
     STOP · START                  ─► /internal/sms/opt_out|opt_in (subscribers.sms_enabled)
     HELP / TULONG / ?             ─► /internal/sms/help
     anything else                 ─► /internal/sms/unknown     (help text)
```

## 1. TextBee SMS content-based router

* **Signature at the edge.** TextBee signs the raw body (`X-Signature`, HMAC-SHA256). The gateway keeps
  the raw bytes, so it verifies the signature (`api-gateway/src/middleware/textbeeSignature.js`) before
  forwarding. Node-RED then accepts the webhook only with the gateway's `X-Internal-Token`.
* **Acknowledge first.** TextBee needs a 2xx within 10 s, so the flow answers `200 {route}` before it calls
  the alert service.
* **Rules** (`src/eldercare.js classifyTextbeeEvent`, first match wins): SOS keywords → `emergency`;
  `STOP`/`UNSUBSCRIBE`/`TIGIL` → `opt_out`; `START` → `opt_in`; `HELP`/`TULONG`/`?` → `help`;
  `CHECKIN …` or a bare `BP 150/90` reading → `checkin`; anything else → `unknown`.
* **Idempotent receiver.** Each alert-service SMS endpoint claims TextBee's `smsId` once
  (`alert_dedupe`), so a webhook retried by TextBee is not saved twice. Each endpoint texts its own reply
  (dry-run / allow-list rules of `smsSender.js` apply).
* **SOS** goes to every SMS contact of the caregiver's patients except the sender, as a `critical`
  `SMS_SOS` alert (system rule; admins can disable it but not delete it).
* **Fallback.** `TEXTBEE_WEBHOOK_TARGET=alert` sends webhooks straight to the alert service as in v1
  (check-ins and receipts only).

## 2. Weather orchestration

`inject (30 min)` → `GET checkin /internal/locations` → split per zip → **delay node: 1 request / 2 s**
(OpenWeatherMap free-tier limits) → `POST alert /api/alerts/weather-check {zipCode}` (applies the alert
rules from Batch 2, warns families, opens triage items) → aggregate one run summary.

* The alert service's own timer is switched off (`WEATHER_POLL_ENABLED=false`), so there is one scheduler.
* One run at a time; a run that is not finished after 5 minutes is abandoned and late replies are dropped.
* The summary (`ok` / `partial` / `failed` / `not_configured`, hottest zip, rules fired, patients warned,
  triage items) is shown on the dashboard, which also has a **Run now** button.

## 3. DLQ monitor and replay dashboard

Every 15 s the flow calls `GET /internal/messaging` on the check-in, alert and clinic services and merges
the results: broker connection, published / consumed / retried / dead-lettered counters, queue and
dead-letter queue depths, outbox state. When the dead-letter total grows, the flow logs a warning.

**Dashboard:** `http://localhost:1880/dlq` (HTTP Basic, `DASHBOARD_USER` / `DASHBOARD_PASSWORD`; with no
password set the dashboard stays closed). It shows dead-letter queues with **Replay** buttons, each
service's counters, the last weather run, SMS router counts and the replay log. Replay calls the owning
service's `POST /internal/messaging/replay`, which moves the parked messages back to the work queue and
writes its own audit log entry (`by node-red-dashboard:<user>`).

## 4. Running and changing the flows

| URL | Who |
|---|---|
| `http://localhost:1880/dlq` | operators (`DASHBOARD_USER` / `DASHBOARD_PASSWORD`) |
| `http://localhost:1880/admin` | flow editor (`admin` / `NODE_RED_ADMIN_PASSWORD`; disabled when unset) |
| `http://localhost:1880/health` | container health check |

The port is published on `127.0.0.1` only (`NODE_RED_PORT`, default 1880).

`flows.json` is generated from `tools/build-flows.py` (the dashboard page is `tools/dashboard.html`), and
the logic worth testing is in `src/eldercare.js`. After a change:

```bash
python3 integration/node-red/tools/build-flows.py
cd integration/node-red && npm test          # rules, aggregators, auth checks, flows.json wiring
docker compose up -d --build node-red
```

Edits made in the browser editor last until the container is recreated; port them back to the generator.

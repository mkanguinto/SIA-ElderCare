# Testing guide

Start the full stack first: `docker compose up --build` (from the project root).

## Unit tests (no services needed)
```bash
npm run install:all && npm test      # all 7 packages (110 tests), or per package:
cd api-gateway && npm test
cd services/care-plan-service && npm test
cd integration/node-red && npm test  # SMS router rules, aggregators, flows.json wiring
```

## End-to-end smoke test
```bash
npm run smoke
# with the Batch 3 checks (signed TextBee webhooks, DLQ dashboard):
TEXTBEE_WEBHOOK_SECRET=<gateway value> DASHBOARD_PASSWORD=<value> NODE_RED_URL=http://localhost:1880 npm run smoke
```
160 checks across all batches. The account checks read the activation code through `GET /internal/test/account-sms`, which exists only with `ACCOUNT_SMS_CAPTURE=true` (the local Docker default; never in the cloud) and needs `INTERNAL_SERVICE_TOKEN` (taken from `.env`). Without `TEXTBEE_WEBHOOK_SECRET` the SMS router checks are skipped.
Check-ins created by the test are sent with `dataOrigin: "demo"` and archived at the end, so they never sit in a nurse's review list.

## Browser tests (headless Chrome)
```bash
npm run test:browser            # every testing/browser/*.test.mjs
SHOTS=out node testing/browser/run.mjs handover   # one test, with screenshots
```
Needs the stack and the web app running (`WEB_URL`, default `http://127.0.0.1:3000`; `GATEWAY_URL`, default `http://localhost:8080`) and Chrome
(`CHROME_PATH` if it is not in the default place). No npm dependencies: `cdp.mjs` drives Chrome over the DevTools protocol.
- `handover.test.mjs` – Ana hands P-1001 to Ben in the phone UI; Ben sees it under Pending handover, taps Accept case, and it moves from Ana's My cases to Ben's. The case is handed back afterwards.
- `contact.test.mjs` – family opens Contact the clinic (no pop-up), sends a message, gets a CR- reference and an honest SMS-notice line; the nurse sees it in Messages, marks it seen and replies; the family sees who saw it and the reply.
- `session.test.mjs` – a caregiver's unsent check-in: the timeout warning counts down (Stay signed in), the app locks, the password unlocks it with the entry still there; signing in on another device ends the session, the entry is kept and comes back after signing in again; another user signing in on the tab never sees it.

## Postman – functional, security and integration
1. Postman → Import → `postman/ElderCare_Connect.postman_collection.json` and `postman/ElderCare_Connect.local.postman_environment.json`.
2. Select the **ElderCare Connect - Local** environment.
3. Run the whole collection in order with the Collection Runner (folder `0. Auth` stores the tokens the other folders use).

CLI (Newman):
```bash
npx newman run postman/ElderCare_Connect.postman_collection.json \
  -e postman/ElderCare_Connect.local.postman_environment.json \
  --reporters cli,htmlextra --reporter-htmlextra-export results/newman-report.html
```
(`htmlextra` needs `npm i -g newman-reporter-htmlextra`; drop it to use the plain CLI reporter.)

Folder **5. Integration** is the end-to-end chain from Section 4's objective:
caregiver check-in → Family Alert raised + SMS queued → Clinic Risk Queue item (P1/P2) → legacy EMR history via SOAP adapter → nurse updates triage status. The console prints the observed end-to-end time.

Folder **6. v1.1** covers the QA fixes: normal vitals lower an urgent case, schedule visit validation (422) and save (201), family sees the visit, completing it fills Recent Visits and Case history, caregiver medicines, onboarding (201 first run, 409 after), RBAC. Run the whole collection in order: folder 6 uses the case from folder 5.

v2 folders:
- **7. Batch 2** – alert rules CRUD, pagination envelopes, token revocation, refresh rotation + reuse detection, logout, key status.
- **8. Batch 3** – TextBee webhooks through the gateway to the Node-RED router. Set the environment variable
  `textbeeSecret` to the gateway's `TEXTBEE_WEBHOOK_SECRET` to sign them (pre-request script, HMAC-SHA256);
  left empty, the requests go unsigned and the tests expect `401`.
- **9. Batch 4** – care plan: categories, plan, checklist, tick off / upsert / skip rules, clinic add / edit / retire, adherence.
- **10. Batch 5.1** – check-in status: received → awaiting review → reviewed → action recorded, missing readings (never 0), historical and archived demo lists.
- **11. Batch 2 (handover)** – submit → still pending → wrong nurse cannot accept → accept → case in the new nurse's My cases, chain logged, admin limits; ends by handing the case back.
- **12. Batch 3a (accounts)** – admin creates a caregiver → cannot sign in yet → activation code (read through the test-only SMS capture) → weak password 422 → activate → sign in → code single use; single session, nurse phone + desktop, lock / unlock, admin cannot read patient data, audit log; a number off the allow-list is reported as simulated (NOT sent); SMS check; one person's nurse and admin accounts linked by a staff ID (wrong name 422, second account with the same role 409), audit log filtered by staff ID.
  Pass the internal token so the activation steps run: `--env-var internalToken=<INTERNAL_SERVICE_TOKEN>` (without it they are skipped).

Postman CLI: `postman collection run postman/ElderCare_Connect.postman_collection.json -e postman/ElderCare_Connect.local.postman_environment.json --env-var textbeeSecret=<secret>`
(last run: 155 requests, 262 assertions, 0 failures).

## SoapUI – legacy SOAP integration
1. Make sure the mock EMR (`:4005`) and the adapter (`:4004`) are running (both are published by docker compose).
2. SoapUI → File → Import Project → `soapui/ElderCare_Legacy_EMR-soapui-project.xml`.
3. Project properties: `emrEndpoint` (default `http://localhost:4005/emr`), `adapterUrl` (`http://localhost:4004`), `internalToken` (**set to your `INTERNAL_SERVICE_TOKEN`**).
4. Run the **Legacy EMR Integration Suite**:
   - TC1 – live GetPatientHistory: SOAP response valid, not a fault, WSDL schema compliance, XPath checks, SLA.
   - TC2 – unknown patient returns a `PatientNotFound` SOAP Fault.
   - TC3 – adapter `/legacy/translate`: SOAP/XML in → JSON contract out.
   - TC4 – adapter end-to-end call, including fault → HTTP 404 mapping.

CLI: `testrunner.sh -s"Legacy EMR Integration Suite" -PinternalToken=<token> soapui/ElderCare_Legacy_EMR-soapui-project.xml`

To point at a real RHU EMR, change `emrEndpoint` and set `LEGACY_EMR_URL` (and WS-Security credentials) on the adapter.

## JMeter – load and stress
Raise the gateway limits before load testing (in `.env`, then `docker compose up -d api-gateway`):
```
RATE_LIMIT_MAX=100000
JWT_ACCESS_TTL=120m
```

Load test (morning check-in rush + clinic reads, 5 minutes):
```bash
jmeter -n -t jmeter/ElderCare_Connect_Load_Stress.jmx \
  -Jhost=localhost -Jport=8080 -Jusers=50 -JclinicUsers=10 -JrampUp=60 -Jduration=300 \
  -l jmeter/results/load.jtl -e -o jmeter/results/load-report
```

The clinic group also reads the v1.1 endpoints: upcoming and recent visits, case history and prescribed medicines.

Stress test (typhoon spike): open the plan in the JMeter GUI, enable **STRESS - Typhoon alert spike**, optionally disable the two LOAD groups, then:
```bash
jmeter -n -t jmeter/ElderCare_Connect_Load_Stress.jmx -JstressUsers=500 -JstressRampUp=120 -JstressDuration=600 \
  -l jmeter/results/stress.jtl -e -o jmeter/results/stress-report
```
Record the thread count at which error rate exceeds 1 % or p95 latency exceeds 2 s – that is the breaking point for the Section 14 scaling plan.

## Failure testing
| Scenario | How | Expected |
|---|---|---|
| Alert service down | `docker compose stop alert-service`, submit critical check-in, `docker compose start alert-service` | check-in 201; the event waits in `alert-service.checkin-events`; alert appears as soon as the service is back (verified on v2) |
| Node-RED down | `docker compose stop node-red`, send `node mocks/send-sms.mjs … HELP` | gateway answers 502/503; TextBee retries the webhook later; switch `TEXTBEE_WEBHOOK_TARGET=alert` to bypass Node-RED |
| Message in a DLQ | stop a consumer's dependency until retries run out, or use the fake TextBee with failures | the DLQ dashboard (`http://localhost:1880/dlq`) shows it; **Replay** moves it back once the cause is fixed |
| Clinic service down | same with `clinic-risk-service` | gateway returns 503 fast for queue reads (circuit breaker); events delivered after restart |
| TextBee failing | set a wrong `TEXTBEE_API_KEY` with `SMS_DRY_RUN=false` and your number in `SMS_RECIPIENT_ALLOWLIST` | 401 is permanent: `notification_log` = `failed`, message parked in `alert-service.sms-dispatch.dlq`; in-app alert still visible |
| TextBee down / slow | point `TEXTBEE_BASE_URL` at `testing/mocks/fake-textbee.js` started with failures | 5xx: retried 5 s → 30 s → 2 min then DLQ; timeout: `unconfirmed` + DLQ (no duplicate SMS) |
| RabbitMQ down | `docker compose stop rabbitmq`, submit a check-in, then `docker compose start rabbitmq` | check-in still 201; outbox row stays `pending`, published automatically when the broker returns |
| Consumer down | `docker compose stop clinic-risk-service`, submit check-ins, start it again | messages wait in `clinic-risk-service.events` (visible in the RabbitMQ UI) and drain after restart |
| OpenWeatherMap unreachable | set `OPENWEATHER_BASE_URL=http://10.255.255.1` after one successful run | mashup uses cache, logs "using stale cached weather data" |
| Slow legacy EMR | `MOCK_EMR_DELAY_MS=8000` on mock-legacy-emr | EMR history returns 502/503, queue keeps working |
| Flaky legacy EMR | `MOCK_EMR_FAIL_RATE=0.5` | adapter retries once, circuit opens after repeated failures |

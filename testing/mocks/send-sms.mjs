#!/usr/bin/env node
// Simulates a text arriving at the TextBee phone: posts a signed MESSAGE_RECEIVED webhook to the gateway,
// which verifies X-Signature and hands it to the Node-RED SMS router (Batch 3). For demos without a phone.
//
//   TEXTBEE_WEBHOOK_SECRET=<same as the gateway> node testing/mocks/send-sms.mjs +639175550102 "CHECKIN P-1001 BP 150/90 HR 80 MED Y"
//   ... node testing/mocks/send-sms.mjs +639175550102 "SOS nahulog si lola"
//   ... node testing/mocks/send-sms.mjs +639175550101 STOP
// Demo numbers: +639175550102 = caregiver Maria (P-1001, P-1002), +639175550101 = family (P-1001).
import { createHmac, randomUUID } from 'node:crypto';

const [sender, ...words] = process.argv.slice(2);
const secret = process.env.TEXTBEE_WEBHOOK_SECRET;
const gateway = process.env.GATEWAY_URL || 'http://localhost:8080';
if (!sender || !words.length || !secret) {
  console.error('Usage: TEXTBEE_WEBHOOK_SECRET=<secret> node testing/mocks/send-sms.mjs <+63 sender> <message text>');
  process.exit(1);
}
const raw = JSON.stringify({ webhookEvent: 'MESSAGE_RECEIVED', sender, message: words.join(' '), smsId: `demo${randomUUID().replace(/-/g, '')}`, receivedAt: new Date().toISOString() });
const res = await fetch(`${gateway}/webhooks/textbee`, {
  method: 'POST',
  headers: { 'content-type': 'application/json', 'x-signature': createHmac('sha256', secret).update(raw).digest('hex') },
  body: raw,
});
console.log(res.status, await res.text());
console.log('The reply SMS is logged by the alert service (docker compose logs alert-service) unless the number is allow-listed.');

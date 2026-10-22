'use strict';

/**
 * Verifies TextBee's webhook signature at the edge (X-Signature = HMAC-SHA256 of the raw body with
 * TEXTBEE_WEBHOOK_SECRET). Used when webhooks go to the Node-RED SMS router, which cannot see the raw
 * bytes; in the direct mode the alert service verifies the signature itself.
 */
const crypto = require('crypto');
const config = require('../config');
const logger = require('../lib/logger');

function validSignature(rawBody, signature, secret) {
  if (!secret || !signature || !rawBody) return false;
  const expected = crypto.createHmac('sha256', secret).update(rawBody).digest('hex');
  const got = String(signature).trim().toLowerCase().replace(/^sha256=/, '');
  const a = Buffer.from(expected, 'utf8');
  const b = Buffer.from(got, 'utf8');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

function verifyTextbeeSignature(req, res, next) {
  if (!config.textbee.validateWebhook) return next();
  if (!validSignature(req.rawBody, req.get('x-signature'), config.textbee.webhookSecret)) {
    logger.warn('textbee webhook rejected: bad signature', { requestId: req.id });
    return res.status(401).json({ error: 'unauthorized', message: 'Invalid or missing X-Signature' });
  }
  return next();
}

module.exports = { verifyTextbeeSignature, validSignature };

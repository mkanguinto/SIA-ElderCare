'use strict';

/**
 * Message-oriented middleware for ElderCare Connect (Topic 12 - Middleware & Integration Services).
 *
 * Transport: RabbitMQ (AMQP 0-9-1) through amqplib, or an in-process broker with the same
 * semantics ("memory://") for unit tests and single-process development.
 *
 * Topology (declared idempotently by every service on start-up):
 *
 *   producer --publish--> [eldercare.events]  topic exchange, durable
 *                              | binding e.g. "checkin.*"
 *                              v
 *                        <queue>              durable, DLX = eldercare.dlx
 *                              | consumer throws (transient)
 *                              v
 *   [eldercare.retry] --> <queue>.retry.<n>   TTL = retryDelaysMs[n]; on expiry dead-letters back to <queue>
 *                              | still failing after the last tier / permanent error / bad contract
 *                              v
 *   [eldercare.dlx]   --> <queue>.dlq         parked for inspection + replay (never silently dropped)
 *
 * Reliability rules applied (Topic 12 "Reliable Messaging"):
 *   - persistent messages + durable exchanges/queues + publisher confirms
 *   - manual ACK only after the consumer's local DB commit (handler resolved)
 *   - prefetch limits in-flight work per consumer
 *   - transient vs permanent failures are classified; poison messages go to the DLQ, not back to the queue
 *   - consumers are idempotent on eventId (see idempotency.js) because delivery is at-least-once
 */
const crypto = require('crypto');

const EVENTS_EXCHANGE = 'eldercare.events';
const RETRY_EXCHANGE = 'eldercare.retry';
const DLX_EXCHANGE = 'eldercare.dlx';
const DEFAULT_RETRY_DELAYS = [5000, 30000, 120000];

let contracts = null;
function contractsModule() {
  if (contracts === null) {
    try {
      // eslint-disable-next-line global-require
      contracts = require('./eventContracts');
    } catch {
      contracts = false;
    }
  }
  return contracts || null;
}

/** RabbitMQ topic matching: "*" = exactly one word, "#" = zero or more words. */
function topicMatches(pattern, key) {
  const p = pattern.split('.');
  const k = key.split('.');
  const walk = (i, j) => {
    if (i === p.length) return j === k.length;
    if (p[i] === '#') {
      for (let n = j; n <= k.length; n += 1) if (walk(i + 1, n)) return true;
      return false;
    }
    if (j === k.length) return false;
    return (p[i] === '*' || p[i] === k[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

function classifyFailure(err, attempts, maxRetries) {
  if (err && err.reason === 'schema_invalid') return { action: 'dlq', reason: 'schema_invalid' };
  if (err && err.reason === 'ambiguous_delivery') return { action: 'dlq', reason: 'ambiguous_delivery' };
  if (err && err.permanent) return { action: 'dlq', reason: 'permanent_error' };
  if (attempts > maxRetries) return { action: 'dlq', reason: 'max_retries_exceeded' };
  return { action: 'retry', tier: attempts - 1 };
}

function dlqHeaders(headers, { reason, error, routingKey, queue, attempts }) {
  return {
    ...headers,
    'x-death-reason': reason,
    'x-error': String((error && error.message) || error || '').slice(0, 500),
    'x-original-routing-key': routingKey,
    'x-original-queue': queue,
    'x-attempts': attempts,
    'x-failed-at': new Date().toISOString(),
  };
}

function prepareEvent(routingKey, event, validate) {
  if (!event || typeof event !== 'object') throw new TypeError('event must be an object');
  const e = { schemaVersion: 1, ...event };
  if (!e.eventId) e.eventId = crypto.randomUUID();
  if (!e.type) e.type = routingKey;
  if (!e.occurredAt) e.occurredAt = new Date().toISOString();
  const c = contractsModule();
  if (validate && c) c.assertValidEvent(e);
  return e;
}

/* ================================================================================== */
/* RabbitMQ transport                                                                  */
/* ================================================================================== */
function createAmqpBus({ url, serviceName, logger, validate }) {
  // Lazy so services and tests that never use RabbitMQ do not need amqplib installed.
  // eslint-disable-next-line global-require
  const amqp = require('amqplib');
  let conn = null;
  let pubCh = null;
  let connecting = null;
  let closing = false;
  const subscriptions = [];
  const state = { connected: false, lastError: null, reconnects: 0, published: 0, consumed: 0, retried: 0, deadLettered: 0 };

  async function declareBase(ch) {
    await ch.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
    await ch.assertExchange(RETRY_EXCHANGE, 'direct', { durable: true });
    await ch.assertExchange(DLX_EXCHANGE, 'direct', { durable: true });
  }

  async function declareQueue(ch, sub) {
    const { queue, bindings, retryDelaysMs } = sub;
    await ch.assertQueue(queue, {
      durable: true,
      arguments: { 'x-dead-letter-exchange': DLX_EXCHANGE, 'x-dead-letter-routing-key': queue },
    });
    for (const key of bindings) await ch.bindQueue(queue, EVENTS_EXCHANGE, key);
    for (let i = 0; i < retryDelaysMs.length; i += 1) {
      const rq = `${queue}.retry.${i}`;
      await ch.assertQueue(rq, {
        durable: true,
        arguments: { 'x-message-ttl': retryDelaysMs[i], 'x-dead-letter-exchange': '', 'x-dead-letter-routing-key': queue },
      });
      await ch.bindQueue(rq, RETRY_EXCHANGE, rq);
    }
    await ch.assertQueue(`${queue}.dlq`, { durable: true });
    await ch.bindQueue(`${queue}.dlq`, DLX_EXCHANGE, queue);
  }

  function publishConfirmed(ch, exchange, key, content, options) {
    return new Promise((resolve, reject) => {
      ch.publish(exchange, key, content, options, (err) => (err ? reject(err) : resolve()));
    });
  }

  async function startConsumer(sub) {
    const ch = await conn.createConfirmChannel();
    await declareQueue(ch, sub);
    await ch.prefetch(sub.prefetch);
    sub.channel = ch;
    await ch.consume(sub.queue, async (msg) => {
      if (!msg) return; // consumer cancelled by the broker
      const headers = msg.properties.headers || {};
      const attempts = Number(headers['x-attempts'] || 0) + 1;
      const routingKey = headers['x-original-routing-key'] || msg.fields.routingKey;
      let event;
      try {
        event = JSON.parse(msg.content.toString('utf8'));
      } catch (err) {
        await toDlq(ch, msg, { reason: 'malformed_json', error: err, routingKey, queue: sub.queue, attempts });
        return;
      }
      try {
        const c = contractsModule();
        if (validate && c) c.assertValidEvent(event);
        await sub.handler(event, { routingKey, attempts, headers, messageId: msg.properties.messageId, queue: sub.queue });
        ch.ack(msg);
        state.consumed += 1;
      } catch (err) {
        const decision = classifyFailure(err, attempts, sub.retryDelaysMs.length);
        try {
          if (decision.action === 'retry') {
            await publishConfirmed(ch, RETRY_EXCHANGE, `${sub.queue}.retry.${decision.tier}`, msg.content, {
              ...msg.properties, headers: { ...headers, 'x-attempts': attempts, 'x-original-routing-key': routingKey, 'x-last-error': String(err.message).slice(0, 300) },
            });
            ch.ack(msg);
            state.retried += 1;
            logger.warn('message failed, scheduled for retry', { queue: sub.queue, eventId: event.eventId, attempts, delayMs: sub.retryDelaysMs[decision.tier], error: err.message });
          } else {
            await toDlq(ch, msg, { reason: decision.reason, error: err, routingKey, queue: sub.queue, attempts });
          }
        } catch (pubErr) {
          // Could not move the message: return it to the queue so nothing is lost.
          logger.error('could not reroute failed message; requeueing', { queue: sub.queue, error: pubErr.message });
          try { ch.nack(msg, false, true); } catch { /* channel gone; broker will redeliver */ }
        }
      }
    }, { noAck: false });
  }

  async function toDlq(ch, msg, info) {
    await publishConfirmed(ch, DLX_EXCHANGE, info.queue, msg.content, { ...msg.properties, headers: dlqHeaders(msg.properties.headers || {}, info) });
    ch.ack(msg);
    state.deadLettered += 1;
    logger.error('message dead-lettered', { queue: info.queue, dlq: `${info.queue}.dlq`, reason: info.reason, attempts: info.attempts, error: String((info.error && info.error.message) || '') });
  }

  async function doConnect() {
    for (let attempt = 1; !closing; attempt += 1) {
      try {
        conn = await amqp.connect(url, { clientProperties: { connection_name: serviceName } });
        conn.on('error', (err) => { state.lastError = err.message; logger.warn('amqp connection error', { error: err.message }); });
        conn.on('close', () => {
          state.connected = false;
          pubCh = null;
          if (closing) return;
          state.reconnects += 1;
          logger.warn('amqp connection closed; reconnecting');
          setTimeout(() => { connect().catch(() => {}); }, 2000).unref();
        });
        pubCh = await conn.createConfirmChannel();
        await declareBase(pubCh);
        for (const sub of subscriptions) await startConsumer(sub);
        state.connected = true;
        state.lastError = null;
        logger.info('connected to RabbitMQ', { subscriptions: subscriptions.map((s) => s.queue) });
        return;
      } catch (err) {
        state.lastError = err.message;
        const wait = Math.min(30000, 1000 * 2 ** Math.min(attempt, 5));
        logger.warn('RabbitMQ not reachable yet', { attempt, retryInMs: wait, error: err.message });
        await new Promise((r) => setTimeout(r, wait).unref());
      }
    }
  }

  function connect() {
    if (!connecting) connecting = doConnect().finally(() => { connecting = null; });
    return connecting;
  }

  return {
    transport: 'rabbitmq',
    connect,
    async publish(routingKey, event, { headers = {} } = {}) {
      if (!pubCh || !state.connected) throw new Error('message broker not connected');
      const e = prepareEvent(routingKey, event, validate);
      await publishConfirmed(pubCh, EVENTS_EXCHANGE, routingKey, Buffer.from(JSON.stringify(e)), {
        persistent: true,
        contentType: 'application/json',
        contentEncoding: 'utf-8',
        messageId: e.eventId,
        type: e.type,
        appId: serviceName,
        timestamp: Math.floor(Date.now() / 1000),
        headers: { 'x-schema-version': e.schemaVersion, ...(e.correlationId ? { 'x-correlation-id': e.correlationId } : {}), ...headers },
      });
      state.published += 1;
      return e;
    },
    async subscribe({ queue, bindings, handler, retryDelaysMs = DEFAULT_RETRY_DELAYS, prefetch = 10 }) {
      const sub = { queue, bindings, handler, retryDelaysMs, prefetch };
      subscriptions.push(sub);
      if (state.connected) await startConsumer(sub);
      return sub;
    },
    /** Moves up to `limit` messages from <queue>.dlq back into <queue> (operator replay). */
    async replayDlq(queue, limit = 100) {
      if (!conn || !state.connected) throw new Error('message broker not connected');
      const ch = await conn.createConfirmChannel();
      let moved = 0;
      try {
        for (; moved < limit; moved += 1) {
          const msg = await ch.get(`${queue}.dlq`, { noAck: false });
          if (!msg) break;
          const h = { ...(msg.properties.headers || {}) };
          const key = h['x-original-routing-key'] || msg.fields.routingKey;
          for (const k of Object.keys(h)) if (k.startsWith('x-death') || ['x-attempts', 'x-error', 'x-failed-at', 'x-last-error'].includes(k)) delete h[k];
          h['x-replayed-at'] = new Date().toISOString();
          h['x-original-routing-key'] = key;
          // Straight back into the ONE queue that failed (default exchange), not a fan-out to every consumer.
          await publishConfirmed(ch, '', queue, msg.content, { ...msg.properties, headers: h });
          ch.ack(msg);
        }
      } finally {
        await ch.close().catch(() => {});
      }
      return { replayed: moved };
    },
    async inspect() {
      if (!conn || !state.connected) return { queues: [] };
      const ch = await conn.createChannel();
      const queues = [];
      try {
        for (const s of subscriptions) {
          for (const q of [s.queue, `${s.queue}.dlq`]) {
            const r = await ch.checkQueue(q);
            queues.push({ queue: q, messages: r.messageCount, consumers: r.consumerCount });
          }
        }
      } finally {
        await ch.close().catch(() => {});
      }
      return { queues };
    },
    status() {
      return { transport: 'rabbitmq', ...state, subscriptions: subscriptions.map((s) => ({ queue: s.queue, bindings: s.bindings })) };
    },
    async close() {
      closing = true;
      try { if (conn) await conn.close(); } catch { /* already closed */ }
      state.connected = false;
    },
  };
}

/* ================================================================================== */
/* In-process transport (same semantics, no broker) - tests and single-process dev    */
/* ================================================================================== */
function createMemoryBus({ serviceName, logger, validate }) {
  const queues = new Map();
  const state = { connected: true, published: 0, consumed: 0, retried: 0, deadLettered: 0 };
  const timers = new Set();

  function later(fn, ms) {
    const t = setTimeout(() => { timers.delete(t); fn(); }, ms);
    if (t.unref) t.unref();
    timers.add(t);
  }

  async function deliver(q, item) {
    const { body, headers, routingKey } = item;
    const attempts = Number(headers['x-attempts'] || 0) + 1;
    let event;
    try {
      event = JSON.parse(body);
    } catch (err) {
      q.dlq.push({ body, headers: dlqHeaders(headers, { reason: 'malformed_json', error: err, routingKey, queue: q.name, attempts }) });
      state.deadLettered += 1;
      return;
    }
    try {
      const c = contractsModule();
      if (validate && c) c.assertValidEvent(event);
      await q.handler(event, { routingKey, attempts, headers, messageId: event.eventId, queue: q.name });
      state.consumed += 1;
    } catch (err) {
      const d = classifyFailure(err, attempts, q.retryDelaysMs.length);
      if (d.action === 'retry') {
        state.retried += 1;
        q.inRetry += 1;
        logger.warn('message failed, scheduled for retry', { queue: q.name, eventId: event.eventId, attempts, delayMs: q.retryDelaysMs[d.tier], error: err.message });
        later(() => { q.inRetry -= 1; enqueue(q, { body, routingKey, headers: { ...headers, 'x-attempts': attempts } }); }, q.retryDelaysMs[d.tier]);
      } else {
        q.dlq.push({ body, headers: dlqHeaders(headers, { reason: d.reason, error: err, routingKey, queue: q.name, attempts }) });
        state.deadLettered += 1;
        logger.error('message dead-lettered', { queue: q.name, reason: d.reason, attempts, error: err.message });
      }
    }
  }

  function enqueue(q, item) {
    q.ready.push(item);
    pump(q);
  }

  function pump(q) {
    while (q.handler && q.inFlight < q.prefetch && q.ready.length) {
      const item = q.ready.shift();
      q.inFlight += 1;
      setImmediate(() => deliver(q, item).finally(() => { q.inFlight -= 1; pump(q); }));
    }
  }

  return {
    transport: 'memory',
    async connect() { /* nothing to do */ },
    async publish(routingKey, event, { headers = {} } = {}) {
      const e = prepareEvent(routingKey, event, validate);
      const body = JSON.stringify(e);
      for (const q of queues.values()) {
        if (q.bindings.some((b) => topicMatches(b, routingKey))) enqueue(q, { body, routingKey, headers: { 'x-schema-version': e.schemaVersion, ...headers } });
      }
      state.published += 1;
      return e;
    },
    async subscribe({ queue, bindings, handler, retryDelaysMs = DEFAULT_RETRY_DELAYS, prefetch = 10 }) {
      const q = { name: queue, bindings, handler, retryDelaysMs, prefetch, ready: [], dlq: [], inFlight: 0, inRetry: 0 };
      queues.set(queue, q);
      return q;
    },
    async replayDlq(queue, limit = 100) {
      const q = queues.get(queue);
      if (!q) return { replayed: 0 };
      const items = q.dlq.splice(0, limit);
      for (const it of items) {
        const h = { ...it.headers };
        const key = h['x-original-routing-key'];
        for (const k of Object.keys(h)) if (k.startsWith('x-death') || ['x-attempts', 'x-error', 'x-failed-at'].includes(k)) delete h[k];
        enqueue(q, { body: it.body, routingKey: key, headers: { ...h, 'x-replayed-at': new Date().toISOString() } });
      }
      return { replayed: items.length };
    },
    async inspect() {
      const out = [];
      for (const q of queues.values()) {
        out.push({ queue: q.name, messages: q.ready.length + q.inFlight + q.inRetry, consumers: q.handler ? 1 : 0 });
        out.push({ queue: `${q.name}.dlq`, messages: q.dlq.length, consumers: 0 });
      }
      return { queues: out };
    },
    /** Test helper: the parked messages of <queue>.dlq */
    deadLetters(queue) { return (queues.get(queue) || { dlq: [] }).dlq; },
    /** Test helper: resolves when every queue is drained (nothing ready, in flight or waiting to retry). */
    async idle(timeoutMs = 5000) {
      const until = Date.now() + timeoutMs;
      for (;;) {
        const busy = [...queues.values()].some((q) => q.ready.length || q.inFlight || q.inRetry);
        if (!busy) return;
        if (Date.now() > until) throw new Error('bus did not become idle');
        await new Promise((r) => setTimeout(r, 5));
      }
    },
    status() { return { transport: 'memory', ...state, subscriptions: [...queues.values()].map((q) => ({ queue: q.name, bindings: q.bindings })) }; },
    async close() { for (const t of timers) clearTimeout(t); timers.clear(); },
  };
}

/**
 * @param {object} o
 * @param {string} [o.url]          amqp(s)://user:pass@host:5672/vhost  |  memory://
 * @param {string} o.serviceName
 * @param {object} o.logger
 * @param {boolean} [o.validate=true]  validate events against /contracts/events schemas
 */
function createBus({ url = process.env.AMQP_URL, serviceName = process.env.SERVICE_NAME || 'service', logger, validate = true } = {}) {
  const log = logger || { info() {}, warn() {}, error() {}, debug() {} };
  if (!url || url.startsWith('memory:')) return createMemoryBus({ serviceName, logger: log, validate });
  return createAmqpBus({ url, serviceName, logger: log, validate });
}

/** Error helpers for handlers: tell the bus how to treat a failure. */
function permanentError(message) {
  const e = new Error(message);
  e.permanent = true;
  return e;
}

module.exports = {
  createBus, topicMatches, classifyFailure, permanentError,
  EVENTS_EXCHANGE, RETRY_EXCHANGE, DLX_EXCHANGE, DEFAULT_RETRY_DELAYS,
};

'use strict';

/**
 * Resilient HTTP client: timeout + retry with exponential backoff + circuit breaker.
 * Implements the "circuit breaker pattern" mitigation for Risk 4 (cascading failures).
 *
 * Breaker states:
 *   CLOSED    -> requests flow normally; failures are counted
 *   OPEN      -> requests fail fast (no network call) until resetTimeoutMs elapses
 *   HALF_OPEN -> one trial request; success closes the breaker, failure re-opens it
 */
const axios = require('axios');
const logger = require('./logger');

class CircuitOpenError extends Error {
  constructor(name) {
    super(`Circuit "${name}" is OPEN - failing fast`);
    this.code = 'CIRCUIT_OPEN';
  }
}

class CircuitBreaker {
  constructor(name, { failureThreshold = 5, resetTimeoutMs = 15000 } = {}) {
    this.name = name;
    this.failureThreshold = failureThreshold;
    this.resetTimeoutMs = resetTimeoutMs;
    this.state = 'CLOSED';
    this.failures = 0;
    this.openedAt = 0;
  }

  canRequest() {
    if (this.state === 'OPEN' && Date.now() - this.openedAt >= this.resetTimeoutMs) {
      this.state = 'HALF_OPEN';
      logger.info('circuit half-open', { circuit: this.name });
    }
    return this.state !== 'OPEN';
  }

  onSuccess() {
    if (this.state !== 'CLOSED') logger.info('circuit closed', { circuit: this.name });
    this.state = 'CLOSED';
    this.failures = 0;
  }

  onFailure() {
    this.failures += 1;
    if (this.state === 'HALF_OPEN' || this.failures >= this.failureThreshold) {
      this.state = 'OPEN';
      this.openedAt = Date.now();
      logger.warn('circuit opened', { circuit: this.name, failures: this.failures });
    }
  }

  snapshot() {
    return { name: this.name, state: this.state, failures: this.failures };
  }
}

const breakers = new Map();
function getBreaker(name, opts) {
  if (!breakers.has(name)) breakers.set(name, new CircuitBreaker(name, opts));
  return breakers.get(name);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 5xx, timeouts and connection errors are retryable; 4xx are not. */
function isRetryable(err) {
  if (!err.response) return true;
  return err.response.status >= 500;
}

/**
 * @param {string} breakerName  logical dependency name (e.g. "checkin-service")
 * @param {import('axios').AxiosRequestConfig} config
 * @param {{retries?:number, baseDelayMs?:number, timeoutMs?:number}} opts
 */
async function request(breakerName, config, { retries = 2, baseDelayMs = 200, timeoutMs = 5000 } = {}) {
  const breaker = getBreaker(breakerName);
  let lastErr;
  for (let attempt = 0; attempt <= retries; attempt += 1) {
    if (!breaker.canRequest()) throw new CircuitOpenError(breakerName);
    try {
      const res = await axios({ timeout: timeoutMs, ...config });
      breaker.onSuccess();
      return res;
    } catch (err) {
      lastErr = err;
      if (!isRetryable(err)) {
        // A 4xx means the dependency is healthy; the request itself was bad.
        breaker.onSuccess();
        throw err;
      }
      breaker.onFailure();
      if (attempt < retries) await sleep(baseDelayMs * 2 ** attempt);
    }
  }
  throw lastErr;
}

module.exports = { request, getBreaker, CircuitOpenError, breakerSnapshots: () => [...breakers.values()].map((b) => b.snapshot()) };

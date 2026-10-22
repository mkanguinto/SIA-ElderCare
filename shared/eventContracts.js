'use strict';

/**
 * Event contracts (Topic 6 - Data Representation & Exchange, Topic 12 - "the broker carries bytes,
 * applications own the contract").
 *
 * Every message on RabbitMQ has a JSON Schema in /contracts/events/<type>.schema.json.
 * Producers validate before publishing (a bad event never leaves the service) and consumers
 * validate before processing (a malformed event goes straight to the dead-letter queue instead
 * of being retried forever).
 *
 * This is a small, dependency-free validator for the JSON-Schema subset the contracts use:
 * type (incl. arrays of types), const, enum, pattern, format: date-time, min/maxLength,
 * minimum/maximum, required, properties, items, maxItems.
 */
const fs = require('fs');
const path = require('path');

// Copied next to this file by scripts/sync-shared.js; falls back to the repo-level folder.
const DIRS = [path.join(__dirname, 'contracts', 'events'), path.join(__dirname, '..', 'contracts', 'events')];

let cache = null;
function schemas() {
  if (cache) return cache;
  cache = {};
  const dir = DIRS.find((d) => fs.existsSync(d));
  if (!dir) return cache;
  for (const f of fs.readdirSync(dir)) {
    if (!f.endsWith('.schema.json')) continue;
    const s = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
    cache[f.replace(/\.schema\.json$/, '')] = s;
  }
  return cache;
}

const ISO_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

function typeOf(v) {
  if (v === null) return 'null';
  if (Array.isArray(v)) return 'array';
  if (Number.isInteger(v)) return 'integer';
  return typeof v;
}

function typeMatches(value, expected) {
  const t = typeOf(value);
  return [].concat(expected).some((e) => e === t || (e === 'number' && t === 'integer'));
}

function check(schema, value, at, errors) {
  if (!schema || typeof schema !== 'object') return;
  if (schema.type && !typeMatches(value, schema.type)) {
    errors.push(`${at || '(root)'} must be ${[].concat(schema.type).join(' or ')}`);
    return;
  }
  if ('const' in schema && value !== schema.const) errors.push(`${at} must equal ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errors.push(`${at} must be one of: ${schema.enum.join(', ')}`);
  if (typeof value === 'string') {
    if (schema.minLength !== undefined && value.length < schema.minLength) errors.push(`${at} is too short`);
    if (schema.maxLength !== undefined && value.length > schema.maxLength) errors.push(`${at} is too long`);
    if (schema.pattern && !new RegExp(schema.pattern).test(value)) errors.push(`${at} has an invalid format`);
    if (schema.format === 'date-time' && (!ISO_DATE_TIME.test(value) || Number.isNaN(Date.parse(value)))) errors.push(`${at} must be an ISO-8601 date-time`);
  }
  if (typeof value === 'number') {
    if (schema.minimum !== undefined && value < schema.minimum) errors.push(`${at} must be >= ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errors.push(`${at} must be <= ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.maxItems !== undefined && value.length > schema.maxItems) errors.push(`${at} must have at most ${schema.maxItems} items`);
    if (schema.items) value.forEach((v, i) => check(schema.items, v, `${at}[${i}]`, errors));
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) {
    for (const r of schema.required || []) {
      if (value[r] === undefined) errors.push(`${at ? `${at}.` : ''}${r} is required`);
    }
    for (const [k, sub] of Object.entries(schema.properties || {})) {
      if (value[k] !== undefined) check(sub, value[k], at ? `${at}.${k}` : k, errors);
    }
  }
}

/**
 * @param {object} event  must carry `type`
 * @returns {{valid:boolean, errors:string[], known:boolean}}
 */
function validateEvent(event) {
  if (!event || typeof event !== 'object' || Array.isArray(event)) return { valid: false, known: false, errors: ['event must be a JSON object'] };
  const schema = schemas()[event.type];
  if (!schema) return { valid: false, known: false, errors: [`no contract for event type "${event.type}"`] };
  const errors = [];
  check(schema, event, '', errors);
  return { valid: errors.length === 0, known: true, errors };
}

class ContractError extends Error {
  constructor(type, errors) {
    super(`event "${type}" violates its contract: ${errors.slice(0, 5).join('; ')}`);
    this.permanent = true;
    this.reason = 'schema_invalid';
    this.errors = errors;
  }
}

/** Throws ContractError (permanent) when invalid. */
function assertValidEvent(event) {
  const r = validateEvent(event);
  if (!r.valid) throw new ContractError(event && event.type, r.errors);
  return event;
}

module.exports = { validateEvent, assertValidEvent, ContractError, schemas };

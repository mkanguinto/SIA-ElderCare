'use strict';

/**
 * Alert rules (admin CRUD, Batch 2) - validation, DTO mapping and pure evaluation (unit tested).
 *
 * A rule = WHEN trigger_condition holds, FOR patients matching vulnerability_target, DO action.
 *
 *   {
 *     "code": "HEAT_EXTREME",
 *     "hazard": "heat",                                   // heat | storm (weather rules)
 *     "trigger_condition":   { "metric": "heat_index_c", "operator": ">", "value": 40 },
 *     "vulnerability_target": { "conditions": ["hypertension", "copd"], "mobility_restricted": null },
 *     "action": { "severity": "high", "channels": ["sms", "in_app"], "create_clinic_item": true, "cooldown_hours": 24 }
 *   }
 *
 * System rules (HEALTH_ANOMALY, MISSED_CHECKIN, MANUAL) are fired by events, not by weather. Admins can
 * enable/disable them and change their channels / minimum severity, but not delete them or give them
 * a weather trigger.
 */

const SYSTEM_RULES = ['HEALTH_ANOMALY', 'MISSED_CHECKIN', 'MANUAL'];
const HAZARDS = ['heat', 'storm'];
const METRICS = {
  heat_index_c: (p) => p.heatIndexC,
  temperature_c: (p) => p.temperatureC,
  humidity: (p) => p.humidity,
  wind_ms: (p) => p.windMs,
};
const OPERATORS = { '>': (a, b) => a > b, '>=': (a, b) => a >= b, '<': (a, b) => a < b, '<=': (a, b) => a <= b };
const SEVERITIES = ['low', 'moderate', 'high', 'critical'];
const CHANNELS = ['sms', 'in_app'];
const CODE_RE = /^[A-Z][A-Z0-9_]{2,39}$/;
const CONDITION_RE = /^[a-z][a-z0-9_]{1,39}$/;

// OpenWeatherMap condition codes and advisory keywords that count as a storm on their own
// (used when trigger_condition.include_advisories is true).
const SEVERE_CONDITION_IDS = new Set([202, 212, 221, 232, 502, 503, 504, 522, 531, 771, 781]);
const ALERT_KEYWORDS = /(typhoon|tropical (storm|depression|cyclone)|cyclone|hurricane|storm surge|signal no|severe (storm|thunderstorm)|flood|tornado)/i;

const isPlainObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

/* ------------------------------------------------------------------ */
/* Validation                                                          */
/* ------------------------------------------------------------------ */

function validateTrigger(t, errors) {
  if (!isPlainObject(t)) { errors.push('trigger_condition must be an object'); return; }
  if (!METRICS[t.metric]) errors.push(`trigger_condition.metric must be one of: ${Object.keys(METRICS).join(', ')}`);
  if (!OPERATORS[t.operator]) errors.push(`trigger_condition.operator must be one of: ${Object.keys(OPERATORS).join(' ')}`);
  if (typeof t.value !== 'number' || !Number.isFinite(t.value) || t.value < -50 || t.value > 200) {
    errors.push('trigger_condition.value must be a number from -50 to 200');
  }
  if (t.include_advisories !== undefined && typeof t.include_advisories !== 'boolean') {
    errors.push('trigger_condition.include_advisories must be true or false');
  }
  const extra = Object.keys(t).filter((k) => !['metric', 'operator', 'value', 'include_advisories'].includes(k));
  if (extra.length) errors.push(`trigger_condition has unknown field(s): ${extra.join(', ')}`);
}

function validateTarget(v, errors) {
  if (!isPlainObject(v)) { errors.push('vulnerability_target must be an object'); return; }
  if (v.conditions !== undefined) {
    if (!Array.isArray(v.conditions) || v.conditions.length > 20 || v.conditions.some((c) => typeof c !== 'string' || !CONDITION_RE.test(c))) {
      errors.push('vulnerability_target.conditions must be up to 20 lower_snake_case condition names, e.g. "hypertension"');
    }
  }
  if (v.mobility_restricted !== undefined && v.mobility_restricted !== null && typeof v.mobility_restricted !== 'boolean') {
    errors.push('vulnerability_target.mobility_restricted must be true, false or null');
  }
  const extra = Object.keys(v).filter((k) => !['conditions', 'mobility_restricted'].includes(k));
  if (extra.length) errors.push(`vulnerability_target has unknown field(s): ${extra.join(', ')}`);
}

function validateAction(a, errors) {
  if (!isPlainObject(a)) { errors.push('action must be an object'); return; }
  if (a.severity !== undefined && !SEVERITIES.includes(a.severity)) errors.push(`action.severity must be one of: ${SEVERITIES.join(', ')}`);
  if (a.min_severity !== undefined && !SEVERITIES.includes(a.min_severity)) errors.push(`action.min_severity must be one of: ${SEVERITIES.join(', ')}`);
  if (a.channels !== undefined && (!Array.isArray(a.channels) || !a.channels.length || a.channels.some((c) => !CHANNELS.includes(c)) || new Set(a.channels).size !== a.channels.length)) {
    errors.push(`action.channels must be a non-empty subset of: ${CHANNELS.join(', ')}`);
  }
  if (a.create_clinic_item !== undefined && typeof a.create_clinic_item !== 'boolean') errors.push('action.create_clinic_item must be true or false');
  if (a.cooldown_hours !== undefined && (!Number.isInteger(a.cooldown_hours) || a.cooldown_hours < 1 || a.cooldown_hours > 168)) {
    errors.push('action.cooldown_hours must be an integer from 1 to 168');
  }
  const extra = Object.keys(a).filter((k) => !['severity', 'min_severity', 'channels', 'create_clinic_item', 'cooldown_hours'].includes(k));
  if (extra.length) errors.push(`action has unknown field(s): ${extra.join(', ')}`);
}

const DEFAULT_ACTION = { severity: 'high', channels: ['sms', 'in_app'], create_clinic_item: true, cooldown_hours: 24 };

/**
 * Validates a create (POST) or partial update (PATCH) body.
 * @param {object} body
 * @param {{partial?:boolean, existing?:object}} opts  existing = current DB row for PATCH
 * @returns {{errors:string[], value:object}} value holds only the fields to write (snake_case = DB columns)
 */
function validateRule(body, { partial = false, existing = null } = {}) {
  const errors = [];
  const b = isPlainObject(body) ? body : {};
  const has = (k) => b[k] !== undefined;
  const value = {};
  const system = existing ? SYSTEM_RULES.includes(existing.code) : false;

  const allowed = ['code', 'description', 'enabled', 'hazard', 'trigger_condition', 'vulnerability_target', 'action'];
  const unknown = Object.keys(b).filter((k) => !allowed.includes(k));
  if (unknown.length) errors.push(`unknown field(s): ${unknown.join(', ')}`);

  if (!partial) {
    if (typeof b.code !== 'string' || !CODE_RE.test(b.code)) errors.push('code must be 3-40 characters: A-Z, 0-9 and _, starting with a letter');
    else if (SYSTEM_RULES.includes(b.code)) errors.push(`${b.code} is a reserved system rule`);
    else value.code = b.code;
  } else if (has('code')) {
    errors.push('code cannot be changed; create a new rule instead');
  }

  if (!partial || has('description')) {
    const d = typeof b.description === 'string' ? b.description.trim() : '';
    if (d.length < 5 || d.length > 200) errors.push('description must be 5-200 characters');
    else value.description = d;
  }
  if (has('enabled')) {
    if (typeof b.enabled !== 'boolean') errors.push('enabled must be true or false');
    else value.enabled = b.enabled;
  }

  if (system && (has('hazard') || has('trigger_condition') || has('vulnerability_target'))) {
    errors.push('system rules are fired by check-in events: only description, enabled and action can be changed');
  } else {
    if (!partial || has('hazard')) {
      if (!HAZARDS.includes(b.hazard)) errors.push(`hazard must be one of: ${HAZARDS.join(', ')}`);
      else value.hazard = b.hazard;
    }
    if (!partial || has('trigger_condition')) {
      validateTrigger(b.trigger_condition, errors);
      if (isPlainObject(b.trigger_condition)) value.trigger_condition = b.trigger_condition;
    }
    if (!partial || has('vulnerability_target')) {
      validateTarget(b.vulnerability_target, errors);
      if (isPlainObject(b.vulnerability_target)) value.vulnerability_target = b.vulnerability_target;
    }
  }

  if (!partial || has('action')) {
    validateAction(b.action, errors);
    if (isPlainObject(b.action)) value.action = { ...(partial && existing ? existing.action : DEFAULT_ACTION), ...b.action };
  }

  if (partial && !errors.length && !Object.keys(value).length) errors.push('nothing to update');
  return { errors, value };
}

/* ------------------------------------------------------------------ */
/* DTO                                                                 */
/* ------------------------------------------------------------------ */

function toRuleDto(r) {
  const action = { ...r.action, channels: r.channels, min_severity: r.min_severity };
  return {
    code: r.code,
    type: SYSTEM_RULES.includes(r.code) ? 'system' : 'weather',
    description: r.description,
    enabled: r.enabled,
    hazard: r.hazard,
    trigger_condition: r.trigger_condition,
    vulnerability_target: r.vulnerability_target,
    action,
    created_at: r.created_at,
    updated_at: r.updated_at,
    updated_by: r.updated_by,
  };
}

/* ------------------------------------------------------------------ */
/* Evaluation (used by the weather mashup)                             */
/* ------------------------------------------------------------------ */

/**
 * Does this rule fire for a weather risk profile?
 * @returns {{triggered:boolean, value:number|null, reasons:string[]}}
 */
function evaluateRule(rule, profile) {
  const t = rule.trigger_condition || {};
  const read = METRICS[t.metric];
  const value = read ? read(profile) : null;
  const reasons = [];
  if (typeof value === 'number' && OPERATORS[t.operator] && OPERATORS[t.operator](value, t.value)) {
    reasons.push(t.metric === 'wind_ms'
      ? `winds up to ${value} m/s (${Math.round(value * 3.6)} km/h)`
      : `${t.metric} ${value} ${t.operator} ${t.value}`);
  }
  if (t.include_advisories) {
    for (const a of profile.alerts || []) if (ALERT_KEYWORDS.test(`${a.event} ${a.description || ''}`)) reasons.push(`official advisory "${a.event}"`);
    for (const c of profile.conditions || []) if (SEVERE_CONDITION_IDS.has(c.id)) reasons.push(c.description);
  }
  return { triggered: reasons.length > 0, value: typeof value === 'number' ? value : null, reasons };
}

/** Is this patient in the rule's vulnerable population? An empty target matches everyone in the area. */
function matchesTarget(rule, patient) {
  const v = rule.vulnerability_target || {};
  const wanted = (v.conditions || []).map((c) => c.toLowerCase());
  if (wanted.length) {
    const has = (patient.conditions || []).map((c) => String(c).toLowerCase());
    if (!wanted.some((c) => has.includes(c))) return false;
  }
  if (typeof v.mobility_restricted === 'boolean' && Boolean(patient.mobilityRestricted) !== v.mobility_restricted) return false;
  return true;
}

module.exports = {
  SYSTEM_RULES, HAZARDS, METRICS, OPERATORS, DEFAULT_ACTION,
  validateRule, toRuleDto, evaluateRule, matchesTarget,
};

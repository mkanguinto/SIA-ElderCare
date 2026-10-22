'use strict';

/**
 * Docker / Kubernetes secrets support (the `*_FILE` convention used by the official postgres,
 * rabbitmq and mysql images).
 *
 * For each known secret NAME, if NAME_FILE=/run/secrets/name is set, the file's contents (trailing
 * newline removed) are copied into process.env.NAME. The file wins over a plain NAME value, so a stack
 * can keep placeholder values in .env and mount the real secrets read-only.
 *
 * Only the names below are read: settings such as USERS_FILE or TOKEN_STORE_FILE also end in _FILE
 * but are paths, not secrets.
 *
 * Call loadFileSecrets() as the FIRST thing in server.js (right after dotenv), before any module
 * reads process.env at require time.
 */
const fs = require('fs');

const SECRET_NAMES = [
  'JWT_SECRET', 'JWT_REFRESH_SECRET', 'JWT_PRIVATE_KEY', 'JWT_PUBLIC_KEY', 'JWT_PREVIOUS_KEYS', 'JWT_PREVIOUS_REFRESH_KEYS',
  'INTERNAL_SERVICE_TOKEN', 'DATABASE_URL', 'AMQP_URL',
  'TEXTBEE_API_KEY', 'TEXTBEE_WEBHOOK_SECRET', 'OPENWEATHER_API_KEY', 'LEGACY_EMR_PASSWORD',
];

function loadFileSecrets(env = process.env, names = SECRET_NAMES) {
  const loaded = [];
  for (const name of names) {
    const file = env[`${name}_FILE`];
    if (!file) continue;
    let value;
    try {
      value = fs.readFileSync(file, 'utf8');
    } catch (err) {
      throw new Error(`${name}_FILE points to an unreadable file (${err.code || err.message})`);
    }
    env[name] = value.replace(/\r?\n$/, '');
    loaded.push(name);
  }
  return loaded; // names only - never log the values
}

module.exports = { loadFileSecrets, SECRET_NAMES };

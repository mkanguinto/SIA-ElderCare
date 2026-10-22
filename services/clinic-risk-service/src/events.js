'use strict';

/** This service's connection to the integration middleware (RabbitMQ or HTTP fallback). */
const { pool } = require('./db');
const logger = require('./lib/logger');
const { createEventing } = require('./lib/eventing');

module.exports = createEventing({ pool, logger, source: 'clinic-risk-service' });

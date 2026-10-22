'use strict';

/**
 * Legacy Clinic EMR Adapter (Section 7 Component 6, Section 9)
 * Stateless SOAP/XML <-> JSON translator. Owns no data.
 *
 *   GET  /legacy/patients/:id/history   -> calls SOAP GetPatientHistory, returns internal JSON contract
 *   POST /legacy/translate              -> translates a raw GetPatientHistory SOAP response (testing / SoapUI)
 */
require('dotenv').config();
require('./src/lib/secrets').loadFileSecrets(); // *_FILE Docker secrets, before anything reads process.env
process.env.SERVICE_NAME = process.env.SERVICE_NAME || 'legacy-emr-adapter';

const express = require('express');
const helmet = require('helmet');
const logger = require('./src/lib/logger');
const { requireInternalToken } = require('./src/lib/internalAuth');
const { breakerSnapshots, CircuitOpenError } = require('./src/lib/resilientHttp');
const { getPatientHistory, parseEnvelope, SoapFaultError } = require('./src/soapClient');
const { mapPatientHistory } = require('./src/emrMapper');

const app = express();
app.disable('x-powered-by');
app.use(helmet());

app.get('/health', (req, res) => res.json({
  status: 'up', service: 'legacy-emr-adapter', legacyEmrUrl: process.env.LEGACY_EMR_URL ? 'configured' : 'default', circuitBreakers: breakerSnapshots(),
}));

app.get('/legacy/patients/:id/history', requireInternalToken, async (req, res) => {
  const patientId = req.params.id;
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(patientId)) return res.status(400).json({ error: 'bad_request', message: 'Invalid patient id' });
  const started = Date.now();
  try {
    const body = await getPatientHistory(patientId, req.get('x-request-id'));
    const history = mapPatientHistory(body);
    logger.info('legacy history translated', { patientId, visits: history.visits.length, diagnoses: history.diagnoses.length, ms: Date.now() - started });
    return res.json(history);
  } catch (err) {
    if (err instanceof SoapFaultError) {
      const notFound = /NotFound/i.test(err.faultCode) || /not found/i.test(err.faultString);
      logger.warn('legacy SOAP fault', { patientId, faultCode: err.faultCode });
      return res.status(notFound ? 404 : 502).json({ error: notFound ? 'not_found' : 'legacy_fault', message: err.faultString, faultCode: err.faultCode });
    }
    if (err instanceof CircuitOpenError) return res.status(503).json({ error: 'legacy_emr_unavailable', message: 'Legacy EMR circuit open' });
    logger.error('legacy EMR call failed', { patientId, error: err.message, code: err.code, ms: Date.now() - started });
    return res.status(502).json({ error: 'legacy_emr_unavailable', message: 'Could not retrieve legacy EMR history' });
  }
});

app.post('/legacy/translate', requireInternalToken, express.text({ type: ['text/xml', 'application/xml', 'application/soap+xml'], limit: '1mb' }), (req, res) => {
  try {
    if (typeof req.body !== 'string' || !req.body.trim()) return res.status(400).json({ error: 'bad_request', message: 'Send the SOAP XML as text/xml' });
    return res.json(mapPatientHistory(parseEnvelope(req.body)));
  } catch (err) {
    if (err instanceof SoapFaultError) return res.status(422).json({ error: 'soap_fault', faultCode: err.faultCode, message: err.faultString });
    return res.status(422).json({ error: 'translation_failed', message: err.message });
  }
});

app.use((req, res) => res.status(404).json({ error: 'not_found' }));

if (require.main === module) {
  const port = Number(process.env.PORT || 4004);
  app.listen(port, () => logger.info('legacy-emr-adapter listening', { port, target: process.env.LEGACY_EMR_URL || 'http://localhost:4005/emr' }));
}

module.exports = app;

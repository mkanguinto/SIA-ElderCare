'use strict';

/**
 * Contacting the clinic (family / caregiver) - pure rules, unit tested in test/contact.test.js.
 */
const REASONS = {
  worried: 'Worried about their condition',
  reading: 'Question about a reading',
  medicine: 'Question about medicines',
  visit: 'Asking for a home visit',
  callback: 'Please call me back',
  other: 'Something else',
};
const CHANNELS = ['message', 'call'];
const NEXT = { seen: ['sent'], answered: ['sent', 'seen'], closed: ['sent', 'seen', 'answered'] };

function validateContact(b) {
  const errors = [];
  if (!b || typeof b !== 'object') return { ok: false, errors: ['Body must be a JSON object'] };
  const channel = CHANNELS.includes(b.channel) ? b.channel : null;
  if (!channel) errors.push(`channel must be one of: ${CHANNELS.join(', ')}`);
  if (!REASONS[b.reason]) errors.push(`reason must be one of: ${Object.keys(REASONS).join(', ')}`);
  const message = typeof b.message === 'string' ? b.message.trim() : '';
  if (message.length > 1000) errors.push('message must be at most 1000 characters');
  if (channel === 'message' && b.reason === 'other' && message.length < 3) errors.push('Say what it is about (at least 3 characters)');
  if (errors.length) return { ok: false, errors };
  return { ok: true, value: { channel, reason: b.reason, message: message || null, callback: channel === 'message' && (b.callback === true || b.reason === 'callback') } };
}

/** May a nurse move a request to `to`? Every step happens once and only forwards. */
const canMove = (from, to) => Boolean(NEXT[to] && NEXT[to].includes(from));

/** The short notice texted to the clinic hotline. No health details: only who, about whom, why. */
function hotlineText({ id, fromName, fromRole, patientName, channel, reason, callback }) {
  const who = `${fromName} (${fromRole === 'caregiver' ? 'caregiver' : 'family'} of ${patientName})`;
  const what = channel === 'call' ? 'tried to call the clinic' : 'sent the clinic a message';
  return `ElderCare ${id}: ${who} ${what}: ${REASONS[reason]}.${callback ? ' Please call them back.' : ''} See the nurse app > Messages.`.slice(0, 480);
}

const contactId = (seq) => `CR-${String(seq).padStart(6, '0')}`;

module.exports = { REASONS, CHANNELS, validateContact, canMove, hotlineText, contactId };

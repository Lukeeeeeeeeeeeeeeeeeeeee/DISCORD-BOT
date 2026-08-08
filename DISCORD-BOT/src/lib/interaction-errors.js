const INTERACTION_ACK_ERROR_CODES = new Set([10008, 10062, 40060]);
const INTERACTION_ACK_ERROR_MESSAGES = [
  'unknown interaction',
  'unknown message',
  'interaction has already been acknowledged',
  'interaction already acknowledged'
];
const NESTED_ERROR_KEYS = ['cause', 'rawError', 'originalError', 'error', 'data'];

function hasAckCode(error, seen = new Set()) {
  if (!error || seen.has(error)) return false;
  if (typeof error === 'object') seen.add(error);

  if (INTERACTION_ACK_ERROR_CODES.has(Number(error.code))) return true;

  for (const key of NESTED_ERROR_KEYS) {
    const nested = error && error[key];
    if (nested && hasAckCode(nested, seen)) return true;
  }

  return false;
}

function hasAckMessage(error, seen = new Set()) {
  if (!error || seen.has(error)) return false;
  if (typeof error === 'object') seen.add(error);

  const message = error && error.message ? String(error.message).toLowerCase() : '';
  if (message && INTERACTION_ACK_ERROR_MESSAGES.some(fragment => message.includes(fragment))) {
    return true;
  }

  for (const key of NESTED_ERROR_KEYS) {
    const nested = error && error[key];
    if (nested && hasAckMessage(nested, seen)) return true;
  }

  return false;
}

function isInteractionAckError(error) {
  if (!error) return false;
  return hasAckCode(error) || hasAckMessage(error);
}

module.exports = {
  INTERACTION_ACK_ERROR_CODES,
  INTERACTION_ACK_ERROR_MESSAGES,
  isInteractionAckError
};

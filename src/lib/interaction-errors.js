const INTERACTION_ACK_ERROR_CODES = new Set([10008, 10062, 40060]);

function isInteractionAckError(error) {
  return Boolean(error && INTERACTION_ACK_ERROR_CODES.has(Number(error.code)));
}

module.exports = {
  INTERACTION_ACK_ERROR_CODES,
  isInteractionAckError
};

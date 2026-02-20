const {
  handleMultiplierList,
  handleMultiplierView,
  handleMultiplierActive,
  handleMultiplierApply,
  handleMultiplierEvent,
  handleMultiplierReset
} = require('../../../services/recruiting/recruiter-multiplier-service');

const handlers = {
  'multiplier-list': handleMultiplierList,
  'multiplier-view': handleMultiplierView,
  'multiplier-active': handleMultiplierActive,
  'multiplier-apply': handleMultiplierApply,
  'multiplier-event': handleMultiplierEvent,
  'multiplier-reset': handleMultiplierReset
};

module.exports = { handlers };

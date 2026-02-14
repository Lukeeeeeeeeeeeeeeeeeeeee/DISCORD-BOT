const {
  handleMultiplierList,
  handleMultiplierView,
  handleMultiplierActive,
  handleMultiplierApply,
  handleMultiplierReset
} = require('../../../services/recruiting/recruiter-multiplier-service');

const handlers = {
  'multiplier-list': handleMultiplierList,
  'multiplier-view': handleMultiplierView,
  'multiplier-active': handleMultiplierActive,
  'multiplier-apply': handleMultiplierApply,
  'multiplier-reset': handleMultiplierReset
};

module.exports = { handlers };

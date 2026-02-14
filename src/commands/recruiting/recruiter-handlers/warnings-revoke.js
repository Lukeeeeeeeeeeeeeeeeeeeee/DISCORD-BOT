const { handleWarningsRevoke } = require('../../../services/recruiting/recruiter-warning-service');

const handlers = { 'warnings-revoke': handleWarningsRevoke };

module.exports = { handlers };

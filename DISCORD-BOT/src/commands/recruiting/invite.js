const inviteService = require('../../services/recruiting/invite-service');

module.exports = {
  data: {
    name: 'invite',
    description: 'Create a time-limited invite link (Recruiters only)'
  },
  execute(...args) {
    return inviteService.execute(...args);
  },
  init: (...args) => inviteService.init(...args),
  initWithDb: (...args) => inviteService.initWithDb(...args),
  dispose: (...args) => inviteService.dispose(...args),
  getCached: (...args) => inviteService.getCached(...args)
};

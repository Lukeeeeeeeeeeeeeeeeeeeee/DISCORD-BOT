const { execute, init } = require('../../services/recruiting/invite-service');

module.exports = {
  data: {
    name: 'invite',
    description: 'Create a time-limited invite link (Recruiters only)'
  },
  execute,
  init
};

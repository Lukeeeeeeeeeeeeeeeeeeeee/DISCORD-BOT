const { getAntinukeEscalation } = require('../sanitize');

module.exports = {
  'DM-400': {
    version: '6.1.0',
    title: 'DM Delivery Failed — Permission Denied',
    severity: 'WARN',
    baseImpact: 25,
    tags: ['dm', 'permissions'],
    safeMetaKeys: ['userId', 'guildId', 'campaignId', 'channelId', 'workerId', 'reason'],
    recoveryHint: 'Verify bot has Send Messages permission in target channel, user privacy settings.'
  },
  'DM-429': {
    version: '6.1.0',
    title: 'DM Delivery Rate Limited',
    severity: 'WARN',
    baseImpact: 35,
    tags: ['dm', 'rate_limit'],
    safeMetaKeys: ['userId', 'guildId', 'campaignId', 'workerId', 'retryAfter'],
    recoveryHint: 'Implement exponential backoff; review campaign send rate.'
  },
  'DM-500': {
    version: '6.1.0',
    title: 'DM Worker Runtime Error',
    severity: 'ERROR',
    baseImpact: 65,
    tags: ['dm', 'runtime'],
    safeMetaKeys: ['userId', 'guildId', 'campaignId', 'workerId', 'scope', 'phase'],
    escalator: (meta, traceContext) => {
      if (getAntinukeEscalation(traceContext)) return 95;
      if (meta && meta.scope && meta.scope.includes('poll')) return 75;
      if (meta && meta.scope && meta.scope.includes('heartbeat')) return 70;
      if (meta && meta.scope && meta.scope.includes('lease')) return 68;
      return 65;
    },
    recoveryHint: 'Inspect DM worker state, Discord API connectivity, and campaign queue.'
  }
};
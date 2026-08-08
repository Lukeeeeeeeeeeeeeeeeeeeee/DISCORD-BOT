const { getAntinukeEscalation } = require('../sanitize');

module.exports = {
  'CMD-403': {
    version: '6.1.0',
    title: 'Permission Check Failed',
    severity: 'WARN',
    baseImpact: 25,
    tags: ['command', 'permissions'],
    safeMetaKeys: ['command', 'userId', 'guildId', 'requiredRole', 'reason'],
    recoveryHint: 'Validate hierarchy and permission mapping for command guard.'
  },
  'CMD-408': {
    version: '6.1.0',
    title: 'Interaction Acknowledgement Race',
    severity: 'WARN',
    baseImpact: 15,
    tags: ['command', 'discord_api'],
    safeMetaKeys: ['command', 'userId', 'guildId', 'discordCode'],
    recoveryHint: 'Ensure reply or defer occurs exactly once in handler path.'
  },
  'CMD-500': {
    version: '6.1.0',
    title: 'Command Execution Failed',
    severity: 'ERROR',
    baseImpact: 70,
    tags: ['command', 'runtime'],
    safeMetaKeys: ['command', 'subcommand', 'userId', 'guildId', 'channelId', 'scope'],
    recoveryHint: 'Inspect command flow, dependencies, and response lifecycle.'
  },
  'API-502': {
    version: '6.1.0',
    title: 'External API Failure',
    severity: 'WARN',
    baseImpact: 30,
    tags: ['api', 'upstream'],
    schema: {
      userId: 'string',
      guildId: 'string',
      command: 'string',
      status: 'number',
      apiResponse: 'pruned_string'
    },
    escalator: (meta, traceContext) => {
      if (getAntinukeEscalation(traceContext)) return 95;
      if (meta && Number(meta.status) >= 500) return 50;
      return 30;
    },
    recoveryHint: 'Retry with backoff and inspect upstream incident status.'
  }
};
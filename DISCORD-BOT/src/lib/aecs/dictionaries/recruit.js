const { getAntinukeEscalation } = require('../sanitize');

module.exports = {
  'RECRUIT-403': {
    version: '6.1.0',
    title: 'Recruit Permission Check Failed',
    severity: 'WARN',
    baseImpact: 35,
    tags: ['recruit', 'permissions'],
    safeMetaKeys: ['command', 'userId', 'guildId', 'recruiterId', 'recruitedId', 'requiredRole', 'reason'],
    recoveryHint: 'Validate recruiter role hierarchy and permission mapping.'
  },
  'RECRUIT-408': {
    version: '6.1.0',
    title: 'Recruit Interaction Acknowledgement Race',
    severity: 'WARN',
    baseImpact: 15,
    tags: ['recruit', 'discord_api'],
    safeMetaKeys: ['command', 'userId', 'guildId', 'discordCode'],
    recoveryHint: 'Ensure reply or defer occurs exactly once in recruit handler path.'
  },
  'RECRUIT-409': {
    version: '6.1.0',
    title: 'Recruit Conflict',
    severity: 'ERROR',
    baseImpact: 60,
    tags: ['recruit', 'conflict'],
    safeMetaKeys: ['command', 'userId', 'guildId', 'recruiterId', 'recruitedId', 'reason'],
    recoveryHint: 'Verify member has not already been recruited before inserting.'
  },
  'RECRUIT-500': {
    version: '6.1.0',
    title: 'Recruit Service Error',
    severity: 'ERROR',
    baseImpact: 70,
    tags: ['recruit', 'runtime'],
    safeMetaKeys: ['command', 'userId', 'guildId', 'recruiterId', 'recruitedId', 'scope', 'phase', 'traceId'],
    escalator: (meta, traceContext) => {
      if (getAntinukeEscalation(traceContext)) return 95;
      if (meta && meta.phase === 'execute.inner') return 72;
      if (meta && meta.phase === 'execute.outer') return 75;
      return 70;
    },
    recoveryHint: 'Inspect recruit flow, transaction boundaries, and Discord API state.'
  }
};
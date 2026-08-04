module.exports = {
  'ANALYTICS-500': {
    version: '6.1.0',
    title: 'Analytics Processing Error',
    severity: 'ERROR',
    baseImpact: 55,
    tags: ['analytics', 'runtime'],
    safeMetaKeys: ['scope', 'guildId', 'commandName', 'phase'],
    recoveryHint: 'Inspect analytics buffer state and flush lifecycle.'
  },
  'ANALYTICS-502': {
    version: '6.1.0',
    title: 'Analytics Data Loss',
    severity: 'WARN',
    baseImpact: 35,
    tags: ['analytics', 'data_loss'],
    safeMetaKeys: ['scope', 'guildId', 'recordsLost', 'phase', 'reason'],
    recoveryHint: 'Review analytics flush mechanism and buffer overflow handling.'
  }
};

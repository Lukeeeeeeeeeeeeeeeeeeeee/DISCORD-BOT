const { getAntinukeEscalation } = require('../sanitize');

module.exports = {
  'ECONOMY-500': {
    version: '6.1.0',
    title: 'Economy System Error',
    severity: 'ERROR',
    baseImpact: 60,
    tags: ['economy', 'runtime'],
    safeMetaKeys: ['userId', 'guildId', 'itemId', 'scope', 'phase'],
    escalator: (meta, traceContext) => {
      if (getAntinukeEscalation(traceContext)) return 95;
      if (meta && meta.scope && meta.scope.includes('buyItem')) return 65;
      if (meta && meta.scope && meta.scope.includes('applyMultiplier')) return 62;
      return 60;
    },
    recoveryHint: 'Inspect economy transaction state, DB row locks, and multiplier validity.'
  },
  'ECONOMY-502': {
    version: '6.1.0',
    title: 'Economy State Inconsistent',
    severity: 'WARN',
    baseImpact: 45,
    tags: ['economy', 'state_inconsistency'],
    safeMetaKeys: ['userId', 'guildId', 'itemId', 'scope', 'pointsBefore', 'pointsAfter'],
    recoveryHint: 'Rollback transaction and verify points calculation.'
  }
};
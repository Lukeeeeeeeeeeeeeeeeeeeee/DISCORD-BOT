module.exports = {
  'DB-104': {
    version: '6.1.0',
    title: 'Constraint Violation',
    severity: 'ERROR',
    baseImpact: 60,
    tags: ['sqlite', 'write_failure'],
    safeMetaKeys: ['table', 'query', 'conflictKey', 'action', 'guildId', 'userId'],
    recoveryHint: 'Verify target entity exists before UPSERT.'
  },
  'DB-500': {
    version: '6.1.0',
    title: 'Database Operation Failed',
    severity: 'ERROR',
    baseImpact: 70,
    tags: ['sqlite', 'runtime'],
    safeMetaKeys: ['table', 'query', 'action', 'guildId', 'userId', 'scope', 'errorCode'],
    recoveryHint: 'Check DB connectivity, locking state, and pending migrations.'
  },
  'DB-502': {
    version: '6.1.0',
    title: 'Database Busy or Locked',
    severity: 'WARN',
    baseImpact: 45,
    tags: ['sqlite', 'lock_contention'],
    safeMetaKeys: ['table', 'query', 'action', 'attempt', 'maxAttempts', 'guildId'],
    escalator: (meta, traceContext) => {
      const attempt = Number(meta && meta.attempt ? meta.attempt : 0);
      const maxAttempts = Number(meta && meta.maxAttempts ? meta.maxAttempts : 0);
      if (traceContext && traceContext.command === 'anti-nuke-purge') return 95;
      if (maxAttempts > 0 && attempt >= maxAttempts) return 88;
      return 45;
    },
    recoveryHint: 'Retry with jitter and verify write transaction boundaries.'
  }
};

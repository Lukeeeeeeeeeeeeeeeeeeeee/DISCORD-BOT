module.exports = {
  'SCH-001': {
    version: '6.1.0',
    title: 'Scheduler Job Failed',
    severity: 'ERROR',
    baseImpact: 65,
    tags: ['scheduler', 'job_failure'],
    safeMetaKeys: ['job', 'guildId', 'scope', 'attempt', 'maxAttempts'],
    recoveryHint: 'Inspect scheduler lock, DB state, and downstream dependencies.'
  },
  'SCH-409': {
    version: '6.1.0',
    title: 'Scheduler Duplicate Run Blocked',
    severity: 'WARN',
    baseImpact: 30,
    tags: ['scheduler', 'duplicate_run'],
    safeMetaKeys: ['job', 'guildId', 'scope'],
    recoveryHint: 'Review lock TTL and task duration to avoid overlapping runs.'
  },
  'SCH-500': {
    version: '6.1.0',
    title: 'Scheduler Unexpected Error',
    severity: 'ERROR',
    baseImpact: 72,
    tags: ['scheduler', 'runtime'],
    safeMetaKeys: ['job', 'guildId', 'scope', 'phase'],
    recoveryHint: 'Check scheduler startup hooks and job failure handling.'
  }
};

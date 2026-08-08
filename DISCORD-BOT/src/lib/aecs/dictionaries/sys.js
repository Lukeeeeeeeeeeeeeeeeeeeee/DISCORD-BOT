module.exports = {
  'SYS-001': {
    version: '6.1.0',
    title: 'Unknown Codex Error Code',
    severity: 'ERROR',
    baseImpact: 55,
    tags: ['system', 'taxonomy'],
    safeMetaKeys: ['invalidCode', 'scope', 'message'],
    recoveryHint: 'Register this error code in an AECS dictionary before use.'
  },
  'SYS-110': {
    version: '6.1.0',
    title: 'Runtime Event',
    severity: 'INFO',
    baseImpact: 5,
    tags: ['system', 'runtime_event'],
    safeMetaKeys: ['scope', 'message', 'level', 'traceId', 'details']
  },
  'SYS-210': {
    version: '6.1.0',
    title: 'Runtime Warning',
    severity: 'WARN',
    baseImpact: 20,
    tags: ['system', 'runtime_warning'],
    safeMetaKeys: ['scope', 'message', 'level', 'traceId', 'details']
  },
  'SYS-500': {
    version: '6.1.0',
    title: 'Unexpected Runtime Error',
    severity: 'ERROR',
    baseImpact: 65,
    tags: ['system', 'unexpected_error'],
    safeMetaKeys: ['scope', 'message', 'name', 'code', 'details'],
    recoveryHint: 'Inspect stack and upstream call site for unhandled error branch.'
  },
  'SYS-700': {
    version: '6.1.0',
    title: 'Circuit Breaker Suppression Summary',
    severity: 'WARN',
    baseImpact: 40,
    tags: ['system', 'circuit_breaker'],
    safeMetaKeys: ['fingerprint', 'suppressed', 'windowMs', 'code', 'scope'],
    recoveryHint: 'Investigate root error and throttle noisy producer path.'
  },
  'SYS-900': {
    version: '6.1.0',
    title: 'Autocure Recursive Loop Detected and Halted',
    severity: 'FATAL',
    baseImpact: 100,
    tags: ['system', 'autocure', 'loop_protection'],
    safeMetaKeys: ['code', 'scope', 'traceId', 'cureKey'],
    recoveryHint: 'Disable autocure for this code and ship manual remediation.'
  },
  'SYS-901': {
    version: '6.1.0',
    title: 'Autocure Max Depth Reached',
    severity: 'FATAL',
    baseImpact: 98,
    tags: ['system', 'autocure', 'max_depth'],
    safeMetaKeys: ['code', 'scope', 'traceId', 'maxCureDepth'],
    recoveryHint: 'Cascading cures exceeded safety limit; manual intervention required.'
  },
  'SYS-910': {
    version: '6.1.0',
    title: 'Unhandled Process Failure',
    severity: 'FATAL',
    baseImpact: 100,
    tags: ['system', 'process', 'fatal'],
    safeMetaKeys: ['scope', 'message', 'name', 'code'],
    recoveryHint: 'Review process-level exception and restart strategy.'
  },
  'SYS-999': {
    version: '6.1.0',
    title: 'Forced Fatal Shutdown',
    severity: 'FATAL',
    baseImpact: 100,
    tags: ['system', 'shutdown', 'fatal'],
    safeMetaKeys: ['scope', 'reason', 'traceId'],
    recoveryHint: 'Service intentionally exited after fatal telemetry flush.'
  }
};

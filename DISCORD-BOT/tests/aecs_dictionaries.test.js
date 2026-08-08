const dictionaries = require('../src/lib/aecs/dictionaries');
const {
  sanitizeMeta,
  sanitizePrimitive,
  sanitizeString,
  normalizeSeverity,
  clampImpact,
  isPlainObject
} = require('../src/lib/aecs/sanitize');

describe('AECS dictionaries', () => {
  beforeEach(() => dictionaries.resetCacheForTests());

  describe('RECRUIT domain', () => {
    test('RECRUIT-403 has correct metadata', () => {
      const def = dictionaries.getDefinition('RECRUIT-403');
      expect(def).toBeTruthy();
      expect(def.title).toBe('Recruit Permission Check Failed');
      expect(def.severity).toBe('WARN');
      expect(def.baseImpact).toBe(35);
      expect(def.tags).toContain('recruit');
      expect(def.safeMetaKeys).toContain('recruiterId');
      expect(def.recoveryHint).toBeDefined();
    });

    test('RECRUIT-409 uses recoveryHint (not escalationHint)', () => {
      const def = dictionaries.getDefinition('RECRUIT-409');
      expect(def).toBeTruthy();
      expect(def.recoveryHint).toBe('Verify member has not already been recruited before inserting.');
      expect(def.version).toBe('6.1.0');
    });

    test('RECRUIT-500 has escalator that returns 95 for anti-nuke-purge', () => {
      const def = dictionaries.getDefinition('RECRUIT-500');
      expect(def).toBeTruthy();
      expect(typeof def.escalator).toBe('function');

      const traceContext = { command: 'anti-nuke-purge' };
      expect(def.escalator({}, traceContext)).toBe(95);
    });

    test('RECRUIT-500 escalator returns 72 for execute.inner phase', () => {
      const def = dictionaries.getDefinition('RECRUIT-500');
      expect(def.escalator({ phase: 'execute.inner' }, {})).toBe(72);
    });

    test('RECRUIT-500 escalator returns 75 for execute.outer phase', () => {
      const def = dictionaries.getDefinition('RECRUIT-500');
      expect(def.escalator({ phase: 'execute.outer' }, {})).toBe(75);
    });

    test('RECRUIT-500 escalator returns baseImpact (70) for default case', () => {
      const def = dictionaries.getDefinition('RECRUIT-500');
      expect(def.escalator({}, {})).toBe(70);
    });
  });

  describe('DM domain', () => {
    test('DM-429 has rate_limit tag and safeMetaKeys', () => {
      const def = dictionaries.getDefinition('DM-429');
      expect(def).toBeTruthy();
      expect(def.tags).toContain('rate_limit');
      expect(def.safeMetaKeys).toContain('retryAfter');
    });

    test('DM-500 escalator returns 95 for anti-nuke-purge', () => {
      const def = dictionaries.getDefinition('DM-500');
      expect(def.escalator({}, { command: 'anti-nuke-purge' })).toBe(95);
    });

    test('DM-500 escalator returns 75 for poll scope', () => {
      const def = dictionaries.getDefinition('DM-500');
      expect(def.escalator({ scope: 'dm.worker.poll' }, {})).toBe(75);
    });

    test('DM-500 escalator returns 70 for heartbeat scope', () => {
      const def = dictionaries.getDefinition('DM-500');
      expect(def.escalator({ scope: 'dm.worker.heartbeat' }, {})).toBe(70);
    });

    test('DM-500 escalator returns 65 for default', () => {
      const def = dictionaries.getDefinition('DM-500');
      expect(def.escalator({}, {})).toBe(65);
    });
  });

  describe('ECONOMY domain', () => {
    test('ECONOMY-500 escalator returns 95 for anti-nuke-purge', () => {
      const def = dictionaries.getDefinition('ECONOMY-500');
      expect(def.escalator({}, { command: 'anti-nuke-purge' })).toBe(95);
    });

    test('ECONOMY-500 escalator returns 65 for buyItem scope', () => {
      const def = dictionaries.getDefinition('ECONOMY-500');
      expect(def.escalator({ scope: 'economy.buyItem' }, {})).toBe(65);
    });

    test('ECONOMY-500 escalator returns 60 for default', () => {
      const def = dictionaries.getDefinition('ECONOMY-500');
      expect(def.escalator({}, {})).toBe(60);
    });

    test('ECONOMY-502 has state_inconsistency tag', () => {
      const def = dictionaries.getDefinition('ECONOMY-502');
      expect(def.tags).toContain('state_inconsistency');
      expect(def.safeMetaKeys).toContain('pointsBefore');
      expect(def.safeMetaKeys).toContain('pointsAfter');
    });
  });

  describe('ANALYTICS domain', () => {
    test('ANALYTICS-500 exists with runtime tag', () => {
      const def = dictionaries.getDefinition('ANALYTICS-500');
      expect(def).toBeTruthy();
      expect(def.tags).toContain('runtime');
    });

    test('ANALYTICS-502 has data_loss tag', () => {
      const def = dictionaries.getDefinition('ANALYTICS-502');
      expect(def.tags).toContain('data_loss');
      expect(def.safeMetaKeys).toContain('recordsLost');
    });
  });

  describe('fallback behavior', () => {
    test('SYS-001 is returned for unknown codes via CodexError', () => {
      const { CodexError } = require('../src/lib/aecs');
      const err = new CodexError('NONEXISTENT-999');
      expect(err.code).toBe('SYS-001');
    });

    test('getDomainForCode extracts correct prefix', () => {
      expect(dictionaries.getDomainForCode('RECRUIT-500')).toBe('RECRUIT');
      expect(dictionaries.getDomainForCode('DM-500')).toBe('DM');
      expect(dictionaries.getDomainForCode('ECONOMY-500')).toBe('ECONOMY');
      expect(dictionaries.getDomainForCode('ANALYTICS-500')).toBe('ANALYTICS');
      expect(dictionaries.getDomainForCode('SYS-500')).toBe('SYS');
      expect(dictionaries.getDomainForCode('DB-104')).toBe('DB');
    });
  });

  describe('all escalation values are within FATAL threshold', () => {
    test('all anti-nuke-purge escalators return 95 (>= 90)', () => {
      const recruitDef = dictionaries.getDefinition('RECRUIT-500');
      const dmDef = dictionaries.getDefinition('DM-500');
      const econDef = dictionaries.getDefinition('ECONOMY-500');
      const dbDef = dictionaries.getDefinition('DB-502');
      const apiDef = dictionaries.getDefinition('API-502');

      expect(recruitDef.escalator({}, { command: 'anti-nuke-purge' })).toBeGreaterThanOrEqual(90);
      expect(dmDef.escalator({}, { command: 'anti-nuke-purge' })).toBeGreaterThanOrEqual(90);
      expect(econDef.escalator({}, { command: 'anti-nuke-purge' })).toBeGreaterThanOrEqual(90);
      expect(dbDef.escalator({}, { command: 'anti-nuke-purge' })).toBeGreaterThanOrEqual(90);
      expect(apiDef.escalator({}, { command: 'anti-nuke-purge' })).toBeGreaterThanOrEqual(90);
    });

    test('all escalator default returns equal baseImpact', () => {
      const recDef = dictionaries.getDefinition('RECRUIT-500');
      const dmDef = dictionaries.getDefinition('DM-500');
      const econDef = dictionaries.getDefinition('ECONOMY-500');

      expect(recDef.escalator({}, {})).toBe(recDef.baseImpact);
      expect(dmDef.escalator({}, {})).toBe(dmDef.baseImpact);
      expect(econDef.escalator({}, {})).toBe(econDef.baseImpact);
    });
  });
});

describe('AECS sanitize functions', () => {
  describe('sanitizeString', () => {
    test('masks long alphanumeric strings (>= 70 chars) as secrets', () => {
      const token = 'a'.repeat(72);
      const text = `Error at token ${token} end`;
      const result = sanitizeString(text);
      expect(result).not.toContain(token);
      expect(result).toContain('[SCRUBBED]');
    });

    test('truncates to default maxLength 4000', () => {
      // Use ! chars which don't match SECRET_RE pattern
      const long = '!'.repeat(5000);
      const result = sanitizeString(long);
      expect(result.length).toBe(4014);
      expect(result).toContain('[truncated]');
    });

    test('truncates to custom maxLength', () => {
      const long = '!'.repeat(2000);
      const result = sanitizeString(long, 100);
      expect(result.length).toBe(114);
    });

    test('handles non-string input', () => {
      expect(sanitizeString(42)).toBe('42');
      expect(sanitizeString(null)).toBe('null');
      expect(sanitizeString(undefined)).toBe('undefined');
    });

    test('short strings are not modified', () => {
      const text = 'This is a short error message';
      const result = sanitizeString(text);
      expect(result).toBe(text);
    });
  });

  describe('sanitizePrimitive', () => {
    test('sanitizes string values', () => {
      const longStr = 'x'.repeat(5000);
      const result = sanitizePrimitive(longStr);
      expect(typeof result).toBe('string');
      expect(result.length).toBeLessThanOrEqual(4093);
    });

    test('passes numbers through', () => {
      expect(sanitizePrimitive(42)).toBe(42);
      expect(sanitizePrimitive(3.14)).toBe(3.14);
      expect(sanitizePrimitive(Infinity)).toBeNull();
    });

    test('passes booleans through', () => {
      expect(sanitizePrimitive(true)).toBe(true);
      expect(sanitizePrimitive(false)).toBe(false);
    });

    test('handles arrays with max 25 elements', () => {
      const arr = Array.from({ length: 30 }, (_, i) => i);
      const result = sanitizePrimitive(arr);
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBe(25);
    });

    test('handles Error objects', () => {
      const err = new Error('Something failed');
      const result = sanitizePrimitive(err);
      expect(result).toContain('Something failed');
    });

    test('handles null and undefined', () => {
      expect(sanitizePrimitive(null)).toBeNull();
      expect(sanitizePrimitive(undefined)).toBeNull();
    });
  });

  describe('sanitizeMeta', () => {
    test('filters meta by safeMetaKeys', () => {
      const meta = { safeField: 'ok', table: 'users', unsafeKey: 'filtered' };
      const definition = { safeMetaKeys: ['safeField', 'table'] };
      const result = sanitizeMeta(meta, definition);
      expect(result.safeField).toBe('ok');
      expect(result.table).toBe('users');
      expect(result.unsafeKey).toBeUndefined();
    });

    test('redacts secret keys matching BLACKLISTED_KEYS', () => {
      const meta = { token: 'secret123', api_key: 'key456', data: 'ok' };
      const definition = { safeMetaKeys: ['token', 'api_key', 'data'] };
      const result = sanitizeMeta(meta, definition);
      expect(result.token).toBe('[REDACTED]');
      expect(result.api_key).toBe('[REDACTED]');
      expect(result.data).toBe('ok');
    });

    test('uses schema sanitization when schema is provided', () => {
      const meta = { status: 502, apiResponse: { deep: 'object' } };
      const definition = {
        schema: {
          userId: 'string',
          status: 'number',
          apiResponse: 'pruned_string'
        }
      };
      const result = sanitizeMeta(meta, definition);
      expect(result.status).toBe(502);
      expect(result.apiResponse).toBe('[Object Rejected By Schema]');
      expect(result.userId).toBeNull();
    });

    test('returns empty object for non-object meta', () => {
      const result = sanitizeMeta('string', null);
      expect(result).toEqual({});
    });
  });

  describe('clampImpact', () => {
    test('clamps values to 0-100 range', () => {
      expect(clampImpact(-10)).toBe(0);
      expect(clampImpact(50)).toBe(50);
      expect(clampImpact(150)).toBe(100);
    });

    test('returns 50 for non-finite values', () => {
      expect(clampImpact('abc')).toBe(50);
      expect(clampImpact(NaN)).toBe(50);
      expect(clampImpact({})).toBe(50);
    });

    test('clamps null to 0 (Number(null) = 0, which is finite)', () => {
      expect(clampImpact(null)).toBe(0);
    });

    test('rounds fractional values', () => {
      expect(clampImpact(72.5)).toBe(73);
      expect(clampImpact(69.4)).toBe(69);
    });
  });

  describe('normalizeSeverity', () => {
    test('normalizes valid severities', () => {
      expect(normalizeSeverity('INFO')).toBe('INFO');
      expect(normalizeSeverity('warn')).toBe('WARN');
      expect(normalizeSeverity('Error')).toBe('ERROR');
      expect(normalizeSeverity('fatal')).toBe('FATAL');
    });

    test('defaults to ERROR for unknown values', () => {
      expect(normalizeSeverity('unknown')).toBe('ERROR');
      expect(normalizeSeverity(null)).toBe('ERROR');
      expect(normalizeSeverity(undefined)).toBe('ERROR');
    });
  });

  describe('isPlainObject', () => {
    test('returns true for plain objects', () => {
      expect(isPlainObject({})).toBe(true);
      expect(isPlainObject({ a: 1 })).toBe(true);
    });

    test('returns false for non-plain objects', () => {
      expect(isPlainObject(null)).toBe(false);
      expect(isPlainObject(undefined)).toBe(false);
      expect(isPlainObject([])).toBe(false);
      expect(isPlainObject(new Date())).toBe(false);
      expect(isPlainObject(42)).toBe(false);
    });
  });
});

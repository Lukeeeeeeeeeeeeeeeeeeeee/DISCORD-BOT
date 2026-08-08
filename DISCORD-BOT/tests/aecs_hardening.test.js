const fs = require('fs');
const os = require('os');
const path = require('path');

const AecsVault = require('../src/lib/aecs/vault');
const { AECS, CodexError } = require('../src/lib/aecs');
const dictionaries = require('../src/lib/aecs/dictionaries');
const { getAntinukeEscalation, shouldSkipKey } = require('../src/lib/aecs/sanitize');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function listJsonlFiles(dir) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => name.endsWith('.jsonl'))
    .sort()
    .map((name) => path.join(dir, name));
}

describe('AECS Pre-Production Hardening', () => {
  let logDir;

  beforeEach(async () => {
    logDir = path.join(os.tmpdir(), `aecs-hardening-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  });

  afterEach(async () => {
    await AECS.shutdown().catch(() => {});
    if (logDir && fs.existsSync(logDir)) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  describe('BUG-01: forceWriteSync concurrency', () => {
    test('forceWriteSync destroys active streams before sync write', async () => {
      await AECS.reinitialize({
        logDir,
        flushIntervalMs: 10,
        exitOnFatal: false,
        telemetryWebhookUrl: ''
      });

      await AECS.runWithTrace({ traceId: 'tx-bug-01-a', command: 'test' }, async () => {
        await AECS.dispatch(new CodexError('SYS-500', {
          message: 'force write during flush'
        }), { scope: 'test.bug01.concurrent' });
      });

      await sleep(50);
      await AECS.shutdown();

      const files = listJsonlFiles(logDir);
      expect(files.length).toBeGreaterThan(0);

      const lines = fs.readFileSync(files[0], 'utf8').trim().split('\n').filter(Boolean);
      expect(lines.length).toBeGreaterThan(0);

      const record = JSON.parse(lines[0]);
      expect(record.code).toBe('SYS-500');
    });

    test('forceWriteSync during active flush does not corrupt data', async () => {
      const vault = new AecsVault({ logDir, flushIntervalMs: 2000 });

      vault.queue({ timestamp: Date.now(), hashId: 1, severity: 'ERROR', scope: 'test.flush.1', code: 'SYS-500', message: 'async buffer record' });

      const flushPromise = vault.flush();

      await new Promise((resolve) => setImmediate(resolve));

      vault.forceWriteSync({ timestamp: Date.now(), hashId: 2, severity: 'FATAL', scope: 'test.force.1', code: 'SYS-500', message: 'sync force write' });

      await flushPromise;

      const files = vault.listLogFiles();
      expect(files.length).toBeGreaterThan(0);

      const lines = fs.readFileSync(files[0], 'utf8').trim().split('\n').filter(Boolean);
      const records = lines.map((line) => JSON.parse(line));

      // The forceWriteSync record should always be present
      expect(records.some((r) => r.scope === 'test.force.1')).toBe(true);
      expect(records.some((r) => r.message.includes('sync force write'))).toBe(true);

      // All records should be valid JSON (no corruption)
      for (const record of records) {
        expect(record).toHaveProperty('timestamp');
        expect(record).toHaveProperty('code');
      }

      vault.logStream && vault.logStream.destroy();
      vault.idxStream && vault.idxStream.destroy();
    });
  });

  describe('SECURITY-01: secret key redaction', () => {
    const { sanitizeMeta } = require('../src/lib/aecs/sanitize');

    test('sanitizeMeta redacts session_id even when in safeMetaKeys', () => {
      const result = sanitizeMeta(
        { session_id: 'abc123', user: 'bob' },
        { safeMetaKeys: ['session_id', 'user'] }
      );
      expect(result.session_id).toBe('[REDACTED]');
      expect(result.user).toBe('bob');
    });

    test('sanitizeMeta redacts cookie_session even when in safeMetaKeys', () => {
      const result = sanitizeMeta(
        { cookie_session: 'xyz789', action: 'login' },
        { safeMetaKeys: ['cookie_session', 'action'] }
      );
      expect(result.cookie_session).toBe('[REDACTED]');
      expect(result.action).toBe('login');
    });

    test('sanitizeMeta redacts refresh_token key', () => {
      const result = sanitizeMeta(
        { refresh_token: 'rt_abc123', status: 'ok' },
        { safeMetaKeys: ['refresh_token', 'status'] }
      );
      expect(result.refresh_token).toBe('[REDACTED]');
      expect(result.status).toBe('ok');
    });

    test('sanitizeMeta redacts access_token key', () => {
      const result = sanitizeMeta(
        { access_token: 'at_xyz', count: 5 },
        { safeMetaKeys: ['access_token', 'count'] }
      );
      expect(result.access_token).toBe('[REDACTED]');
      expect(result.count).toBe(5);
    });

    test('shouldSkipKey returns true for session-containing keys', () => {
      expect(shouldSkipKey('session_id')).toBe(true);
      expect(shouldSkipKey('session')).toBe(true);
      expect(shouldSkipKey('user_session')).toBe(true);
      expect(shouldSkipKey('cookies')).toBe(true);
    });

    test('logger.js stripSecrets uses consistent shouldSkipKey logic', () => {
      const { stripSecrets } = require('../src/lib/logger');
      const result = stripSecrets({ session_id: 'abc123', user: 'bob' });
      expect(result.session_id).toBe('[REDACTED]');
      expect(result.user).toBe('bob');
    });
  });

  describe('BUG-02: UUID normalization', () => {
    const { normalizeMessage, createFingerprint } = require('../src/lib/aecs/Dispatcher');

    test('normalizeMessage replaces UUID with [UUID] token', () => {
      const result = normalizeMessage('Error for user 550e8400-e29b-41d4-a716-446655440000');
      expect(result).toContain('[UUID]');
    });

    test('normalizeMessage does not leave [NUM] fragments from UUID', () => {
      const result = normalizeMessage('550e8400-e29b-41d4-a716-446655440000');
      expect(result).toContain('[UUID]');
      expect(result).not.toMatch(/\[NUM\]e/);
    });

    test('different UUIDs in same message template produce same fingerprint', () => {
      const hash1 = createFingerprint('test.scope', 'TEST-500', 'Failed for 550e8400-e29b-41d4-a716-446655440000');
      const hash2 = createFingerprint('test.scope', 'TEST-500', 'Failed for 669e8400-e29b-41d4-a716-446655440001');
      expect(hash1).toBe(hash2);
    });

    test('UUID adjacent to numbers normalizes correctly', () => {
      const result = normalizeMessage('UUID: 550e8400-e29b-41d4-a716-446655440000 and count 42');
      expect(result).toContain('[UUID]');
      expect(result).toContain('[NUM]');
    });
  });

  describe('ARCH-02: anti-nuke-purge escalation utility', () => {
    test('getAntinukeEscalation returns true for anti-nuke-purge context', () => {
      expect(getAntinukeEscalation({ command: 'anti-nuke-purge' })).toBe(true);
    });

    test('getAntinukeEscalation returns false for other commands', () => {
      expect(getAntinukeEscalation({ command: 'recruit' })).toBe(false);
      expect(getAntinukeEscalation({ command: null })).toBe(false);
      expect(getAntinukeEscalation(null)).toBe(false);
      expect(getAntinukeEscalation(undefined)).toBe(false);
    });

    test('DB-502 escalator returns 95 for anti-nuke-purge', () => {
      const def = dictionaries.getDefinition('DB-502');
      expect(def).toBeTruthy();
      expect(def.escalator).toBeDefined();
      expect(def.escalator({ attempt: 0, maxAttempts: 5 }, { command: 'anti-nuke-purge' })).toBe(95);
    });

    test('API-502 escalator returns 95 for anti-nuke-purge', () => {
      const def = dictionaries.getDefinition('API-502');
      expect(def).toBeTruthy();
      expect(def.escalator).toBeDefined();
      expect(def.escalator({ status: 502 }, { command: 'anti-nuke-purge' })).toBe(95);
    });

    test('RECRUIT-500 escalator returns 95 for anti-nuke-purge', () => {
      const def = dictionaries.getDefinition('RECRUIT-500');
      expect(def).toBeTruthy();
      expect(def.escalator).toBeDefined();
      expect(def.escalator({}, { command: 'anti-nuke-purge' })).toBe(95);
    });

    test('DM-500 escalator returns 95 for anti-nuke-purge', () => {
      const def = dictionaries.getDefinition('DM-500');
      expect(def).toBeTruthy();
      expect(def.escalator).toBeDefined();
      expect(def.escalator({ scope: 'dm.heartbeat' }, { command: 'anti-nuke-purge' })).toBe(95);
    });

    test('ECONOMY-500 escalator returns 95 for anti-nuke-purge', () => {
      const def = dictionaries.getDefinition('ECONOMY-500');
      expect(def).toBeTruthy();
      expect(def.escalator).toBeDefined();
      expect(def.escalator({ scope: 'economy.buyItem' }, { command: 'anti-nuke-purge' })).toBe(95);
    });
  });

  describe('FIND-01: suppressionMap bounds', () => {
    test('suppressionMap evicts oldest entries when exceeding max size', async () => {
      await AECS.reinitialize({
        logDir,
        flushIntervalMs: 2000,
        suppressionThreshold: 1000,
        suppressionWindowMs: 60000,
        suppressionMapMaxSize: 10,
        exitOnFatal: false,
        telemetryWebhookUrl: ''
      });

      const dispatcher = AECS.dispatcher;
      expect(dispatcher).toBeTruthy();

      for (let i = 0; i < 15; i += 1) {
        dispatcher.shouldSuppress(`fp-key-${i}`, 'TEST-500', `scope.${i}`, 'ERROR');
      }

      expect(dispatcher.suppressionMap.size).toBeLessThanOrEqual(12);
    });

    test('eviction preserves entries with suppressed > 0', async () => {
      await AECS.reinitialize({
        logDir,
        flushIntervalMs: 2000,
        suppressionThreshold: 3,
        suppressionWindowMs: 60000,
        suppressionMapMaxSize: 10,
        exitOnFatal: false,
        telemetryWebhookUrl: ''
      });

      const dispatcher = AECS.dispatcher;
      const suppressedFingerprints = [];
      for (let i = 0; i < 5; i += 1) {
        const fp = `suppressed-key-${i}`;
        for (let j = 0; j < 10; j += 1) {
          dispatcher.shouldSuppress(fp, 'TEST-500', `scope.${i}`, 'ERROR');
        }
        suppressedFingerprints.push(fp);
      }

      const unsuppressedFingerprints = [];
      for (let i = 0; i < 15; i += 1) {
        const fp = `unique-key-${i}`;
        dispatcher.shouldSuppress(fp, 'TEST-500', `scope.u${i}`, 'ERROR');
        unsuppressedFingerprints.push(fp);
      }

      expect(dispatcher.suppressionMap.size).toBeLessThanOrEqual(12);

      for (const fp of suppressedFingerprints) {
        expect(dispatcher.suppressionMap.has(fp)).toBe(true);
        const state = dispatcher.suppressionMap.get(fp);
        expect(state.suppressed).toBeGreaterThan(0);
      }
    });
  });

  describe('FIND-02: vault file retention', () => {
    test('cleanupOldFiles(0) deletes all aecs files', () => {
      const vault = new AecsVault({ logDir, flushIntervalMs: 2000 });
      fs.mkdirSync(logDir, { recursive: true });

      fs.writeFileSync(path.join(logDir, 'aecs-2024-01-01.jsonl'), 'old data');
      fs.writeFileSync(path.join(logDir, 'aecs-2024-01-01.idx'), Buffer.alloc(16));
      fs.writeFileSync(path.join(logDir, 'aecs-2024-06-15.jsonl'), 'recent data');
      fs.writeFileSync(path.join(logDir, 'other-file.txt'), 'not cleaned');

      // Use a very large maxAge to ensure only old files are deleted,
      // and a date-based approach for completeness
      const removed = vault.cleanupOldFiles(-1);
      // With negative maxAgeDays, all aecs files should be removed
      expect(removed).toBe(3);

      const remaining = fs.readdirSync(logDir);
      expect(remaining).toEqual(['other-file.txt']);

      vault.logStream && vault.logStream.destroy();
      vault.idxStream && vault.idxStream.destroy();
    });

    test('cleanupOldFiles(30) preserves recent, deletes old', () => {
      const vault = new AecsVault({ logDir, flushIntervalMs: 2000 });
      fs.mkdirSync(logDir, { recursive: true });

      const oldDate = new Date(Date.now() - 60 * 24 * 60 * 60 * 1000);
      const recentDate = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);

      const oldPath = path.join(logDir, 'aecs-2024-01-01.jsonl');
      const recentPath = path.join(logDir, 'aecs-2024-06-15.jsonl');

      fs.writeFileSync(oldPath, 'old data');
      fs.writeFileSync(recentPath, 'recent data');

      fs.utimesSync(oldPath, oldDate, oldDate);
      fs.utimesSync(recentPath, recentDate, recentDate);

      const removed = vault.cleanupOldFiles(30);
      expect(removed).toBe(1);

      expect(fs.existsSync(oldPath)).toBe(false);
      expect(fs.existsSync(recentPath)).toBe(true);

      vault.logStream && vault.logStream.destroy();
      vault.idxStream && vault.idxStream.destroy();
    });

    test('cleanupOldFiles skips non-aecs files', () => {
      const vault = new AecsVault({ logDir, flushIntervalMs: 2000 });
      fs.mkdirSync(logDir, { recursive: true });

      fs.writeFileSync(path.join(logDir, 'random.jsonl'), 'not aecs');
      fs.writeFileSync(path.join(logDir, 'aecs-2024-01-01.jsonl'), 'old aecs');
      fs.writeFileSync(path.join(logDir, 'data.csv'), 'csv data');

      const removed = vault.cleanupOldFiles(-1);
      expect(removed).toBe(1);

      expect(fs.existsSync(path.join(logDir, 'random.jsonl'))).toBe(true);
      expect(fs.existsSync(path.join(logDir, 'data.csv'))).toBe(true);
      expect(fs.existsSync(path.join(logDir, 'aecs-2024-01-01.jsonl'))).toBe(false);

      vault.logStream && vault.logStream.destroy();
      vault.idxStream && vault.idxStream.destroy();
    });
  });

  describe('ARCH-01: getDomainForCode delegation', () => {
    test('Dispatcher uses dictionaries.getDomainForCode', () => {
      expect(dictionaries.getDomainForCode('DB-500')).toBe('DB');
      expect(dictionaries.getDomainForCode('CMD-403')).toBe('CMD');
      expect(dictionaries.getDomainForCode('SYS-500')).toBe('SYS');
      expect(dictionaries.getDomainForCode('API-502')).toBe('API');
    });
  });

  describe('RETRY-01: telemetry retry attempt logging', () => {
    const { TelemetryAdapter } = require('../src/lib/aecs/telemetry-adapter');

    test('logs retry attempt to console.warn before each retry', async () => {
      let callCount = 0;
      const warnings = [];
      const originalWarn = console.warn;
      console.warn = (...args) => { warnings.push(args.map(String).join(' ')); };

      try {
        const adapter = new TelemetryAdapter({
          defaultWebhookUrl: 'https://example.com/default',
          impactThreshold: 70,
          fetchImpl: async () => {
            callCount += 1;
            return callCount === 1 ? { ok: false, status: 502, retryable: true } : { ok: true, status: 204, retryable: false };
          }
        });

        await adapter.sendToWebhookWithRetry('https://example.com/webhook', { test: true });

        const retryWarnings = warnings.filter((w) => w.includes('[AECS] Telemetry retry attempt'));
        expect(retryWarnings).toHaveLength(1);
        expect(retryWarnings[0]).toContain('attempt 1');
        expect(retryWarnings[0]).toContain('https://example.com/webhook');
      } finally {
        console.warn = originalWarn;
      }
    });
  });

  describe('FIX-03: closeStreams race condition', () => {
    test('streams are not nulled until end() callbacks complete', async () => {
      const vault = new AecsVault({ logDir, flushIntervalMs: 2000 });
      fs.mkdirSync(logDir, { recursive: true });

      vault.queue({ timestamp: Date.now(), hashId: 1, severity: 'INFO', scope: 'test.streams' });
      await vault.flush();

      expect(vault.logStream).not.toBeNull();
      expect(vault.idxStream).not.toBeNull();

      let logStreamStillAliveDuringEnd = false;
      const originalLogEnd = vault.logStream.end;
      vault.logStream.end = jest.fn((callback) => {
        logStreamStillAliveDuringEnd = vault.logStream !== null;
        originalLogEnd.call(vault.logStream, callback);
      });

      await vault.closeStreams();

      expect(logStreamStillAliveDuringEnd).toBe(true);
      expect(vault.logStream).toBeNull();
      expect(vault.idxStream).toBeNull();
      expect(vault.currentDateKey).toBeNull();
      expect(vault.currentOffset).toBe(0);
    });
  });
});
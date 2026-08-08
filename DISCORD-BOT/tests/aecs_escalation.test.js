const fs = require('fs');
const os = require('os');
const path = require('path');

const { AECS, CodexError } = require('../src/lib/aecs');

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

describe('AECS escalation', () => {
  let logDir;

  beforeEach(async () => {
    logDir = path.join(os.tmpdir(), `aecs-escalation-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await AECS.reinitialize({
      logDir,
      flushIntervalMs: 20,
      suppressionThreshold: 1000,
      suppressionWindowMs: 60000,
      exitOnFatal: false,
      telemetryWebhookUrl: ''
    });
  });

  afterEach(async () => {
    await AECS.shutdown();
    if (logDir && fs.existsSync(logDir)) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  test('recruit service error escalates to FATAL during anti-nuke-purge', async () => {
    let dispatchedSeverity = null;
    let dispatchedImpact = null;

    await AECS.runWithTrace(
      { traceId: 'tx-escalate-1', command: 'anti-nuke-purge' },
      async () => {
        const result = await AECS.dispatch(new CodexError('RECRUIT-500', {
          phase: 'execute.inner',
          recruiterId: '123',
          scope: 'service.recruit.execute.inner'
        }), { scope: 'service.recruit.execute.inner' });
        dispatchedSeverity = result.record.severity;
        dispatchedImpact = result.record.impact;
      }
    );

    expect(dispatchedSeverity).toBe('FATAL');
    expect(dispatchedImpact).toBeGreaterThanOrEqual(90);
  });

  test('economy error escalates to FATAL during anti-nuke-purge', async () => {
    let dispatchedSeverity = null;

    await AECS.runWithTrace(
      { traceId: 'tx-escalate-2', command: 'anti-nuke-purge' },
      async () => {
        const result = await AECS.dispatch(new CodexError('ECONOMY-500', {
          scope: 'economy.buyItem'
        }), { scope: 'economy.buyItem' });
        dispatchedSeverity = result.record.severity;
      }
    );

    expect(dispatchedSeverity).toBe('FATAL');
  });

  test('dm worker error escalates to FATAL during anti-nuke-purge', async () => {
    let dispatchedSeverity = null;

    await AECS.runWithTrace(
      { traceId: 'tx-escalate-3', command: 'anti-nuke-purge' },
      async () => {
        const result = await AECS.dispatch(new CodexError('DM-500', {
          scope: 'dm.worker.heartbeat'
        }), { scope: 'dm.worker.heartbeat' });
        dispatchedSeverity = result.record.severity;
      }
    );

    expect(dispatchedSeverity).toBe('FATAL');
  });

  test('non-anti-nuke-purge context uses meta-based escalation', async () => {
    let dispatchedImpact = null;

    await AECS.runWithTrace(
      { traceId: 'tx-escalate-4', command: 'recruit' },
      async () => {
        const result = await AECS.dispatch(new CodexError('RECRUIT-500', {
          phase: 'execute.inner'
        }), { scope: 'service.recruit.execute.inner' });
        dispatchedImpact = result.record.impact;
      }
    );

    expect(dispatchedImpact).toBe(72);
  });

  test('non-escalated error uses baseImpact', async () => {
    let dispatchedImpact = null;

    await AECS.runWithTrace(
      { traceId: 'tx-escalate-5', command: 'recruit' },
      async () => {
        const result = await AECS.dispatch(new CodexError('RECRUIT-500', {}), { scope: 'service.recruit' });
        dispatchedImpact = result.record.impact;
      }
    );

    expect(dispatchedImpact).toBe(70);
  });

  test('escalator receives sanitized meta only', async () => {
    const dictionaries = require('../src/lib/aecs/dictionaries');
    const def = dictionaries.getDefinition('RECRUIT-500');
    const sanitizedMeta = { phase: 'execute.inner' };

    const result = def.escalator(sanitizedMeta, { command: 'recruit' });
    expect(result).toBe(72);

    expect(def.safeMetaKeys).not.toContain('secretToken');
  });

  test('DB-502 escalator still works with anti-nuke-purge context', async () => {
    let dispatchedSeverity = null;

    await AECS.runWithTrace(
      { traceId: 'tx-escalate-6', command: 'anti-nuke-purge' },
      async () => {
        const result = await AECS.dispatch(new CodexError('DB-502', {
          scope: 'db.write',
          attempt: 3,
          maxAttempts: 3
        }), { scope: 'db.write' });
        dispatchedSeverity = result.record.severity;
      }
    );

    expect(dispatchedSeverity).toBe('FATAL');
  });

  test('API-502 escalator still works with anti-nuke-purge context', async () => {
    let dispatchedSeverity = null;

    await AECS.runWithTrace(
      { traceId: 'tx-escalate-7', command: 'anti-nuke-purge' },
      async () => {
        const result = await AECS.dispatch(new CodexError('API-502', {
          status: 500
        }), { scope: 'api.test' });
        dispatchedSeverity = result.record.severity;
      }
    );

    expect(dispatchedSeverity).toBe('FATAL');
  });

  test('FATAL errors are force-written synchronously to vault', async () => {
    await AECS.runWithTrace(
      { traceId: 'tx-fatal-1', command: 'anti-nuke-purge' },
      async () => {
        await AECS.dispatch(new CodexError('RECRUIT-500', {}), { scope: 'service.recruit.fatal' });
      }
    );

    await sleep(50);
    await AECS.shutdown();

    const files = listJsonlFiles(logDir);
    const rows = fs.readFileSync(files[0], 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const fatalRecord = rows.find((r) => r.code === 'RECRUIT-500');
    expect(fatalRecord).toBeTruthy();
    expect(fatalRecord.severity).toBe('FATAL');
  });
});

describe('AECS suppression and SYS-700 fingerprint', () => {
  let logDir;

  beforeEach(async () => {
    logDir = path.join(os.tmpdir(), `aecs-suppress-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await AECS.reinitialize({
      logDir,
      flushIntervalMs: 20,
      suppressionThreshold: 3,
      suppressionWindowMs: 60000,
      exitOnFatal: false,
      telemetryWebhookUrl: ''
    });
  });

  afterEach(async () => {
    await AECS.shutdown();
    if (logDir && fs.existsSync(logDir)) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  test('suppression generates SYS-700 summary with correct code+scope', async () => {
    // Dispatch same error 5 times — threshold is 3, so first 3 not suppressed, last 2 suppressed
    await AECS.runWithTrace({ traceId: 'tx-suppress-1', command: 'recruit' }, async () => {
      for (let i = 0; i < 5; i += 1) {
        await AECS.dispatch(new CodexError('RECRUIT-500', {}), { scope: 'service.recruit.test' });
      }
    });

    await sleep(50);
    await AECS.shutdown();

    const files = listJsonlFiles(logDir);
    const rows = fs.readFileSync(files[0], 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

    const directRecords = rows.filter((r) => r.code === 'RECRUIT-500');
    const summaryRecords = rows.filter((r) => r.code === 'SYS-700');

    // First 3 pass through (count 1,2,3 — none exceed threshold of 3)
    // 4th: count 4 > 3 → suppressed; 5th: count 5 > 3 → suppressed
    expect(directRecords.length).toBe(3);
    expect(summaryRecords.length).toBe(1);

    // SYS-700 hash should be based on code+scope (not message)
    expect(summaryRecords[0].meta.code).toBe('RECRUIT-500');
    expect(summaryRecords[0].meta.scope).toBe('service.recruit.test');
  });

  test('SYS-700 hash is based on code+scope, not message', async () => {
    await AECS.runWithTrace({ traceId: 'tx-suppress-2', command: 'recruit' }, async () => {
      for (let i = 0; i < 5; i += 1) {
        await AECS.dispatch(
          new CodexError('DB-500', { table: `table_${i}` }),
          { scope: 'db.test.unique' }
        );
      }
    });

    await sleep(50);
    await AECS.shutdown();

    const files = listJsonlFiles(logDir);
    const rows = fs.readFileSync(files[0], 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));

    const summaryRecords = rows.filter((r) => r.code === 'SYS-700');
    expect(summaryRecords.length).toBe(1);

    // The hash should incorporate the scope 'db.test.unique', not the varying message
    const { createFingerprint } = require('../src/lib/aecs/Dispatcher');
    const expectedHash = createFingerprint('aecs.circuit_breaker', 'DB-500', 'db.test.unique');
    expect(summaryRecords[0].hash).toBe(expectedHash);
  });

  test('different code+scope combos produce different fingerprints', async () => {
    const dispatcher = AECS.dispatcher;

    // Suppress errors for RECRUIT-500 + scope.a (threshold is 3)
    for (let i = 0; i < 5; i += 1) {
      dispatcher.shouldSuppress('fp1', 'RECRUIT-500', 'scope.a', 'ERROR');
    }

    // Suppress errors for DB-500 + scope.b
    for (let i = 0; i < 5; i += 1) {
      dispatcher.shouldSuppress('fp2', 'DB-500', 'scope.b', 'ERROR');
    }

    await dispatcher.flushSuppressionSummaries();

    // Verify the SYS-700 fingerprints differ for different code+scope combos
    const { createFingerprint } = require('../src/lib/aecs/Dispatcher');
    const hash1 = createFingerprint('aecs.circuit_breaker', 'RECRUIT-500', 'scope.a');
    const hash2 = createFingerprint('aecs.circuit_breaker', 'DB-500', 'scope.b');
    expect(hash1).not.toBe(hash2);

    // The old bug used state.message (undefined) in the fingerprint, causing all
    // SYS-700 records to have the same hash. Verify scope is now used instead.
    const buggyHash = createFingerprint('aecs.circuit_breaker', 'RECRUIT-500', undefined);
    expect(hash1).not.toBe(buggyHash);
  });
});

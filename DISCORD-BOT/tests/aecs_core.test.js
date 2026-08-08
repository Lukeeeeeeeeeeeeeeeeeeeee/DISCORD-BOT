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

describe('AECS core', () => {
  let logDir;

  beforeEach(async () => {
    logDir = path.join(os.tmpdir(), `aecs-core-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
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

  test('sanitizes meta by safeMetaKeys and creates support id', async () => {
    await AECS.runWithTrace({
      traceId: 'tx-unit-1',
      command: 'recruit',
      userId: '123',
      guildId: '456'
    }, async () => {
      await AECS.dispatch(new CodexError('DB-104', {
        table: 'recruits',
        query: 'INSERT INTO recruits ...',
        conflictKey: '123',
        secretToken: 'should-not-log'
      }), { scope: 'db.test' });
    });

    await sleep(50);
    await AECS.shutdown();

    const files = listJsonlFiles(logDir);
    expect(files.length).toBeGreaterThan(0);

    const lines = fs.readFileSync(files[0], 'utf8').trim().split('\n').filter(Boolean);
    expect(lines.length).toBeGreaterThan(0);

    const row = JSON.parse(lines[0]);
    expect(row.code).toBe('DB-104');
    expect(row.meta.table).toBe('recruits');
    expect(row.meta.secretToken).toBeUndefined();
    expect(typeof row.supportId).toBe('string');
    expect(row.supportId).toHaveLength(7);
  });

  test('packHandshake and unpackHandshake preserve trace id', async () => {
    let outerTraceId = null;
    let innerTraceId = null;

    await AECS.runWithTrace({ traceId: 'tx-handshake-1', source: 'unit' }, async () => {
      outerTraceId = AECS.getContext().traceId;
      const token = AECS.packHandshake();
      await AECS.unpackHandshake(token, async () => {
        innerTraceId = AECS.getContext().traceId;
      });
    });

    expect(innerTraceId).toBe(outerTraceId);
  });

  test('applies schema pruning for API-502', async () => {
    await AECS.runWithTrace({ traceId: 'tx-schema-1', command: 'antinuke_status' }, async () => {
      await AECS.dispatch(new CodexError('API-502', {
        userId: '999',
        status: 502,
        apiResponse: { token: 'leak' }
      }), { scope: 'api.test' });
    });

    await sleep(50);
    await AECS.shutdown();

    const files = listJsonlFiles(logDir);
    const rows = fs.readFileSync(files[0], 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
    const entry = rows.find((row) => row.code === 'API-502');

    expect(entry).toBeTruthy();
    expect(entry.meta.apiResponse).toBe('[Object Rejected By Schema]');
  });
});

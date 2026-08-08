const fs = require('fs');
const os = require('os');
const path = require('path');
const cli = require('../utils/aecs-cli');

function makeRecord(overrides = {}) {
  return {
    timestamp: Date.now(),
    code: 'RECRUIT-500',
    severity: 'ERROR',
    impact: 70,
    scope: 'service.recruit',
    message: 'Test error',
    traceId: 'tx-test-1',
    ...overrides
  };
}

describe('AECS CLI utility', () => {
  let logDir;

  beforeEach(() => {
    logDir = path.join(os.tmpdir(), `aecs-cli-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(logDir, { recursive: true });
  });

  afterEach(() => {
    if (logDir && fs.existsSync(logDir)) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  describe('parseArgs', () => {
    test('parses short flags', () => {
      const args = cli.parseArgs(['-d', '/tmp/logs', '-c', 'DB-502', '-n', '5']);
      expect(args.logDir).toBe('/tmp/logs');
      expect(args.code).toBe('DB-502');
      expect(args.limit).toBe(5);
    });

    test('parses long flags', () => {
      const args = cli.parseArgs(['--code', 'SYS-500', '--severity', 'FATAL', '--limit', '20']);
      expect(args.code).toBe('SYS-500');
      expect(args.severity).toBe('FATAL');
      expect(args.limit).toBe(20);
    });

    test('parses trace and search', () => {
      const args = cli.parseArgs(['--trace', 'tx-abc', '--search', 'recruit']);
      expect(args.trace).toBe('tx-abc');
      expect(args.search).toBe('recruit');
    });

    test('parses boolean flags', () => {
      const args = cli.parseArgs(['--json', '--follow', '--summary']);
      expect(args.json).toBe(true);
      expect(args.follow).toBe(true);
      expect(args.summary).toBe(true);
    });

    test('defaults are correct', () => {
      const args = cli.parseArgs([]);
      expect(args.limit).toBe(50);
      expect(args.json).toBe(false);
      expect(args.follow).toBe(false);
      expect(args.summary).toBe(false);
    });
  });

  describe('parseDurationMs', () => {
    test('parses hours', () => {
      expect(cli.parseDurationMs('1h')).toBe(3600000);
      expect(cli.parseDurationMs('2hrs')).toBe(7200000);
    });

    test('parses minutes', () => {
      expect(cli.parseDurationMs('5m')).toBe(300000);
      expect(cli.parseDurationMs('10min')).toBe(600000);
    });

    test('parses days', () => {
      expect(cli.parseDurationMs('1d')).toBe(86400000);
      expect(cli.parseDurationMs('2days')).toBe(172800000);
    });

    test('parses seconds', () => {
      expect(cli.parseDurationMs('30s')).toBe(30000);
    });

    test('returns null for invalid input', () => {
      expect(cli.parseDurationMs('')).toBeNull();
      expect(cli.parseDurationMs('abc')).toBeNull();
      expect(cli.parseDurationMs('0h')).toBeNull();
    });
  });

  describe('filterRecords', () => {
    test('filters by code', () => {
      const records = [makeRecord({ code: 'DB-502' }), makeRecord({ code: 'SYS-500' })];
      const filtered = cli.filterRecords(records, { code: 'DB-502' });
      expect(filtered.length).toBe(1);
      expect(filtered[0].code).toBe('DB-502');
    });

    test('filters by severity', () => {
      const records = [makeRecord({ severity: 'ERROR' }), makeRecord({ severity: 'WARN' })];
      const filtered = cli.filterRecords(records, { severity: 'FATAL' });
      expect(filtered.length).toBe(0);
    });

    test('filters by trace ID (partial)', () => {
      const records = [
        makeRecord({ traceId: 'tx-abc-123' }),
        makeRecord({ traceId: 'tx-def-456' })
      ];
      const filtered = cli.filterRecords(records, { trace: 'abc' });
      expect(filtered.length).toBe(1);
      expect(filtered[0].traceId).toBe('tx-abc-123');
    });

    test('filters by search substring', () => {
      const records = [
        makeRecord({ code: 'DB-502', scope: 'service.recruit.execute' }),
        makeRecord({ code: 'SYS-500', scope: 'service.invite.create' })
      ];
      const filtered = cli.filterRecords(records, { search: 'recruit' });
      expect(filtered.length).toBe(1);
    });

    test('filters by recent duration', () => {
      const oldTime = Date.now() - 2 * 3600000;
      const records = [
        makeRecord({ timestamp: oldTime }),
        makeRecord({ timestamp: Date.now() })
      ];
      const filtered = cli.filterRecords(records, { recent: '1h' });
      expect(filtered.length).toBe(1);
      expect(filtered[0].timestamp).toBeCloseTo(Date.now(), -2);
    });

    test('passes through when no filters', () => {
      const records = [makeRecord(), makeRecord()];
      const filtered = cli.filterRecords(records, { code: null, severity: null, trace: null, search: null, recent: null });
      expect(filtered.length).toBe(2);
    });
  });

  describe('formatRecord', () => {
    test('formats as text by default', () => {
      const rec = makeRecord();
      const result = cli.formatRecord(rec, false);
      expect(result).toContain('RECRUIT-500');
      expect(result).toContain('ERROR');
      expect(result).toContain('service.recruit');
    });

    test('formats as JSON when requested', () => {
      const rec = makeRecord();
      const result = cli.formatRecord(rec, true);
      const parsed = JSON.parse(result);
      expect(parsed.code).toBe('RECRUIT-500');
      expect(parsed.severity).toBe('ERROR');
    });

    test('pads severity field', () => {
      const rec = makeRecord({ severity: 'WARN' });
      const result = cli.formatRecord(rec, false);
      expect(result).toContain('WARN ');
    });
  });

  describe('readRecordsFromFiles', () => {
    test('reads JSONL records from files', () => {
      const rec1 = makeRecord({ code: 'DB-502' });
      const rec2 = makeRecord({ code: 'SYS-500' });
      fs.writeFileSync(
        path.join(logDir, 'aecs-2025-01-01.jsonl'),
        `${JSON.stringify(rec1)}\n${JSON.stringify(rec2)}\n`
      );

      const records = cli.readRecordsFromFiles([path.join(logDir, 'aecs-2025-01-01.jsonl')]);
      expect(records.length).toBe(2);
      expect(records[0].code).toBe('DB-502');
      expect(records[1].code).toBe('SYS-500');
    });

    test('skips malformed lines', () => {
      fs.writeFileSync(
        path.join(logDir, 'aecs-2025-01-01.jsonl'),
        'not json at all\n{"code":"DB-502"}\n{broken\n'
      );

      const records = cli.readRecordsFromFiles([path.join(logDir, 'aecs-2025-01-01.jsonl')]);
      expect(records.length).toBe(1);
      expect(records[0].code).toBe('DB-502');
    });
  });

  describe('printSummary', () => {
    test('prints summary with severity counts', () => {
      const records = [
        makeRecord({ severity: 'INFO' }),
        makeRecord({ severity: 'WARN' }),
        makeRecord({ severity: 'ERROR' }),
        makeRecord({ severity: 'FATAL' })
      ];

      const originalLog = console.log;
      const output = [];
      console.log = (...args) => output.push(args.join(' '));

      try {
        cli.printSummary(records);
      } finally {
        console.log = originalLog;
      }

      const text = output.join('\n');
      expect(text).toContain('INFO:   1');
      expect(text).toContain('WARN:   1');
      expect(text).toContain('ERROR:  1');
      expect(text).toContain('FATAL:  1');
    });
  });

  describe('listJsonlFiles', () => {
    test('returns only .jsonl files sorted', () => {
      fs.writeFileSync(path.join(logDir, 'aecs-2025-01-02.jsonl'), 'test');
      fs.writeFileSync(path.join(logDir, 'aecs-2025-01-01.jsonl'), 'test');
      fs.writeFileSync(path.join(logDir, 'other.txt'), 'test');

      const files = cli.listJsonlFiles(logDir);
      expect(files.length).toBe(2);
      expect(files[0]).toContain('aecs-2025-01-01.jsonl');
      expect(files[1]).toContain('aecs-2025-01-02.jsonl');
    });

    test('returns empty for non-existent dir', () => {
      const files = cli.listJsonlFiles('/nonexistent/path');
      expect(files).toEqual([]);
    });
  });
});

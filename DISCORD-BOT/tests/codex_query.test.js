const fs = require('fs');
const os = require('os');
const path = require('path');

const {
  rebuildIdxForFile,
  ensureIdxIntegrity,
  createSessionDb,
  ingestLogsToSqlite
} = require('../utils/codex-query');

describe('codex-query utilities', () => {
  test('rebuilds idx and ingests jsonl records to sqlite', async () => {
    const root = path.join(os.tmpdir(), `codex-query-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    fs.mkdirSync(root, { recursive: true });

    const logPath = path.join(root, 'aecs-2026-02-22.jsonl');
    const rows = [
      {
        timestamp: Date.now() - 1000,
        traceId: 'tx-1',
        supportId: 'ABC1234',
        code: 'CMD-500',
        severity: 'ERROR',
        impact: 70,
        scope: 'command',
        domain: 'CMD',
        message: 'Command failed',
        meta: { userId: '1', guildId: '10', command: 'recruit' }
      },
      {
        timestamp: Date.now(),
        traceId: 'tx-2',
        supportId: 'DEF5678',
        code: 'DB-104',
        severity: 'ERROR',
        impact: 60,
        scope: 'db',
        domain: 'DB',
        message: 'Constraint',
        meta: { userId: '2', guildId: '10', command: 'status' }
      }
    ];

    fs.writeFileSync(logPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

    const idxPath = await rebuildIdxForFile(logPath);
    expect(fs.existsSync(idxPath)).toBe(true);
    expect(fs.statSync(idxPath).size).toBe(32);

    const integrity = await ensureIdxIntegrity(logPath);
    expect(integrity.rebuilt).toBe(false);

    const { db, dbPath } = await createSessionDb();
    try {
      await ingestLogsToSqlite(db, [logPath], {});
      const inserted = await db.all('SELECT code, user_id as userId, guild_id as guildId FROM logs ORDER BY timestamp ASC');
      expect(inserted).toHaveLength(2);
      expect(inserted[0].code).toBe('CMD-500');
      expect(inserted[1].code).toBe('DB-104');
      expect(inserted[0].userId).toBe('1');
      expect(inserted[1].guildId).toBe('10');
    } finally {
      await db.close();
      if (fs.existsSync(dbPath)) fs.rmSync(dbPath, { force: true });
      if (fs.existsSync(`${dbPath}-wal`)) fs.rmSync(`${dbPath}-wal`, { force: true });
      if (fs.existsSync(`${dbPath}-shm`)) fs.rmSync(`${dbPath}-shm`, { force: true });
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});

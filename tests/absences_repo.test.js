const sqlite3 = require('sqlite3');
const { open } = require('sqlite');

describe('absences repo overlap handling', () => {
  async function createDb() {
    const db = await open({ filename: ':memory:', driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS absences (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT NOT NULL,
        recruiter_id TEXT NOT NULL,
        start_date TEXT NOT NULL,
        end_date TEXT NOT NULL,
        created_at INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        active INTEGER DEFAULT 1
      );
    `);
    return db;
  }

  test('extends existing active absence window instead of creating duplicates', async () => {
    const db = await createDb();
    const repo = require('../src/repos/absences-repo');

    await db.run(
      'INSERT INTO absences (guild_id, recruiter_id, start_date, end_date, created_at, created_by, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
      'G1',
      'U1',
      '2026-02-05',
      '2026-02-10',
      Date.now(),
      'admin'
    );

    const row = await repo.upsertActive(db, 'G1', 'U1', {
      startDate: '2026-02-07',
      endDate: '2026-02-12',
      createdBy: 'admin2'
    });

    expect(row.start_date).toBe('2026-02-05');
    expect(row.end_date).toBe('2026-02-12');

    const rows = await db.all('SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ?', 'G1', 'U1');
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(1);
    expect(rows[0].start_date).toBe('2026-02-05');
    expect(rows[0].end_date).toBe('2026-02-12');

    await db.close();
  });

  test('reactivates and merges with overlapping historical absence', async () => {
    const db = await createDb();
    const repo = require('../src/repos/absences-repo');

    await db.run(
      'INSERT INTO absences (guild_id, recruiter_id, start_date, end_date, created_at, created_by, active) VALUES (?, ?, ?, ?, ?, ?, 0)',
      'G1',
      'U1',
      '2026-02-01',
      '2026-02-10',
      Date.now(),
      'admin'
    );

    const row = await repo.upsertActive(db, 'G1', 'U1', {
      startDate: '2026-02-08',
      endDate: '2026-02-15',
      createdBy: 'admin2'
    });

    expect(row.active).toBe(1);
    expect(row.start_date).toBe('2026-02-01');
    expect(row.end_date).toBe('2026-02-15');

    const rows = await db.all('SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ?', 'G1', 'U1');
    expect(rows).toHaveLength(1);
    expect(rows[0].active).toBe(1);
    expect(rows[0].start_date).toBe('2026-02-01');
    expect(rows[0].end_date).toBe('2026-02-15');

    await db.close();
  });
});

const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { runReferentialPreflight } = require('../src/lib/db-referential-preflight');

async function createDb() {
  return open({ filename: ':memory:', driver: sqlite3.Database });
}

describe('db referential preflight', () => {
  test('inserts missing recruiters and removes malformed rows when fix is enabled', async () => {
    const db = await createDb();
    await db.exec(`
      CREATE TABLE recruiters (
        guild_id TEXT NOT NULL,
        id TEXT NOT NULL,
        points INTEGER DEFAULT 0,
        warnings INTEGER DEFAULT 0,
        promoted INTEGER DEFAULT 0,
        channel_base INTEGER DEFAULT 4,
        PRIMARY KEY (guild_id, id)
      );
      CREATE TABLE warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        recruiter_id TEXT,
        created_at INTEGER
      );
    `);

    await db.run('INSERT INTO warnings (guild_id, recruiter_id, created_at) VALUES (?, ?, ?)', 'G1', 'R_MISSING', Date.now());
    await db.run('INSERT INTO warnings (guild_id, recruiter_id, created_at) VALUES (?, ?, ?)', '', '', Date.now());

    const summary = await runReferentialPreflight(db, { fix: true, log: false });
    const recruiter = await db.get('SELECT * FROM recruiters WHERE guild_id = ? AND id = ?', 'G1', 'R_MISSING');
    const malformedCount = await db.get("SELECT COUNT(1) AS c FROM warnings WHERE guild_id = '' OR recruiter_id = ''");

    expect(summary.insertedRecruiters).toBeGreaterThanOrEqual(1);
    expect(recruiter).toBeTruthy();
    expect(Number(malformedCount.c)).toBe(0);
    expect(summary.unresolved).toEqual([]);

    await db.close();
  });

  test('reports unresolved refs in check-only mode', async () => {
    const db = await createDb();
    await db.exec(`
      CREATE TABLE recruiters (
        guild_id TEXT NOT NULL,
        id TEXT NOT NULL,
        points INTEGER DEFAULT 0,
        warnings INTEGER DEFAULT 0,
        promoted INTEGER DEFAULT 0,
        channel_base INTEGER DEFAULT 4,
        PRIMARY KEY (guild_id, id)
      );
      CREATE TABLE warnings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        guild_id TEXT,
        recruiter_id TEXT,
        created_at INTEGER
      );
    `);

    await db.run('INSERT INTO warnings (guild_id, recruiter_id, created_at) VALUES (?, ?, ?)', 'G2', 'R2', Date.now());

    const summary = await runReferentialPreflight(db, { fix: false, log: false });
    const recruiter = await db.get('SELECT * FROM recruiters WHERE guild_id = ? AND id = ?', 'G2', 'R2');

    expect(summary.unresolved.length).toBeGreaterThanOrEqual(1);
    expect(recruiter).toBeFalsy();

    await db.close();
  });
});

jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

function makeTempDbPath() {
  const tmp = require('os').tmpdir();
  return path.join(tmp, `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

async function makeDb(dbPath) {
  const sqlite3 = require('sqlite3');
  const { open } = require('sqlite');
  const db = await open({ filename: dbPath, driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE IF NOT EXISTS recruiters ( guild_id TEXT NOT NULL, id TEXT NOT NULL, points INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, promoted INTEGER DEFAULT 0, channel_base INTEGER DEFAULT 4, PRIMARY KEY (guild_id, id) );
    CREATE TABLE IF NOT EXISTS recruits ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, recruited_id TEXT NOT NULL, region TEXT NOT NULL, ign TEXT, created_at INTEGER NOT NULL, valid INTEGER DEFAULT 1, points INTEGER DEFAULT 0 );
  `);
  return db;
}

describe('member leave handling', () => {
  let dbPath;
  beforeEach(() => {
    dbPath = makeTempDbPath();
    process.env.DATABASE_PATH = dbPath;
  });
  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('removes recruit but does NOT deduct points from recruiter', async () => {
    const db = await makeDb(dbPath);
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)', 'GLOBAL', 'R1', 100);
    const now = Date.now();
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', 'GLOBAL', 'R1', 'Mleave', 'EU', 'x', now, 25);

    const { handleMemberLeave } = require('../src/lib/memberLeave');
    await handleMemberLeave(db, null, { id: 'Mleave', guild: { id: 'GLOBAL' } });

    const rec = await db.get('SELECT * FROM recruits WHERE recruited_id = ?', 'Mleave');
    expect(rec.valid).toBe(0);
    const r = await db.get('SELECT * FROM recruiters WHERE id = ?', 'R1');
    expect(r.points).toBe(100);

    await db.close();
  });
});

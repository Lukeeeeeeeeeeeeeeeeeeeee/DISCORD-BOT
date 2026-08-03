const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const path = require('path');
const fs = require('fs');

function makeTempDbPath() {
  const tmp = require('os').tmpdir();
  return path.join(tmp, `rookie-points-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeMember(id = 'rookie-1') {
  const { ROLE_IDS } = require('../src/constants');
  return {
    id,
    user: { username: 'RookieUser' },
    nickname: 'RookieUser',
    manageable: false,
    roles: {
      cache: {
        has: (roleId) => roleId === ROLE_IDS.ROOKIE
      }
    },
    setNickname: jest.fn().mockResolvedValue(true)
  };
}

describe('rookie points atomic updates', () => {
  let db;
  let dbPath;

  beforeEach(async () => {
    dbPath = makeTempDbPath();
    db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS rookie_points (
        guild_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        points REAL NOT NULL,
        updated_at INTEGER NOT NULL,
        PRIMARY KEY (guild_id, member_id)
      );
    `);
  });

  afterEach(async () => {
    if (db) await db.close();
    try { fs.unlinkSync(dbPath); } catch (e) { console.error(e); }
  });

  test('concurrent addRookiePoints does not lose increments', async () => {
    const { addRookiePoints } = require('../src/lib/rookie-points');
    const member = makeMember('rookie-concurrent');
    const guild = { id: 'G1' };

    await Promise.all(Array.from({ length: 10 }, () => addRookiePoints({
      db,
      member,
      guild,
      delta: 0.5,
      verifierId: 'verifier'
    })));

    const row = await db.get('SELECT points FROM rookie_points WHERE guild_id = ? AND member_id = ?', 'G1', member.id);
    expect(Number(row.points)).toBe(5);
  });

  test('getLinkedPoints does not seed points from nickname', async () => {
    const { getLinkedPoints } = require('../src/lib/rookie-points');
    const member = makeMember('rookie-seed');
    member.nickname = 'SeededUser 9/10';

    const info = await getLinkedPoints({ db, member, guild: { id: 'G1' } });
    expect(info.points).toBe(0);

    const row = await db.get('SELECT points FROM rookie_points WHERE guild_id = ? AND member_id = ?', 'G1', member.id);
    expect(row).toBeUndefined();
  });

  test('parseRookieNickname rejects scientific notation point tokens', () => {
    const { parseRookieNickname } = require('../src/lib/rookie-points');
    const parsed = parseRookieNickname('SeededUser 1e5/10');
    expect(parsed.points).toBeNull();
  });
});


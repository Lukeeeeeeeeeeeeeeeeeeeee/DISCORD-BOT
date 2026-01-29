jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

const makeTempDbPath = () => path.join(require('os').tmpdir(), `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function makeGuildMock(_db) {
  // Create mock channels with send and message store
  const createChannel = (id) => {
    const messages = new Map();
    return {
      id,
      messages: {
        fetch: jest.fn(async (mid) => messages.get(mid) || Promise.reject(new Error('Not found'))),
      },
      send: jest.fn(async (payload) => {
        // create a fake message object
        const id = `m${Math.random().toString(36).slice(2)}`;
        const msg = { id, edit: jest.fn(async () => true), content: typeof payload === 'string' ? payload : (payload.content || ''), embeds: payload.embeds || [] };
        messages.set(id, msg);
        return msg;
      })
    };
  };

  const channels = new Map();
  channels.set('EU_CH', createChannel('EU_CH'));
  channels.set('NA_CH', createChannel('NA_CH'));
  channels.set('AS_CH', createChannel('AS_CH'));
  channels.set('CENTRAL', createChannel('CENTRAL'));

  return {
    channels: { cache: { get: (id) => channels.get(id) } }
  };
}

describe('scheduler recompute & persistence', () => {
  let dbPath, db;
  beforeEach(async () => {
    dbPath = makeTempDbPath();
    process.env.DATABASE_PATH = dbPath;
    // Create a fresh DB directly for test isolation
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    db = await open({ filename: dbPath, driver: sqlite3.Database });
    // create minimal schema used by tests
    await db.exec(`
      CREATE TABLE IF NOT EXISTS recruiters ( id TEXT PRIMARY KEY, points INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, promoted INTEGER DEFAULT 0 );
      CREATE TABLE IF NOT EXISTS recruits ( id INTEGER PRIMARY KEY AUTOINCREMENT, recruiter_id TEXT NOT NULL, recruited_id TEXT NOT NULL, region TEXT NOT NULL, ign TEXT, created_at INTEGER NOT NULL, valid INTEGER DEFAULT 1 );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_recruit ON recruits(recruited_id);
      CREATE TABLE IF NOT EXISTS leaderboard_messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, region TEXT, updated_at INTEGER NOT NULL );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(channel_id, region);
      CREATE TABLE IF NOT EXISTS warnings ( id INTEGER PRIMARY KEY AUTOINCREMENT, recruiter_id TEXT NOT NULL, created_at INTEGER NOT NULL, note TEXT, revoked INTEGER DEFAULT 0, expired_at INTEGER );
    `);
  });
  afterEach(async () => {
    try { await db.close(); } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('recomputeLeaderboards writes leaderboard_messages on new messages', async () => {
    const scheduler = require('../src/scheduler');

    // Insert some recruits into EU
    const now = Date.now();
    await db.run('INSERT INTO recruiters (id, points, warnings, promoted) VALUES (?, 0, 0, 0)', 'A');
    await db.run('INSERT INTO recruiters (id, points, warnings, promoted) VALUES (?, 0, 0, 0)', 'B');
    await db.run('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, 1)', 'A','u1','EU','x', now);
    await db.run('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, 1)', 'B','u2','EU','y', now);
    await db.run('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, 1)', 'A','u3','EU','z', now);

    const guild = makeGuildMock(db);
    // patch constants to use our channel ids
    const consts = require('../src/constants');
    consts.CHANNELS.INVITES_EU = 'EU_CH';
    consts.CHANNELS.CENTRAL_LEADERBOARD = 'CENTRAL';

    await scheduler.recomputeLeaderboards(db, guild);

    // Check DB for entries for EU in leaderboard_messages
    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'EU_CH', 'EU');
    expect(row).toBeDefined();
    expect(row.message_id).toBeTruthy();

    // Running again should update existing record (message exists)
    await scheduler.recomputeLeaderboards(db, guild);
    const row2 = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'EU_CH', 'EU');
    expect(row2).toBeDefined();
    expect(row2.id).toBe(row.id);
    expect(row2.updated_at).toBeGreaterThanOrEqual(row.updated_at);
  });

  test('formatLeaderboardMessage lists recruiters and counts', () => {
    const scheduler = require('../src/scheduler');
    const rows = [{recruiter_id: 'A', cnt: 1, points: 10},{recruiter_id:'B', cnt:1, points:5}];
    const text = scheduler.formatLeaderboardMessage(rows, 'EU');
    expect(text).toMatch(/A/);
    expect(text).toMatch(/B/);
    expect(text).toMatch(/recruits/);
  });
});

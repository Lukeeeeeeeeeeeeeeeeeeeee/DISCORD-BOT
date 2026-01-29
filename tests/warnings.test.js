jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

const makeTempDbPath = () => path.join(require('os').tmpdir(), `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function makeGuildMock() {
  const createChannel = (id) => {
    const messages = new Map();
    return {
      id,
      messages: { fetch: jest.fn(async () => Promise.reject(new Error('Not implemented'))) },
      send: jest.fn(async (payload) => {
        const id = `m${Math.random().toString(36).slice(2)}`;
        const msg = { id, edit: jest.fn(async () => true), content: payload.content || '', embeds: payload.embeds || [] };
        messages.set(id, msg);
        return msg;
      })
    };
  };

  const channels = new Map();
  channels.set('WARN_CH', createChannel('WARN_CH'));

  return {
    channels: { cache: { get: (id) => channels.get(id) } }
  };
}

describe('warnings leaderboard', () => {
  let dbPath, db;
  beforeEach(async () => {
    dbPath = makeTempDbPath();
    process.env.DATABASE_PATH = dbPath;
    const sqlite3 = require('sqlite3');
    const { open } = require('sqlite');
    db = await open({ filename: dbPath, driver: sqlite3.Database });
    await db.exec(`
      CREATE TABLE IF NOT EXISTS recruiters ( id TEXT PRIMARY KEY, points INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, promoted INTEGER DEFAULT 0 );
      CREATE TABLE IF NOT EXISTS warnings ( id INTEGER PRIMARY KEY AUTOINCREMENT, recruiter_id TEXT NOT NULL, created_at INTEGER NOT NULL, note TEXT, revoked INTEGER DEFAULT 0, expired_at INTEGER );
      CREATE TABLE IF NOT EXISTS leaderboard_messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, region TEXT, updated_at INTEGER NOT NULL );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(channel_id, region);
    `);
  });
  afterEach(async () => {
    try { await db.close(); } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('recomputeWarningsLeaderboard posts/upserts a leaderboard message', async () => {
    const scheduler = require('../src/scheduler');
    // Insert warnings
    await db.run('INSERT INTO warnings (recruiter_id, created_at, note) VALUES (?, ?, ?)', 'A', Date.now(), 'x');
    await db.run('INSERT INTO warnings (recruiter_id, created_at, note) VALUES (?, ?, ?)', 'A', Date.now(), 'y');
    await db.run('INSERT INTO warnings (recruiter_id, created_at, note) VALUES (?, ?, ?)', 'B', Date.now(), 'z');

    const guild = makeGuildMock();
    const consts = require('../src/constants');
    consts.CHANNELS.RECRUITER_WARNINGS = 'WARN_CH';

    await scheduler.recomputeWarningsLeaderboard(db, guild);

    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ?', 'WARN_CH');
    expect(row).toBeDefined();
    expect(row.region).toBe('WARNINGS');
    expect(row.message_id).toBeTruthy();
  });
});

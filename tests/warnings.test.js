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
    id: 'GLOBAL',
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
    await db.exec('DROP TABLE IF EXISTS recruiters; DROP TABLE IF EXISTS warnings; DROP TABLE IF EXISTS leaderboard_messages;');
    await db.exec(`
      CREATE TABLE recruiters ( guild_id TEXT NOT NULL, id TEXT NOT NULL, points INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, promoted INTEGER DEFAULT 0, channel_base INTEGER DEFAULT 4, PRIMARY KEY (guild_id, id) );
      CREATE TABLE warnings ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, created_at INTEGER NOT NULL, note TEXT, revoked INTEGER DEFAULT 0, expired_at INTEGER );
      CREATE TABLE leaderboard_messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, region TEXT, updated_at INTEGER NOT NULL );
      CREATE UNIQUE INDEX uniq_leaderboard_channel_region ON leaderboard_messages(guild_id, channel_id, region);
    `);
  });
  afterEach(async () => {
    try { await db.close(); } catch (e) { console.error(e); }
    try { fs.unlinkSync(dbPath); } catch (e) { console.error(e); }
  });

  test('recomputeWarningsLeaderboard posts/upserts a leaderboard message', async () => {
    const scheduler = require('../src/scheduler');
    // Insert warnings
    await db.run('INSERT INTO warnings (guild_id, recruiter_id, created_at, note) VALUES (?, ?, ?, ?)', 'GLOBAL', 'A', Date.now(), 'x');
    await db.run('INSERT INTO warnings (guild_id, recruiter_id, created_at, note) VALUES (?, ?, ?, ?)', 'GLOBAL', 'A', Date.now(), 'y');
    await db.run('INSERT INTO warnings (guild_id, recruiter_id, created_at, note) VALUES (?, ?, ?, ?)', 'GLOBAL', 'B', Date.now(), 'z');

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


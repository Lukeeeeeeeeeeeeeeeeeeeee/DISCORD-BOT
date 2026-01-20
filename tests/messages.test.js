const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { upsertLeaderboardMessage } = require('../src/lib/messages');

async function makeDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE leaderboard_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      region TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(channel_id, region)');
  return db;
}

describe('upsertLeaderboardMessage', () => {
  test('inserts a new message record when none exists', async () => {
    const db = await makeDb();
    const channel = {
      id: 'chan-1',
      messages: { fetch: jest.fn() },
      send: jest.fn(async (opts) => ({ id: 'm-1', content: opts.content, embeds: opts.embeds }))
    };

    const res = await upsertLeaderboardMessage(db, channel, 'EU', 'hello', null);
    expect(channel.send).toHaveBeenCalled();
    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', channel.id, 'EU');
    expect(row).toBeDefined();
    expect(row.message_id).toBe('m-1');
  });

  test('edits existing message when present', async () => {
    const db = await makeDb();
    // pre-insert record
    await db.run('INSERT INTO leaderboard_messages (channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?)', 'chan-2', 'm-2', 'NA', Date.now());

    let edited = false;
    const channel = {
      id: 'chan-2',
      messages: { fetch: jest.fn(async (id) => ({ id, edit: async (content) => { edited = true; return { id }; } })) },
      send: jest.fn(async (opts) => ({ id: 'm-new' }))
    };

    const res = await upsertLeaderboardMessage(db, channel, 'NA', 'updated', null);
    expect(edited).toBe(true);
    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', channel.id, 'NA');
    expect(row.message_id).toBe('m-2');
  });
});
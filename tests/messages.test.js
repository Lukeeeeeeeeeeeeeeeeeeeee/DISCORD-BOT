const sqlite3 = require('sqlite3');
const { open } = require('sqlite');
const { upsertLeaderboardMessage } = require('../src/lib/messages');

async function makeDb() {
  const db = await open({ filename: ':memory:', driver: sqlite3.Database });
  await db.exec(`
    CREATE TABLE leaderboard_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      guild_id TEXT NOT NULL,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      region TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  await db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(guild_id, channel_id, region)');
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

    await upsertLeaderboardMessage(db, channel, 'EU', 'hello', null, 'GLOBAL');
    expect(channel.send).toHaveBeenCalled();
    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', channel.id, 'EU');
    expect(row).toBeDefined();
    expect(row.message_id).toBe('m-1');
  });

  test('edits existing message when present', async () => {
    const db = await makeDb();
    // pre-insert record
    await db.run('INSERT INTO leaderboard_messages (guild_id, channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?, ?)', 'GLOBAL', 'chan-2', 'm-2', 'NA', Date.now());

    let edited = false;
    const channel = {
      id: 'chan-2',
      messages: { fetch: jest.fn(async (id) => ({ id, edit: async (_content) => { edited = true; return { id }; } })) },
      send: jest.fn(async (_opts) => ({ id: 'm-new' }))
    };

    await upsertLeaderboardMessage(db, channel, 'NA', 'updated', null, 'GLOBAL');
    expect(edited).toBe(true);
    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', channel.id, 'NA');
    expect(row.message_id).toBe('m-2');
  });

  test('concurrent upserts create only one new message record', async () => {
    const db = await makeDb();
    let sendCount = 0;
    const channel = {
      id: 'chan-race',
      messages: {
        fetch: jest.fn(async (id) => ({ id, edit: async () => ({ id }) })),
        edit: jest.fn(async (id) => ({ id }))
      },
      send: jest.fn(async () => {
        sendCount += 1;
        return { id: `m-race-${sendCount}` };
      })
    };

    await Promise.all([
      upsertLeaderboardMessage(db, channel, 'EU', 'race', null, 'GLOBAL'),
      upsertLeaderboardMessage(db, channel, 'EU', 'race', null, 'GLOBAL')
    ]);

    const row = await db.get('SELECT * FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND region = ?', 'GLOBAL', channel.id, 'EU');
    expect(row).toBeDefined();
    expect(sendCount).toBe(1);
    expect(row.message_id).toBe('m-race-1');
  });
});

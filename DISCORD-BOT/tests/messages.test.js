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

  test('reuses existing bot leaderboard message when DB row is missing', async () => {
    const db = await makeDb();
    let edited = false;
    const existingMsg = {
      id: 'm-existing',
      content: '# 🔥 Fire Leaderboard\nold',
      author: { id: 'bot-1' },
      edit: jest.fn(async () => { edited = true; return { id: 'm-existing' }; })
    };
    const channel = {
      id: 'chan-3',
      client: { user: { id: 'bot-1' } },
      messages: {
        fetch: jest.fn(async (arg) => {
          if (typeof arg === 'object') {
            return {
              values: () => [existingMsg]
            };
          }
          return null;
        })
      },
      send: jest.fn(async () => ({ id: 'm-new' }))
    };

    await upsertLeaderboardMessage(db, channel, 'EU', 'updated', null, 'GLOBAL');

    expect(edited).toBe(true);
    expect(channel.send).not.toHaveBeenCalled();
    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', channel.id, 'EU');
    expect(row).toBeDefined();
    expect(row.message_id).toBe('m-existing');
  });

  test('collapses duplicate rows and keeps canonical record', async () => {
    const db = await makeDb();
    await db.exec('DROP INDEX IF EXISTS uniq_leaderboard_channel_region');
    await db.run(
      'INSERT INTO leaderboard_messages (guild_id, channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?, ?)',
      'GLOBAL',
      'chan-4',
      'm-old',
      'NA',
      1
    );
    await db.run(
      'INSERT INTO leaderboard_messages (guild_id, channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?, ?)',
      'GLOBAL',
      'chan-4',
      'm-new',
      'NA',
      2
    );

    const channel = {
      id: 'chan-4',
      messages: { fetch: jest.fn(async (id) => ({ id, edit: async () => ({ id }) })) },
      send: jest.fn(async () => ({ id: 'm-created' }))
    };

    await upsertLeaderboardMessage(db, channel, 'NA', 'updated', null, 'GLOBAL');

    const rows = await db.all('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', channel.id, 'NA');
    expect(rows.length).toBe(1);
    expect(rows[0].message_id).toBe('m-new');
    expect(channel.send).not.toHaveBeenCalled();
  });
});

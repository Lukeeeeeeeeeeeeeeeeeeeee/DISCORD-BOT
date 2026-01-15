const Database = require('better-sqlite3');
const { upsertLeaderboardMessage } = require('../src/lib/messages');

function makeDb() {
  const db = new Database(':memory:');
  db.exec(`
    CREATE TABLE leaderboard_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      region TEXT,
      updated_at INTEGER NOT NULL
    );
  `);
  db.exec('CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(channel_id, region)');
  return db;
}

describe('upsertLeaderboardMessage', () => {
  test('inserts a new message record when none exists', async () => {
    const db = makeDb();
    const channel = {
      id: 'chan-1',
      messages: { fetch: jest.fn() },
      send: jest.fn(async (opts) => ({ id: 'm-1', content: opts.content, embeds: opts.embeds }))
    };

    const res = await upsertLeaderboardMessage(db, channel, 'EU', 'hello', null);
    expect(channel.send).toHaveBeenCalled();
    const row = db.prepare('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?').get(channel.id, 'EU');
    expect(row).toBeDefined();
    expect(row.message_id).toBe('m-1');
  });

  test('edits existing message when present', async () => {
    const db = makeDb();
    // pre-insert record
    db.prepare('INSERT INTO leaderboard_messages (channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?)').run('chan-2', 'm-2', 'NA', Date.now());

    let edited = false;
    const channel = {
      id: 'chan-2',
      messages: { fetch: jest.fn(async (id) => ({ id, edit: async (content) => { edited = true; return { id }; } })) },
      send: jest.fn(async (opts) => ({ id: 'm-new' }))
    };

    const res = await upsertLeaderboardMessage(db, channel, 'NA', 'updated', null);
    expect(edited).toBe(true);
    const row = db.prepare('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?').get(channel.id, 'NA');
    expect(row.message_id).toBe('m-2');
  });
});
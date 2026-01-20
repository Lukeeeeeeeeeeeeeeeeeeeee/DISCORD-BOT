jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

const makeTempDbPath = () => path.join(require('os').tmpdir(), `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);

function makeGuildMock(db) {
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
  beforeEach(() => {
    dbPath = makeTempDbPath();
    process.env.DATABASE_PATH = dbPath;
    delete require.cache[require.resolve('../src/db.js')];
    db = require('../src/db.js');
  });
  afterEach(() => {
    try { db.close(); } catch (e) {}
    try { fs.unlinkSync(dbPath); } catch (e) {}
  });

  test('recomputeLeaderboards writes leaderboard_messages on new messages', async () => {
    const scheduler = require('../src/scheduler');
    const { upsertLeaderboardMessage } = require('../src/lib/messages');

    // Insert some recruits into EU
    const now = Date.now();
    db.prepare('INSERT INTO recruiters (id, points, warnings, promoted) VALUES (?, 0, 0, 0)').run('A');
    db.prepare('INSERT INTO recruiters (id, points, warnings, promoted) VALUES (?, 0, 0, 0)').run('B');
    db.prepare('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, 1)').run('A','u1','EU','x', now);
    db.prepare('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, 1)').run('B','u2','EU','y', now);
    db.prepare('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, 1)').run('A','u3','EU','z', now);

    const guild = makeGuildMock(db);
    // patch constants to use our channel ids
    const consts = require('../src/constants');
    consts.CHANNELS.INVITES_EU = 'EU_CH';
    consts.CHANNELS.CENTRAL_LEADERBOARD = 'CENTRAL';

    await scheduler.recomputeLeaderboards(db, guild);

    // Check DB for entries for EU in leaderboard_messages
    const row = db.prepare('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?').get('EU_CH', 'EU');
    expect(row).toBeDefined();
    expect(row.message_id).toBeTruthy();

    // Running again should update existing record (message exists)
    await scheduler.recomputeLeaderboards(db, guild);
    const row2 = db.prepare('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?').get('EU_CH', 'EU');
    expect(row2).toBeDefined();
    expect(row2.id).toBe(row.id);
    expect(row2.updated_at).toBeGreaterThanOrEqual(row.updated_at);
  });

  test('formatLeaderboardMessage handles not enough data', () => {
    const scheduler = require('../src/scheduler');
    const rows = [{recruiter_id: 'A', cnt: 1},{recruiter_id:'B', cnt:1}];
    const text = scheduler.formatLeaderboardMessage(rows, 'EU');
    expect(text).toMatch(/Not enough data/);
  });
});

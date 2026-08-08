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
        fetch: jest.fn(async (mid) => {
          if (typeof mid === 'object') {
            return { values: () => Array.from(messages.values()) };
          }
          return messages.get(mid) || Promise.reject(new Error('Not found'));
        }),
      },
      send: jest.fn(async (payload) => {
        // create a fake message object
        const messageId = `m${Math.random().toString(36).slice(2)}`;
        const msg = {
          id: messageId,
          content: typeof payload === 'string' ? payload : (payload.content || ''),
          embeds: payload.embeds || [],
          edit: jest.fn(async (nextPayload) => {
            msg.content = typeof nextPayload === 'string' ? nextPayload : (nextPayload.content || '');
            msg.embeds = nextPayload && nextPayload.embeds ? nextPayload.embeds : [];
            return msg;
          })
        };
        messages.set(messageId, msg);
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
    id: 'GLOBAL',
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
      CREATE TABLE IF NOT EXISTS recruiters ( guild_id TEXT NOT NULL, id TEXT NOT NULL, points INTEGER DEFAULT 0, warnings INTEGER DEFAULT 0, promoted INTEGER DEFAULT 0, channel_base INTEGER DEFAULT 4, PRIMARY KEY (guild_id, id) );
      CREATE TABLE IF NOT EXISTS recruits ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, recruited_id TEXT NOT NULL, region TEXT NOT NULL, ign TEXT, created_at INTEGER NOT NULL, valid INTEGER DEFAULT 1 );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_recruit ON recruits(guild_id, recruited_id);
      CREATE TABLE IF NOT EXISTS leaderboard_messages ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, channel_id TEXT NOT NULL, message_id TEXT NOT NULL, region TEXT, updated_at INTEGER NOT NULL );
      CREATE UNIQUE INDEX IF NOT EXISTS uniq_leaderboard_channel_region ON leaderboard_messages(guild_id, channel_id, region);
      CREATE TABLE IF NOT EXISTS analytics_role_changes ( guild_id TEXT NOT NULL, user_id TEXT NOT NULL, action TEXT NOT NULL, role_id TEXT NOT NULL, created_at INTEGER NOT NULL );
      CREATE TABLE IF NOT EXISTS weekly_calculations ( guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, week_start INTEGER, calculated_min_req INTEGER, timestamp INTEGER );
      CREATE TABLE IF NOT EXISTS weekly_recruit_overrides ( guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, week_start INTEGER NOT NULL, total INTEGER NOT NULL, updated_at INTEGER NOT NULL, updated_by TEXT NOT NULL, note TEXT, PRIMARY KEY (guild_id, recruiter_id, week_start) );
      CREATE TABLE IF NOT EXISTS warnings ( id INTEGER PRIMARY KEY AUTOINCREMENT, guild_id TEXT NOT NULL, recruiter_id TEXT NOT NULL, created_at INTEGER NOT NULL, note TEXT, revoked INTEGER DEFAULT 0, expired_at INTEGER );
    `);
  });
  afterEach(async () => {
    if (Date.now && typeof Date.now.mockRestore === 'function') {
      Date.now.mockRestore();
    }
    try { await db.close(); } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('recomputeLeaderboards writes leaderboard_messages on new messages', async () => {
    const scheduler = require('../src/scheduler');

    // Insert some recruits into EU
    const now = Date.now();
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', 'GLOBAL', 'A');
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', 'GLOBAL', 'B');
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, ?, 1)', 'GLOBAL', 'A', 'u1', 'EU', 'x', now);

    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, ?, 1)', 'GLOBAL', 'B', 'u2', 'EU', 'y', now);
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, ?, 1)', 'GLOBAL', 'A', 'u3', 'EU', 'z', now);

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

  test('recomputeLeaderboards includes recruits from the rolling 7-day window even before the current week start', async () => {
    const fixedNow = new Date('2026-04-03T12:00:00.000Z').getTime();
    jest.spyOn(Date, 'now').mockReturnValue(fixedNow);

    const scheduler = require('../src/scheduler');
    const { getWeekStartUtcTs } = require('../src/lib/week');
    const weekStart = getWeekStartUtcTs(new Date(fixedNow));
    const recruitTs = weekStart - (2 * 24 * 60 * 60 * 1000);

    await db.run(
      'INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, ?, 1)',
      'GLOBAL',
      'A',
      'u_preweek',
      'EU',
      'x',
      recruitTs
    );

    const guild = makeGuildMock(db);
    const consts = require('../src/constants');
    consts.CHANNELS.INVITES_EU = 'EU_CH';
    consts.CHANNELS.CENTRAL_LEADERBOARD = 'CENTRAL';

    await scheduler.recomputeLeaderboards(db, guild);

    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'EU_CH', 'EU');
    expect(row).toBeDefined();
  });

  test('recomputeLeaderboards includes recent recruiters even when they lack the regional recruiter role', async () => {
    const scheduler = require('../src/scheduler');
    const consts = require('../src/constants');
    consts.CHANNELS.INVITES_EU = 'EU_CH';
    consts.CHANNELS.CENTRAL_LEADERBOARD = 'CENTRAL';
    consts.RECRUITER_ROLE_IDS.EU = 'EU_ROLE';

    const now = Date.now();
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 5, 0, 0, 4)', 'GLOBAL', 'A');
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, ?, 1)', 'GLOBAL', 'A', 'u1', 'EU', 'x', now);
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, ?, 1)', 'GLOBAL', 'B', 'u2', 'EU', 'y', now);

    const guild = makeGuildMock(db);
    guild.roles = {
      cache: {
        get: (id) => {
          if (id !== 'EU_ROLE') return null;
          return {
            id: 'EU_ROLE',
            members: new Map([['A', { id: 'A' }]])
          };
        }
      }
    };

    await scheduler.recomputeLeaderboards(db, guild);

    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'EU_CH', 'EU');
    expect(row).toBeDefined();
    const channel = guild.channels.cache.get('EU_CH');
    const message = await channel.messages.fetch(row.message_id);
    expect(message.content).toContain('<@A>');
    expect(message.content).toContain('<@B>');
  });

  test('recomputeLeaderboards reruns once when a new refresh is requested mid-flight', async () => {
    const scheduler = require('../src/scheduler');
    const consts = require('../src/constants');
    consts.CHANNELS.INVITES_EU = 'EU_CH';
    consts.CHANNELS.CENTRAL_LEADERBOARD = 'CENTRAL';

    const now = Date.now();
    await db.run('INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', 'GLOBAL', 'A');
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, ?, 1)', 'GLOBAL', 'A', 'u1', 'EU', 'x', now);

    let releaseFirstSend;
    const firstSendGate = new Promise((resolve) => { releaseFirstSend = resolve; });
    const messages = new Map();
    let sendCount = 0;
    const channel = {
      id: 'EU_CH',
      messages: {
        fetch: jest.fn(async (arg) => {
          if (typeof arg === 'object') {
            return { values: () => Array.from(messages.values()) };
          }
          return messages.get(arg) || Promise.reject(new Error('Not found'));
        })
      },
      send: jest.fn(async (payload) => {
        sendCount += 1;
        const msg = {
          id: `m${sendCount}`,
          content: payload.content || '',
          embeds: payload.embeds || [],
          edit: jest.fn(async (nextPayload) => {
            msg.content = nextPayload.content || '';
            msg.embeds = nextPayload.embeds || [];
            return msg;
          })
        };
        if (sendCount === 1) {
          await firstSendGate;
        }
        messages.set(msg.id, msg);
        return msg;
      })
    };
    const guild = {
      id: 'GLOBAL',
      channels: {
        cache: {
          get: (id) => {
            if (id === 'EU_CH') return channel;
            return null;
          }
        }
      }
    };

    const firstRun = scheduler.recomputeLeaderboards(db, guild);
    while (sendCount === 0) {
      await new Promise(resolve => setTimeout(resolve, 0));
    }

    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid) VALUES (?, ?, ?, ?, ?, ?, 1)', 'GLOBAL', 'A', 'u2', 'EU', 'y', now + 1);
    const secondRun = scheduler.recomputeLeaderboards(db, guild);

    releaseFirstSend();
    await Promise.all([firstRun, secondRun]);

    const row = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'EU_CH', 'EU');
    const message = await channel.messages.fetch(row.message_id);
    expect(message.content).toContain('[2/');
    expect(channel.send).toHaveBeenCalledTimes(1);
  });

  test('formatLeaderboardMessage lists recruiters and counts', () => {
    const scheduler = require('../src/scheduler');
    const rows = [{ recruiter_id: 'A', cnt: 1, points: 10 }, { recruiter_id: 'B', cnt: 1, points: 5 }];
    const text = scheduler.formatLeaderboardMessage(rows, 'EU');
    expect(text).toMatch(/A/);
    expect(text).toMatch(/B/);
    expect(text).toMatch(/recruits/);
  });
});

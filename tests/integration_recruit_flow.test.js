jest.setTimeout(15000);

const path = require('path');
const fs = require('fs');

function makeTempDbPath() {
  return path.join(require('os').tmpdir(), `recruiter-integration-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeChannel(id) {
  const messages = new Map();
  return {
    id,
    name: id,
    messages: {
      fetch: jest.fn(async (mid) => messages.get(mid) || Promise.reject(new Error('Not found')))
    },
    send: jest.fn(async (payload) => {
      const mid = `m_${Math.random().toString(36).slice(2)}`;
      const msg = {
        id: mid,
        edit: jest.fn(async () => msg),
        content: typeof payload === 'string' ? payload : (payload && payload.content) || ''
      };
      messages.set(mid, msg);
      return msg;
    })
  };
}

function makeGuildMock({ recruiterId, recruitedId }) {
  const constants = require('../src/constants');

  const prevChannels = { ...constants.CHANNELS };

  const channels = new Map();
  channels.set('EU_CH', makeChannel('EU_CH'));
  channels.set('CENTRAL_CH', makeChannel('CENTRAL_CH'));

  // Provide minimal roles cache (scheduler has fallback DB path if roles missing)
  const roles = { cache: { get: jest.fn(() => null) } };

  const recruitedMember = {
    id: recruitedId,
    user: { id: recruitedId, tag: 'Recruit#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)), bot: false },
    joinedAt: new Date(Date.now() - (30 * 60 * 1000)),
    roles: {
      cache: { has: jest.fn(() => false) },
      add: jest.fn().mockResolvedValue(true),
      remove: jest.fn().mockResolvedValue(true)
    },
    setNickname: jest.fn().mockResolvedValue(true),
    send: jest.fn().mockResolvedValue(true)
  };

  const recruiterMember = {
    id: recruiterId,
    user: { id: recruiterId, tag: 'Recruiter#0001' },
    roles: {
      cache: {
        has: jest.fn((id) => {
          const { RECRUITER_ROLE_IDS } = require('../src/constants');
          return id === RECRUITER_ROLE_IDS.EU;
        })
      },
      add: jest.fn().mockResolvedValue(true),
      remove: jest.fn().mockResolvedValue(true)
    },
    permissions: { has: jest.fn(() => true) }
  };

  const members = {
    fetch: jest.fn(async (id) => {
      if (!id) return new Map([[recruiterId, recruiterMember], [recruitedId, recruitedMember]]);
      if (id === recruiterId) return recruiterMember;
      if (id === recruitedId) return recruitedMember;
      return null;
    })
  };

  const guild = {
    id: 'G1',
    name: 'TestGuild',
    roles,
    members,
    channels: { cache: { get: (id) => channels.get(id) } }
  };

  // Wire constants to our mock channels
  constants.CHANNELS.INVITES_EU = 'EU_CH';
  constants.CHANNELS.CENTRAL_LEADERBOARD = 'CENTRAL_CH';

  return { guild, channels, prevChannels };
}

describe('integration: /recruit -> scheduler -> leaderboard_messages', () => {
  let dbPath;
  let db;
  let prevChannels;

  beforeEach(() => {
    dbPath = makeTempDbPath();
    process.env.NODE_ENV = 'test';
    process.env.DATABASE_PATH = dbPath;

    // Ensure clean require cache for DB + modules that capture DB path
    delete require.cache[require.resolve('../src/db_async')];
    delete require.cache[require.resolve('../src/commands/recruiting/recruit')];
    delete require.cache[require.resolve('../src/scheduler')];
    delete require.cache[require.resolve('../src/lib/messages')];
  });

  afterEach(async () => {
    // Restore any mutated global constants
    if (prevChannels) {
      const constants = require('../src/constants');
      constants.CHANNELS = prevChannels;
    }

    try {
      if (db && typeof db.close === 'function') await db.close();
    } catch (e) {
      void e;
    }

    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('creates/updates leaderboard_messages after a recruit', async () => {
    const recruiterId = 'R_INT';
    const recruitedId = 'M_INT';

    db = require('../src/db_async');
    await db.exec('SELECT 1');

    const mock = makeGuildMock({ recruiterId, recruitedId });
    prevChannels = mock.prevChannels;
    const { guild } = mock;

    const interaction = {
      user: { id: recruiterId, tag: 'Recruiter#0001' },
      locale: 'en',
      guild,
      options: {
        getUser: (_key) => ({ id: recruitedId, tag: 'Recruit#0001' }),
        getString: (key) => (key === 'ign' ? 'player' : null)
      },
      deferReply: jest.fn().mockResolvedValue(true),
      reply: jest.fn().mockResolvedValue(true),
      editReply: jest.fn().mockResolvedValue(true)
    };

    const cmd = require('../src/commands/recruiting/recruit');
    await cmd.execute(interaction);

    const rowEU = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'EU_CH', 'EU');
    expect(rowEU).toBeDefined();
    const rowCentral = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'CENTRAL_CH', 'EU');
    expect(rowCentral).toBeDefined();
  });
});

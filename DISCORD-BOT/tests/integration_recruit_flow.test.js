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
  const { ROLE_IDS } = constants;

  const prevChannels = { ...constants.CHANNELS };

  const channels = new Map();
  channels.set('EU_CH', makeChannel('EU_CH'));
  channels.set('CENTRAL_CH', makeChannel('CENTRAL_CH'));

  const makeRole = (id, name, position = 10) => ({ id, name, position });
  const rolesMap = new Map();
  rolesMap.set(ROLE_IDS.ROOKIE, makeRole(ROLE_IDS.ROOKIE, 'Rookie', 10));
  if (ROLE_IDS.UNVERIFIED) rolesMap.set(ROLE_IDS.UNVERIFIED, makeRole(ROLE_IDS.UNVERIFIED, 'Unverified', 9));
  if (ROLE_IDS.ONBOARDING_FIRE) rolesMap.set(ROLE_IDS.ONBOARDING_FIRE, makeRole(ROLE_IDS.ONBOARDING_FIRE, 'Fire', 11));
  if (ROLE_IDS.ONBOARDING_WATER) rolesMap.set(ROLE_IDS.ONBOARDING_WATER, makeRole(ROLE_IDS.ONBOARDING_WATER, 'Water', 11));
  if (ROLE_IDS.ONBOARDING_AIR) rolesMap.set(ROLE_IDS.ONBOARDING_AIR, makeRole(ROLE_IDS.ONBOARDING_AIR, 'Air', 11));
  const roles = { cache: { get: jest.fn((id) => rolesMap.get(id) || null) } };

  const recruitedMember = {
    id: recruitedId,
    user: { id: recruitedId, tag: 'Recruit#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)), bot: false },
    joinedAt: new Date(Date.now() - (30 * 60 * 1000)),
    manageable: true,
    roles: {
      cache: {
        has: jest.fn(() => false),
        filter: jest.fn(() => []),
        values: jest.fn(() => [])
      },
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

  const botMember = {
    id: 'BOT_1',
    permissions: {
      has: jest.fn(() => true)
    },
    roles: {
      highest: { position: 100 }
    }
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
  guild.members.me = botMember;

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
        getUser: (key) => {
          if (key === 'member') return { id: recruitedId, tag: 'Recruit#0001', bot: false };
          if (key === 'credit_to' || key === 'recruiter') return null;
          return null;
        },
        getString: (key) => (key === 'ign' ? 'player' : null),
        getBoolean: () => false
      },
      deferReply: jest.fn().mockResolvedValue(true),
      reply: jest.fn().mockResolvedValue(true),
      editReply: jest.fn().mockResolvedValue(true),
      client: { user: { id: 'BOT_1' } }
    };

    const cmd = require('../src/commands/recruiting/recruit');
    await cmd.execute(interaction);

    const rowEU = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'EU_CH', 'EU');
    expect(rowEU).toBeDefined();
    const rowCentral = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', 'CENTRAL_CH', 'EU');
    expect(rowCentral).toBeDefined();
  });
});

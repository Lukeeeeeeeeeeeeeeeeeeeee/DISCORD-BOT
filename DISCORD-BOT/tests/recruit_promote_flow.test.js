jest.setTimeout(15000);

const path = require('path');
const fs = require('fs');
const { PermissionsBitField } = require('discord.js');

jest.mock('../src/scheduler', () => ({
  recomputeLeaderboards: jest.fn().mockResolvedValue(undefined),
  recomputeWarningsLeaderboard: jest.fn().mockResolvedValue(undefined),
  formatLeaderboardMessage: jest.fn()
}));

const scheduler = require('../src/scheduler');

function makeTempDbPath() {
  return path.join(require('os').tmpdir(), `recruit-promote-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function buildRoleCatalog(constants) {
  const { ROLE_IDS, RECRUITER_ROLE_IDS } = constants;
  const catalog = new Map();
  const addRole = (id, name, position) => {
    if (!id) return;
    catalog.set(id, { id, name, position });
  };

  addRole(ROLE_IDS.ROOKIE, 'Rookie', 10);
  addRole(ROLE_IDS.UNVERIFIED, 'Unverified', 9);
  addRole(ROLE_IDS.ONBOARDING_FIRE, 'Onboarding Fire', 11);
  addRole(ROLE_IDS.ONBOARDING_WATER, 'Onboarding Water', 11);
  addRole(ROLE_IDS.ONBOARDING_AIR, 'Onboarding Air', 11);
  addRole(ROLE_IDS.SOLACE, 'Solace', 12);
  if (ROLE_IDS.TEAM_MEMBER) {
    addRole(ROLE_IDS.TEAM_MEMBER.EU, 'Team EU', 13);
    addRole(ROLE_IDS.TEAM_MEMBER.NA, 'Team NA', 13);
    addRole(ROLE_IDS.TEAM_MEMBER.AS, 'Team AS', 13);
  }
  addRole(RECRUITER_ROLE_IDS.EU, 'Recruiter EU', 20);
  addRole(RECRUITER_ROLE_IDS.NA, 'Recruiter NA', 20);
  addRole(RECRUITER_ROLE_IDS.AS, 'Recruiter AS', 20);

  return catalog;
}

function createMutableRoles(initialIds, roleCatalog) {
  const ids = new Set(initialIds);
  const toRole = (id) => roleCatalog.get(id) || { id, name: id, position: 1 };
  const asArray = (value) => (Array.isArray(value) ? value : [value]).filter(Boolean);

  const roles = {
    cache: {
      has: (id) => ids.has(id),
      filter: (predicate) => Array.from(ids).map(toRole).filter(predicate),
      map: (predicate) => Array.from(ids).map(toRole).map(predicate),
      values: () => Array.from(ids).map(toRole)
    },
    add: jest.fn(async (value) => {
      for (const id of asArray(value)) ids.add(id);
      return true;
    }),
    remove: jest.fn(async (value) => {
      for (const id of asArray(value)) ids.delete(id);
      return true;
    })
  };

  Object.defineProperty(roles, 'highest', {
    enumerable: true,
    get() {
      const roleList = Array.from(ids).map(toRole);
      if (!roleList.length) return { position: 0 };
      return roleList.reduce((highest, role) => (role.position > highest.position ? role : highest), { position: 0 });
    }
  });

  return roles;
}

describe('integration: recruit -> promote', () => {
  let dbPath;

  beforeEach(() => {
    jest.clearAllMocks();
    process.env.NODE_ENV = 'test';
    dbPath = makeTempDbPath();
    process.env.DATABASE_PATH = dbPath;

    delete require.cache[require.resolve('../src/db_async')];
    delete require.cache[require.resolve('../src/commands/recruiting/recruit')];
    delete require.cache[require.resolve('../src/lib/promote')];
  });

  afterEach(async () => {
    try { await require('../src/db_async').close(); } catch (e) { void e; }
    try { delete require.cache[require.resolve('../src/db_async')]; } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('records recruiter verification and updates member role state after promotion', async () => {
    const constants = require('../src/constants');
    const { ROLE_IDS, RECRUITER_ROLE_IDS } = constants;
    const roleCatalog = buildRoleCatalog(constants);
    const db = require('../src/db_async');
    await db.exec('SELECT 1');

    const recruitedRoles = createMutableRoles([], roleCatalog);
    const recruiterRoles = createMutableRoles([RECRUITER_ROLE_IDS.EU], roleCatalog);

    const recruitedMember = {
      id: 'M_FLOW',
      nickname: null,
      manageable: true,
      user: {
        id: 'M_FLOW',
        username: 'FlowPlayer',
        tag: 'FlowPlayer#0001',
        bot: false,
        createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000))
      },
      joinedAt: new Date(Date.now() - (15 * 60 * 1000)),
      roles: recruitedRoles,
      setNickname: jest.fn(async (nickname) => {
        recruitedMember.nickname = nickname;
        return recruitedMember;
      })
    };

    const recruiterMember = {
      id: 'R_FLOW',
      user: { id: 'R_FLOW', tag: 'Recruiter#0001' },
      permissions: {
        has: jest.fn((flag) => {
          return flag === PermissionsBitField.Flags.Administrator || flag === 'Administrator';
        })
      },
      roles: recruiterRoles
    };

    const botMember = {
      id: 'BOT_1',
      permissions: {
        has: jest.fn((flag) => {
          return flag === PermissionsBitField.Flags.ManageRoles
            || flag === PermissionsBitField.Flags.ManageNicknames
            || flag === 'ManageRoles'
            || flag === 'ManageNicknames';
        })
      },
      roles: {
        highest: { position: 100 }
      }
    };

    const guild = {
      id: 'G_FLOW',
      roles: {
        cache: {
          get: (id) => roleCatalog.get(id) || null
        }
      },
      channels: {
        cache: {
          get: () => null
        }
      },
      members: {
        me: botMember,
        fetch: jest.fn(async (id) => {
          if (id === 'R_FLOW') return recruiterMember;
          if (id === 'M_FLOW') return recruitedMember;
          if (id === 'BOT_1') return botMember;
          return null;
        })
      }
    };
    recruitedMember.guild = guild;
    recruiterMember.guild = guild;

    const interaction = {
      user: { id: 'R_FLOW', tag: 'Recruiter#0001' },
      guild,
      locale: 'en',
      client: { user: { id: 'BOT_1' } },
      options: {
        getUser: (key) => {
          if (key === 'member') return { id: 'M_FLOW', tag: 'FlowPlayer#0001', bot: false };
          if (key === 'credit_to' || key === 'recruiter') return null;
          return null;
        },
        getString: (key) => (key === 'ign' ? 'FlowPlayer' : null),
        getBoolean: () => false
      },
      reply: jest.fn(async () => null)
    };

    const recruitCommand = require('../src/commands/recruiting/recruit');
    const { promoteMember } = require('../src/lib/promote');

    await recruitCommand.execute(interaction);

    const recruitRow = await db.get(
      'SELECT recruiter_id, recruited_id, valid FROM recruits WHERE guild_id = ? AND recruited_id = ?',
      'G_FLOW',
      'M_FLOW'
    );
    expect(recruitRow).toEqual(expect.objectContaining({
      recruiter_id: 'R_FLOW',
      recruited_id: 'M_FLOW',
      valid: 1
    }));
    expect(recruitedMember.roles.cache.has(ROLE_IDS.ROOKIE)).toBe(true);
    expect(recruitedMember.roles.cache.has(ROLE_IDS.ONBOARDING_FIRE)).toBe(true);

    const result = await promoteMember({
      member: recruitedMember,
      db,
      guild,
      verifierId: 'VERIFIER_1'
    });

    const verificationRow = await db.get(
      'SELECT recruiter_id, verified_by FROM verifications WHERE guild_id = ? AND recruited_id = ?',
      'G_FLOW',
      'M_FLOW'
    );

    expect(result).toEqual(expect.objectContaining({
      team: 'EU',
      teamName: 'Fire'
    }));
    expect(verificationRow).toEqual(expect.objectContaining({
      recruiter_id: 'R_FLOW',
      verified_by: 'VERIFIER_1'
    }));
    expect(recruitedMember.roles.cache.has(ROLE_IDS.ROOKIE)).toBe(false);
    expect(recruitedMember.roles.cache.has(ROLE_IDS.ONBOARDING_FIRE)).toBe(false);
    expect(recruitedMember.roles.cache.has(ROLE_IDS.SOLACE)).toBe(true);
    if (ROLE_IDS.TEAM_MEMBER && ROLE_IDS.TEAM_MEMBER.EU) {
      expect(recruitedMember.roles.cache.has(ROLE_IDS.TEAM_MEMBER.EU)).toBe(true);
    }
    expect(scheduler.recomputeLeaderboards).toHaveBeenCalledTimes(2);
  });
});

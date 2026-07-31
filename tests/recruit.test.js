jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');
const { PermissionsBitField } = require('discord.js');

// Mock scheduler to avoid side effects
jest.mock('../src/scheduler', () => ({
  recomputeLeaderboards: jest.fn(),
  formatLeaderboardMessage: jest.fn()
}));

jest.mock('../src/services/dm/dm-campaign-service', () => ({
  createCampaign: jest.fn().mockResolvedValue({ campaignId: 1 })
}));

const { recomputeLeaderboards } = require('../src/scheduler');
const { createCampaign } = require('../src/services/dm/dm-campaign-service');

function makeTempDbPath() {
  const tmp = require('os').tmpdir();
  return path.join(tmp, `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeInteraction({
  recruiterId = 'R1',
  member = { id: 'M1', tag: 'Member#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) },
  team = 'EU',
  ign = 'player123',
  creditTo = null,
  creditToTeam = 'EU',
  recruiterIsAdmin = false,
  creditedRecruiterIsAdmin = false,
  memberRoleIds = []
} = {}) {
  const ROLE_IDS = require('../src/constants').ROLE_IDS;
  const { RECRUITER_ROLE_IDS } = require('../src/constants');

  const getTeamRoleIds = (teamCode) => {
    const roleIds = [];
    if (teamCode === 'EU' && RECRUITER_ROLE_IDS.EU) roleIds.push(RECRUITER_ROLE_IDS.EU);
    if (teamCode === 'NA' && RECRUITER_ROLE_IDS.NA) roleIds.push(RECRUITER_ROLE_IDS.NA);
    if (teamCode === 'AS' && RECRUITER_ROLE_IDS.AS) roleIds.push(RECRUITER_ROLE_IDS.AS);
    return roleIds;
  };
  const makePermissions = (isAdmin) => ({
    has: jest.fn((flag) => {
      if (!isAdmin) return false;
      return flag === PermissionsBitField.Flags.Administrator || flag === 'Administrator';
    })
  });

  const makeRole = (id, name, position = 10) => ({
    id,
    name,
    position,
    members: new Map()
  });

  const rolesCache = new Map();
  rolesCache.set(ROLE_IDS.ROOKIE, makeRole(ROLE_IDS.ROOKIE, 'Rookie', 10));
  if (ROLE_IDS.UNVERIFIED) rolesCache.set(ROLE_IDS.UNVERIFIED, makeRole(ROLE_IDS.UNVERIFIED, 'Unverified', 9));
  if (ROLE_IDS.ONBOARDING_FIRE) rolesCache.set(ROLE_IDS.ONBOARDING_FIRE, makeRole(ROLE_IDS.ONBOARDING_FIRE, 'Fire', 11));
  if (ROLE_IDS.ONBOARDING_WATER) rolesCache.set(ROLE_IDS.ONBOARDING_WATER, makeRole(ROLE_IDS.ONBOARDING_WATER, 'Water', 11));
  if (ROLE_IDS.ONBOARDING_AIR) rolesCache.set(ROLE_IDS.ONBOARDING_AIR, makeRole(ROLE_IDS.ONBOARDING_AIR, 'Air', 11));
  ROLE_IDS.ONBOARDING.forEach((r, index) => {
    if (!rolesCache.has(r)) rolesCache.set(r, makeRole(r, `Onboarding-${index + 1}`, 11));
  });

  const channelsCache = new Map();
  channelsCache.set(require('../src/constants').CHANNELS.INVITES_OVERALL, { send: jest.fn().mockResolvedValue(true) });
  channelsCache.set(require('../src/constants').CHANNELS.CENTRAL_LEADERBOARD, { send: jest.fn().mockResolvedValue(true) });

  const guild = {
    id: 'GLOBAL',
    members: {
      fetch: jest.fn(async (arg) => {
        if (typeof arg === 'string') {
          if (arg === member.id) return guildMember;
          if (arg === recruiterId) return recruiterMember;
          return null;
        }
        if (arg && arg.user) {
          const ids = Array.isArray(arg.user) ? arg.user : [arg.user];
          const collection = new Map();
          for (const id of ids) {
            if (id === member.id) collection.set(id, guildMember);
            if (id === recruiterId) collection.set(id, recruiterMember);
          }
          return collection;
        }
        return null;
      })
    },
    roles: { cache: { get: (id) => rolesCache.get(id) } },
    channels: { cache: { get: (id) => channelsCache.get(id) } }
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
  guild.members.me = botMember;

  const guildMember = {
    id: member.id,
    user: { id: member.id, createdAt: member.createdAt, bot: false, tag: member.tag },
    joinedAt: new Date(Date.now() - (30 * 60 * 1000)), // joined 30 minutes ago
    manageable: true,
    roles: {
      cache: {
        has: (id) => memberRoleIds.includes(id),
        values: () => memberRoleIds.map((id) => rolesCache.get(id) || { id, name: id }),
        filter: (predicate) => memberRoleIds
          .map((id) => rolesCache.get(id) || { id, name: id })
          .filter(predicate)
      },
      add: jest.fn().mockResolvedValue(true),
      remove: jest.fn().mockResolvedValue(true)
    },
    setNickname: jest.fn().mockResolvedValue(true),
    send: jest.fn().mockResolvedValue(true)
  };

  const recruiterMember = {
    id: recruiterId,
    permissions: makePermissions(recruiterIsAdmin),
    roles: {
      cache: {
        has: (id) => {
          if (team === 'EU' && id === RECRUITER_ROLE_IDS.EU) return true;
          if (team === 'NA' && id === RECRUITER_ROLE_IDS.NA) return true;
          if (team === 'AS' && id === RECRUITER_ROLE_IDS.AS) return true;
          return false;
        },
        keys: () => getTeamRoleIds(team)
      },
      add: jest.fn(),
      remove: jest.fn()
    }
  };

  const creditedRecruiterMember = creditTo
    ? {
      id: creditTo.id,
      permissions: makePermissions(creditedRecruiterIsAdmin),
      roles: {
        cache: {
          has: (id) => {
            if (creditToTeam === 'EU' && id === RECRUITER_ROLE_IDS.EU) return true;
            if (creditToTeam === 'NA' && id === RECRUITER_ROLE_IDS.NA) return true;
            if (creditToTeam === 'AS' && id === RECRUITER_ROLE_IDS.AS) return true;
            return false;
          },
          keys: () => getTeamRoleIds(creditToTeam)
        },
        add: jest.fn(),
        remove: jest.fn()
      }
    }
    : null;

  const options = {
    getUser: (key) => {
      if (key === 'member') return { id: member.id, tag: member.tag, bot: false };
      if (key === 'credit_to' || key === 'recruiter') {
        return creditTo ? { id: creditTo.id, tag: creditTo.tag, bot: !!creditTo.bot } : null;
      }
      return null;
    },
    getString: (k) => (k === 'ign' ? ign : undefined),
    getBoolean: (_k) => false
  };

  guild.members.fetch = jest.fn(async (arg) => {
    if (typeof arg === 'string') {
      if (arg === member.id) return guildMember;
      if (arg === recruiterId) return recruiterMember;
      if (creditedRecruiterMember && arg === creditedRecruiterMember.id) return creditedRecruiterMember;
      return null;
    }
    if (arg && arg.user) {
      const ids = Array.isArray(arg.user) ? arg.user : [arg.user];
      const collection = new Map();
      for (const id of ids) {
        if (id === member.id) collection.set(id, guildMember);
        if (id === recruiterId) collection.set(id, recruiterMember);
        if (creditedRecruiterMember && id === creditedRecruiterMember.id) {
          collection.set(id, creditedRecruiterMember);
        }
      }
      return collection;
    }
    return null;
  });

  const reply = jest.fn();
  const interaction = {
    user: { id: recruiterId, tag: 'Recruiter#0001' },
    options,
    guild,
    reply,
    locale: 'en',
    client: { user: { id: botMember.id } }
  };

  return { interaction, guildMember, recruiterMember, channelsCache, rolesCache, reply };
}

describe('/recruit command', () => {
  let dbPath;
  beforeEach(async () => {
    dbPath = makeTempDbPath();
    process.env.DATABASE_PATH = dbPath;
    // clear require cache for db and recruit module to re-init with new DB
    delete require.cache[require.resolve('../src/db_async.js')];
    delete require.cache[require.resolve('../src/commands/recruiting/recruit.js')];
    const db = require('../src/db_async');
    // ensure initialized
    await db.exec('SELECT 1');
    const cntRow = await db.get('SELECT COUNT(*) as c FROM recruits');
    const cnt = cntRow ? cntRow.c : 0;
    if (cnt !== 0) {
      // reset DB file if unexpected rows exist
      try { fs.unlinkSync(dbPath); } catch (e) { void e; }
      delete require.cache[require.resolve('../src/db_async.js')];
      await require('../src/db_async').exec('SELECT 1');
    }
  });

  afterEach(async () => {
    createCampaign.mockClear();
    try { await require('../src/db_async').close(); } catch (e) { void e; }
    try { delete require.cache[require.resolve('../src/db_async.js')]; } catch (e) { void e; }
    try { fs.unlinkSync(dbPath); } catch (e) { void e; }
  });

  test('successfully recruits a member and updates DB and roles', async () => {
    const { interaction, guildMember, channelsCache } = makeInteraction();
    // load db and module
    const db = require('../src/db_async');
    // sanity checks before executing
    expect(guildMember.roles.cache.has(require('../src/constants').ROLE_IDS.ROOKIE)).toBe(false);
    expect(await db.get('SELECT * FROM recruits WHERE recruited_id = ?', 'M1')).toBeUndefined();

    const cmd = require('../src/commands/recruiting/recruit.js');

    await cmd.execute(interaction);

    // verify interaction replied successfully
    expect(interaction.reply).toHaveBeenCalled();
    const replyArg = interaction.reply.mock.calls[0][0];
    expect(replyArg.content).toMatch(/Successfully recruited/);

    // verify DB rows: recruits and recruiters
    const rec = await db.get('SELECT * FROM recruits WHERE recruiter_id = ?', interaction.user.id);
    expect(rec).toBeDefined();
    expect(rec.recruited_id).toBe('M1');

    const recruiterRow = await db.get('SELECT * FROM recruiters WHERE id = ?', interaction.user.id);
    expect(recruiterRow).toBeDefined();
    // points should be numeric and equal to the per-recruit points recorded
    expect(typeof recruiterRow.points).toBe('number');
    const recPoints = rec.points || 0;
    expect(recruiterRow.points).toBe(recPoints);

    const { getWeekStartUtcTs } = require('../src/lib/week');
    const weekStart = getWeekStartUtcTs();
    const weekly = await db.get(
      'SELECT recruits7d FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? AND week_start = ?',
      interaction.guild.id,
      interaction.user.id,
      weekStart
    );
    expect(weekly).toBeDefined();
    expect(Number(weekly.recruits7d)).toBe(1);

    // channels should NOT have a per-recruit send (leaderboards are updated via upsert)
    const chOverall = channelsCache.get(require('../src/constants').CHANNELS.INVITES_OVERALL);
    expect(chOverall.send).not.toHaveBeenCalled();

    // scheduler should have been invoked
    expect(recomputeLeaderboards).toHaveBeenCalled();
  });

  test('credits recruit points to another recruiter when credit_to is provided', async () => {
    const credited = { id: 'R2', tag: 'RecruiterTwo#0002' };
    const { interaction } = makeInteraction({
      recruiterId: 'STAFF1',
      member: { id: 'M_CREDIT', tag: 'Credit#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) },
      creditTo: credited,
      creditToTeam: 'NA',
      recruiterIsAdmin: true
    });
    const db = require('../src/db_async');
    const cmd = require('../src/commands/recruiting/recruit.js');

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const replyArg = interaction.reply.mock.calls[0][0];
    expect(replyArg.content).toContain('<@R2>');

    const rec = await db.get('SELECT * FROM recruits WHERE recruited_id = ?', 'M_CREDIT');
    expect(rec).toBeDefined();
    expect(rec.recruiter_id).toBe('R2');

    const creditedRow = await db.get('SELECT * FROM recruiters WHERE id = ?', 'R2');
    expect(creditedRow).toBeDefined();
    expect(creditedRow.points).toBe(rec.points);
  });

  test('rejects credit_to when target is a bot account', async () => {
    const { interaction } = makeInteraction({
      recruiterId: 'STAFF2',
      member: { id: 'M_BOT_CREDIT', tag: 'BotCredit#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) },
      creditTo: { id: 'BOT_1', tag: 'Bot#1234', bot: true },
      recruiterIsAdmin: true
    });
    const cmd = require('../src/commands/recruiting/recruit.js');

    await cmd.execute(interaction);

    const replyArg = interaction.reply.mock.calls[0][0];
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toBe('Cannot credit recruits to bot accounts.');
  });

  test('rejects credit_to when target lacks recruiter/staff permissions', async () => {
    const { interaction } = makeInteraction({
      recruiterId: 'STAFF3',
      member: { id: 'M_BAD_CREDIT', tag: 'CreditBad#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) },
      creditTo: { id: 'R3', tag: 'RecruiterThree#0003' },
      creditToTeam: 'NONE',
      recruiterIsAdmin: true
    });
    const cmd = require('../src/commands/recruiting/recruit.js');

    await cmd.execute(interaction);

    const replyArg = interaction.reply.mock.calls[0][0];
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toBe('Credited recruiter must have recruiter/staff permissions.');
  });

  test('rejects if joined more than 2 hours ago', async () => {
    const { interaction, guildMember } = makeInteraction();
    guildMember.joinedAt = new Date(Date.now() - (3 * 60 * 60 * 1000)); // 3 hours
    const cmd = require('../src/commands/recruiting/recruit.js');
    await cmd.execute(interaction);
    const replyArg = interaction.reply.mock.calls[0][0];
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toBe('Cannot give roles to someone who joined more than 2 hours ago.');
  });

  test('continues when welcome DM campaign queueing fails', async () => {
    const { interaction, guildMember } = makeInteraction({
      member: { id: 'M_DM_MSG', tag: 'DmMsg#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) }
    });
    createCampaign.mockRejectedValueOnce(new Error('Cannot enqueue welcome campaign'));
    const cmd = require('../src/commands/recruiting/recruit.js');

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const replyArg = interaction.reply.mock.calls[0][0];
    expect(replyArg.content).toContain('Successfully recruited');
    expect(guildMember.roles.add).toHaveBeenCalled();
  });

  test('rejects if account too young', async () => {
    const youngMember = { id: 'M2', tag: 'Young#0001', createdAt: new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)) }; // 10 days old
    const { interaction } = makeInteraction({ member: youngMember });
    const cmd = require('../src/commands/recruiting/recruit.js');
    await cmd.execute(interaction);
    const replyArg = interaction.reply.mock.calls[0][0];
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toBe('Account must be at least 6 months old.');
  });

  test('rejects if member already verified', async () => {
    const { interaction, guildMember } = makeInteraction();
    guildMember.roles.cache.has = (id) => id === require('../src/constants').ROLE_IDS.ROOKIE;
    const cmd = require('../src/commands/recruiting/recruit.js');
    await cmd.execute(interaction);
    const replyArg = interaction.reply.mock.calls[0][0];
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toBe('Member is already verified.');
  });

  test('rejects if already recruited', async () => {
    const { interaction } = makeInteraction();
    const cmd = require('../src/commands/recruiting/recruit.js');

    // first attempt should succeed
    await cmd.execute(interaction);

    // second attempt should be rejected
    await cmd.execute(interaction);
    const replyArg = interaction.reply.mock.calls[1][0]; // second call
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toBe('That member has already been recruited previously.');
  });

  test('rejects recruiters without a team role when they are not admins', async () => {
    const { interaction } = makeInteraction({
      recruiterId: 'R_NO_TEAM',
      member: { id: 'M_NO_TEAM', tag: 'NoTeam#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) },
      team: 'NONE'
    });

    const cmd = require('../src/commands/recruiting/recruit.js');
    await cmd.execute(interaction);

    const replyArg = interaction.reply.mock.calls[0][0];
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toMatch(/You must have a team recruiter role/);
  });

  test('infers onboarding team from recruit region for admins without team roles', async () => {
    const ROLE_IDS = require('../src/constants').ROLE_IDS;
    const { REGION_ROLE_IDS } = require('../src/constants');
    const { interaction, guildMember } = makeInteraction({
      recruiterId: 'ADMIN_NO_TEAM',
      member: { id: 'M_REGION', tag: 'Region#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) },
      team: 'NONE',
      recruiterIsAdmin: true,
      memberRoleIds: [REGION_ROLE_IDS.NA]
    });

    const cmd = require('../src/commands/recruiting/recruit.js');
    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const addedRoles = guildMember.roles.add.mock.calls.flatMap(call => (Array.isArray(call[0]) ? call[0] : [call[0]]));
    expect(addedRoles).toEqual(expect.arrayContaining([ROLE_IDS.ROOKIE, ROLE_IDS.ONBOARDING_WATER]));
  });

  test('recruiter info shows extended fields', async () => {
    const db = require('../src/db_async');

    // seed recruiter and some activity
    // seed recruiter and some activity
    await db.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, ?, ?, ?)', 'GLOBAL', 'R1', 120, 1, 0, 4);
    const now = Date.now();
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', 'GLOBAL', 'R1', 'u10', 'EU', 'p1', now - (2 * 24 * 60 * 60 * 1000), 25);
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', 'GLOBAL', 'R1', 'u11', 'EU', 'p2', now - (10 * 24 * 60 * 60 * 1000), 25);
    await db.run('INSERT INTO multipliers (guild_id, recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', 'GLOBAL', 'R1', 1.75, 'm1.75_14d', now - 1000, now + (14 * 24 * 60 * 60 * 1000));
    await db.run('INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)', 'GLOBAL', 'R1', 'custom-role', 50, now - 2000);

    // Mock retention scan to return 0.75
    const econ = require('../src/lib/economy');
    const spy = jest.spyOn(econ, 'computeRetentionFromGuild').mockResolvedValue(0.75);

    // create interaction for recruiter info
    const options = { getSubcommand: () => 'info', getUser: (_k) => ({ id: 'R1', tag: 'Recruiter#0001' }) };
    const reply = jest.fn();
    const guild = {
      id: 'GLOBAL',
      members: {
        fetch: jest.fn(async (arg) => {
          const RECRUITER_ROLE = require('../src/constants').ROLE_IDS.RECRUITER;
          if (typeof arg === 'string') return { id: arg, roles: { cache: { has: (rid) => rid === RECRUITER_ROLE, keys: () => [RECRUITER_ROLE] } } };
          if (arg && arg.user) {
            const ids = Array.isArray(arg.user) ? arg.user : [arg.user];
            const collection = new Map();
            for (const id of ids) {
              collection.set(id, { id, roles: { cache: { has: (rid) => rid === RECRUITER_ROLE } } });
            }
            return collection;
          }
          return null;
        })
      }
    };
    const interaction = { options, reply, user: { id: 'R1', tag: 'Recruiter#0001' }, member: { permissions: { has: () => true } }, guild };

    const cmd = require('../src/commands/recruiting/recruiter.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalled();
    const arg = interaction.reply.mock.calls[0][0];
    const fields = arg.embeds[0].data.fields.map(f => f.name);
    expect(fields).toContain('Active Multiplier');
    expect(fields).toContain('Total recruits (all time)');
    expect(fields).toContain('Min recruits required');

    spy.mockRestore();
  });
});

jest.setTimeout(10000);
const path = require('path');
const fs = require('fs');

// Mock scheduler to avoid side effects
jest.mock('../src/scheduler', () => ({
  recomputeLeaderboards: jest.fn(),
  formatLeaderboardMessage: jest.fn()
}));

const { recomputeLeaderboards } = require('../src/scheduler');

function makeTempDbPath() {
  const tmp = require('os').tmpdir();
  return path.join(tmp, `recruiter-test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

function makeInteraction({ recruiterId = 'R1', member = { id: 'M1', tag: 'Member#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) }, region = 'EU', ign = 'player123' } = {}) {
  const ROLE_IDS = require('../src/constants').ROLE_IDS;

  // simulate role counts
  const rolesCache = new Map();
  ROLE_IDS.ONBOARDING.forEach(r => rolesCache.set(r, { members: new Map() }));

  const channelsCache = new Map();
  channelsCache.set(require('../src/constants').CHANNELS.INVITES_OVERALL, { send: jest.fn().mockResolvedValue(true) });
  channelsCache.set(require('../src/constants').CHANNELS.CENTRAL_LEADERBOARD, { send: jest.fn().mockResolvedValue(true) });

  const guild = {
    members: {
      fetch: jest.fn(async (id) => {
        if (id === member.id) return guildMember;
        if (id === recruiterId) return recruiterMember;
        return null;
      })
    },
    roles: { cache: { get: (id) => rolesCache.get(id) } },
    channels: { cache: { get: (id) => channelsCache.get(id) } }
  };

  const guildMember = {
    id: member.id,
    user: { id: member.id, createdAt: member.createdAt, bot: false, tag: member.tag },
    joinedAt: new Date(Date.now() - (30 * 60 * 1000)), // joined 30 minutes ago
    roles: {
      cache: {
        has: (id) => false
      },
      add: jest.fn().mockResolvedValue(true),
      remove: jest.fn().mockResolvedValue(true)
    },
    setNickname: jest.fn().mockResolvedValue(true),
    send: jest.fn().mockResolvedValue(true)
  };

  const recruiterMember = {
    id: recruiterId,
    roles: { cache: { has: () => false }, add: jest.fn(), remove: jest.fn() }
  };

  const options = {
    getUser: (k) => ({ id: member.id, tag: member.tag }),
    getString: (k) => (k === 'region' ? region : (k === 'ign' ? ign : undefined))
  };

  const reply = jest.fn();
  const interaction = {
    user: { id: recruiterId, tag: 'Recruiter#0001' },
    options,
    guild,
    reply,
    locale: 'en'
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
    delete require.cache[require.resolve('../src/commands/recruit.js')];
    const db = require('../src/db_async');
    // ensure initialized
    await db.exec('SELECT 1');
    const cntRow = await db.get('SELECT COUNT(*) as c FROM recruits');
    const cnt = cntRow ? cntRow.c : 0;
    if (cnt !== 0) {
      // reset DB file if unexpected rows exist
      try { fs.unlinkSync(dbPath); } catch (e) {}
      delete require.cache[require.resolve('../src/db_async.js')];
      await require('../src/db_async').exec('SELECT 1');
    }
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch (e) {}
  });

  test('successfully recruits a member and updates DB and roles', async () => {
    const { interaction, guildMember, recruiterMember, channelsCache } = makeInteraction();
    // ensure guild members.fetch returns our guildMember
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(guildMember);
    // load db and module
    const db = require('../src/db_async');
    // sanity checks before executing
    expect(guildMember.roles.cache.has(require('../src/constants').ROLE_IDS.ROOKIE)).toBe(false);
    expect(await db.get('SELECT * FROM recruits WHERE recruited_id = ?', 'M1')).toBeUndefined();

    const cmd = require('../src/commands/recruit.js');

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

    // DM to recruited member attempted
    expect(guildMember.send).toHaveBeenCalled();

    // channels should have send called
    const chOverall = channelsCache.get(require('../src/constants').CHANNELS.INVITES_OVERALL);
    expect(chOverall.send).toHaveBeenCalled();

    // scheduler should have been invoked
    expect(recomputeLeaderboards).toHaveBeenCalled();
  });

  test('rejects if joined more than 2 hours ago', async () => {
    const { interaction, guildMember } = makeInteraction();
    guildMember.joinedAt = new Date(Date.now() - (3 * 60 * 60 * 1000)); // 3 hours
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(guildMember);
    const cmd = require('../src/commands/recruit.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Cannot give roles to someone who joined more than 2 hours ago.', ephemeral: true });
  });

  test('rejects if account too young', async () => {
    const youngMember = { id: 'M2', tag: 'Young#0001', createdAt: new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)) }; // 10 days old
    const { interaction, guildMember } = makeInteraction({ member: youngMember });
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(guildMember);
    const cmd = require('../src/commands/recruit.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Account must be at least 6 months old.', ephemeral: true });
  });

  test('rejects if member already verified', async () => {
    const { interaction, guildMember } = makeInteraction();
    guildMember.roles.cache.has = (id) => id === require('../src/constants').ROLE_IDS.ROOKIE;
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(guildMember);
    const cmd = require('../src/commands/recruit.js');
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'Member is already verified.', ephemeral: true });
  });

  test('rejects if already recruited', async () => {
    const { interaction, guildMember } = makeInteraction();
    interaction.guild.members.fetch = jest.fn().mockResolvedValue(guildMember);

    const cmd = require('../src/commands/recruit.js');

    // first attempt should succeed
    await cmd.execute(interaction);

    // second attempt should be rejected
    await cmd.execute(interaction);
    expect(interaction.reply).toHaveBeenCalledWith({ content: 'That member has already been recruited previously.', ephemeral: true });
  });

  test('recruiter info shows extended fields', async () => {
    const db = require('../src/db_async');

    // seed recruiter and some activity
    await db.run('INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, ?, ?)', 'R1', 120, 1, 0, 4);
    const now = Date.now();
    await db.run('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, 1, ?)', 'R1','u10','EU','p1', now - (2*24*60*60*1000), 25);
    await db.run('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, 1, ?)', 'R1','u11','EU','p2', now - (10*24*60*60*1000), 25);
    await db.run('INSERT INTO multipliers (recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?)', 'R1', 1.25, 'm1.25_14d', now - 1000, now + (14*24*60*60*1000));
    await db.run('INSERT INTO purchases (recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?)', 'R1', 'custom-role', 50, now - 2000);

    // Mock retention scan to return 0.75
    const econ = require('../src/lib/economy');
    const spy = jest.spyOn(econ, 'computeRetentionFromGuild').mockResolvedValue(0.75);

    // create interaction for recruiter info
    const options = { getSubcommand: () => 'info', getUser: (k) => ({ id: 'R1', tag: 'Recruiter#0001' }) };
    const reply = jest.fn();
    const guild = { members: { fetch: jest.fn(async (id)=> ({ id, roles: { cache: { has: () => false } } })) } };
    const interaction = { options, reply, user: { id: 'R1', tag: 'Recruiter#0001' }, member: { permissions: { has: () => true } }, guild };

    const cmd = require('../src/commands/recruiter.js');
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

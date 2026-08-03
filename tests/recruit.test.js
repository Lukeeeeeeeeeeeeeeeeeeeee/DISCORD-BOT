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

function makeInteraction({ recruiterId = 'R1', member = { id: 'M1', tag: 'Member#0001', createdAt: new Date(Date.now() - (365 * 24 * 60 * 60 * 1000)) }, team = 'EU', ign = 'player123', roleAddFails = false, recruiterIsAdmin = false } = {}) {
  const ROLE_IDS = require('../src/constants').ROLE_IDS;
  const { RECRUITER_ROLE_IDS } = require('../src/constants');

  // simulate role counts
  const rolesCache = new Map();
  const addRole = (id) => {
    if (!id) return;
    rolesCache.set(id, { id, name: `role-${id}`, position: 1, members: new Map() });
  };
  (ROLE_IDS.ONBOARDING || []).forEach(r => addRole(r));
  addRole(ROLE_IDS.ROOKIE);
  addRole(ROLE_IDS.UNVERIFIED);
  Object.values(RECRUITER_ROLE_IDS || {}).forEach(r => addRole(r));

  const channelsCache = new Map();
  channelsCache.set(require('../src/constants').CHANNELS.INVITES_OVERALL, { send: jest.fn().mockResolvedValue(true) });
  channelsCache.set(require('../src/constants').CHANNELS.CENTRAL_LEADERBOARD, { send: jest.fn().mockResolvedValue(true) });

  const guild = {
    id: 'GLOBAL',
    members: {
      me: {
        id: 'BOT',
        permissions: { has: () => true },
        roles: { highest: { position: 100 } }
      },
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

  const guildMember = {
    id: member.id,
    user: { id: member.id, createdAt: member.createdAt, bot: false, tag: member.tag },
    joinedAt: new Date(Date.now() - (30 * 60 * 1000)), // joined 30 minutes ago
    roles: {
      cache: {
        has: (_id) => false
      },
      add: roleAddFails
        ? jest.fn().mockRejectedValue(new Error('Missing Permissions'))
        : jest.fn().mockResolvedValue(true),
      remove: jest.fn().mockResolvedValue(true)
    },
    setNickname: jest.fn().mockResolvedValue(true),
    send: jest.fn().mockResolvedValue(true)
  };

  const recruiterMember = {
    id: recruiterId,
    permissions: { has: () => recruiterIsAdmin },
    roles: {
      cache: {
        has: (id) => {
          if (team === 'EU' && id === RECRUITER_ROLE_IDS.EU) return true;
          if (team === 'NA' && id === RECRUITER_ROLE_IDS.NA) return true;
          if (team === 'AS' && id === RECRUITER_ROLE_IDS.AS) return true;
          return false;
        }
      },
      add: jest.fn(),
      remove: jest.fn()
    }
  };

  const options = {
    getUser: (_k) => ({ id: member.id, tag: member.tag }),
    getString: (k) => (k === 'ign' ? ign : undefined)
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
    delete require.cache[require.resolve('../src/commands/recruiting/recruit.js')];
    const db = require('../src/db_async');
    // ensure initialized
    await db.exec('SELECT 1');
    const cntRow = await db.get('SELECT COUNT(*) as c FROM recruits');
    const cnt = cntRow ? cntRow.c : 0;
    if (cnt !== 0) {
      // reset DB file if unexpected rows exist
      try { fs.unlinkSync(dbPath); } catch (e) { console.error(e); }
      delete require.cache[require.resolve('../src/db_async.js')];
      await require('../src/db_async').exec('SELECT 1');
    }
  });

  afterEach(() => {
    try { fs.unlinkSync(dbPath); } catch (e) { console.error(e); }
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

    // DM to recruited member attempted
    expect(guildMember.send).toHaveBeenCalled();

    // channels should NOT have a per-recruit send (leaderboards are updated via upsert)
    const chOverall = channelsCache.get(require('../src/constants').CHANNELS.INVITES_OVERALL);
    expect(chOverall.send).not.toHaveBeenCalled();

    // scheduler should have been invoked
    expect(recomputeLeaderboards).toHaveBeenCalled();
  });

  test('rejects if joined more than 2 hours ago', async () => {
    const { interaction, guildMember } = makeInteraction();
    guildMember.joinedAt = new Date(Date.now() - (3 * 60 * 60 * 1000)); // 3 hours
    const cmd = require('../src/commands/recruiting/recruit.js');
    await cmd.execute(interaction);
    const replyArg = interaction.reply.mock.calls[0][0];
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toBe('Cannot recruit someone who joined more than 2 hour(s) ago.');
  });

  test('allows late recruit when recruiter is admin and override is enabled', async () => {
    process.env.RECRUIT_ALLOW_LATE_ADMIN_OVERRIDE = 'true';
    try {
      const { interaction, guildMember } = makeInteraction({ recruiterIsAdmin: true });
      guildMember.joinedAt = new Date(Date.now() - (3 * 60 * 60 * 1000)); // 3 hours
      const cmd = require('../src/commands/recruiting/recruit.js');
      await cmd.execute(interaction);

      expect(interaction.reply).toHaveBeenCalled();
      const replyArg = interaction.reply.mock.calls[0][0];
      expect(replyArg.content).toMatch(/Successfully recruited/);
    } finally {
      delete process.env.RECRUIT_ALLOW_LATE_ADMIN_OVERRIDE;
    }
  });

  test('rejects if account too young', async () => {
    const youngMember = { id: 'M2', tag: 'Young#0001', createdAt: new Date(Date.now() - (10 * 24 * 60 * 60 * 1000)) }; // 10 days old
    const { interaction } = makeInteraction({ member: youngMember });
    const cmd = require('../src/commands/recruiting/recruit.js');
    await cmd.execute(interaction);
    const replyArg = interaction.reply.mock.calls[0][0];
    const desc = replyArg.embeds ? replyArg.embeds[0].data.description : replyArg.content;
    expect(desc).toBe('Account must be at least 180 days old.');
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

  test('recruit role-grant failure does not leave active recruit or deducted points', async () => {
    const { interaction } = makeInteraction({ roleAddFails: true });
    const db = require('../src/db_async');
    const cmd = require('../src/commands/recruiting/recruit.js');

    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    const payload = interaction.reply.mock.calls[0][0];
    const desc = payload.embeds ? payload.embeds[0].data.description : payload.content;
    expect(desc).toMatch(/Missing permissions to assign roles/i);

    const activeRecruit = await db.get('SELECT * FROM recruits WHERE recruiter_id = ? AND recruited_id = ? AND valid = 1', 'R1', 'M1');
    expect(activeRecruit).toBeUndefined();

    const recruiterRow = await db.get('SELECT * FROM recruiters WHERE id = ?', 'R1');
    if (recruiterRow) {
      expect(Number(recruiterRow.points || 0)).toBe(0);
    }
  });

  test('recruiter info shows extended fields', async () => {
    const db = require('../src/db_async');

    // seed recruiter and some activity
    // seed recruiter and some activity
    await db.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, ?, ?, ?)', 'GLOBAL', 'R1', 120, 1, 0, 4);
    const now = Date.now();
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', 'GLOBAL', 'R1', 'u10', 'EU', 'p1', now - (2 * 24 * 60 * 60 * 1000), 25);
    await db.run('INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, ?, 1, ?)', 'GLOBAL', 'R1', 'u11', 'EU', 'p2', now - (10 * 24 * 60 * 60 * 1000), 25);
    await db.run('INSERT INTO multipliers (guild_id, recruiter_id, value, type, created_at, expires_at) VALUES (?, ?, ?, ?, ?, ?)', 'GLOBAL', 'R1', 1.25, 'm1.25_14d', now - 1000, now + (14 * 24 * 60 * 60 * 1000));
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


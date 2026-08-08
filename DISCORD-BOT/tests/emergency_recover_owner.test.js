jest.mock('../src/lib/runtime', () => ({
  getAntiNuke: jest.fn()
}));

const runtime = require('../src/lib/runtime');

function makeAdminMember() {
  return {
    permissions: {
      has: () => true
    }
  };
}

function makeInteraction({
  userId = 'U1',
  backupId = null,
  sourceGuildId = null,
  force = false
} = {}) {
  const reply = jest.fn(async () => true);
  const deferReply = jest.fn(async () => true);
  const editReply = jest.fn(async () => true);

  return {
    user: { id: userId, tag: `User${userId}#0001` },
    member: makeAdminMember(),
    guild: { id: 'TARGET', name: 'TargetGuild' },
    options: {
      getString: (name) => {
        if (name === 'backup_id') return backupId;
        if (name === 'source_guild_id') return sourceGuildId;
        return null;
      },
      getBoolean: (name) => {
        if (name === 'force') return force;
        return false;
      }
    },
    reply,
    deferReply,
    editReply
  };
}

describe('emergency_recover owner gates', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('blocks non-owner cross-server restore', async () => {
    const antiNuke = {
      isOwner: () => false,
      getStatus: () => ({ hasBackup: true, isEmergency: true, backupId: 'bk_1' }),
      createTraceId: () => 'trace_1',
      emergencyRecover: jest.fn(async () => ({}))
    };
    runtime.getAntiNuke.mockReturnValue(antiNuke);

    const interaction = makeInteraction({ userId: 'NOT_OWNER', sourceGuildId: 'SOURCE_GUILD' });
    const cmd = require('../src/commands/emergency_recover');
    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    expect(antiNuke.emergencyRecover).not.toHaveBeenCalled();
  });

  test('blocks non-owner same-server restore', async () => {
    const antiNuke = {
      isOwner: () => false,
      getStatus: () => ({ hasBackup: true, isEmergency: true, backupId: 'bk_1' }),
      createTraceId: () => 'trace_1',
      emergencyRecover: jest.fn(async () => ({}))
    };
    runtime.getAntiNuke.mockReturnValue(antiNuke);

    const interaction = makeInteraction({ userId: 'NOT_OWNER' });
    const cmd = require('../src/commands/emergency_recover');
    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    expect(antiNuke.emergencyRecover).not.toHaveBeenCalled();
  });

  test('allows owner cross-server restore and forwards source guild id', async () => {
    const antiNuke = {
      isOwner: (id) => id === 'OWNER',
      getStatus: () => ({ hasBackup: true, isEmergency: true, backupId: 'bk_1' }),
      createTraceId: () => 'trace_2',
      emergencyRecover: jest.fn(async () => ({
        success: true,
        sourceGuildId: 'SOURCE_GUILD',
        isCrossGuildRecover: true,
        rolesRestored: 1,
        rolesCreated: 1,
        channelsRestored: 1,
        channelsCreated: 1,
        threadsCreated: 0,
        emojisRestored: 0,
        stickersRestored: 0,
        bansRestored: 0,
        onboardingRestored: false,
        guildMetaRestored: true
      }))
    };
    runtime.getAntiNuke.mockReturnValue(antiNuke);

    const interaction = makeInteraction({ userId: 'OWNER', sourceGuildId: 'SOURCE_GUILD' });
    const cmd = require('../src/commands/emergency_recover');
    await cmd.execute(interaction);

    expect(antiNuke.emergencyRecover).toHaveBeenCalledWith(
      'TARGET',
      null,
      expect.objectContaining({
        sourceGuildId: 'SOURCE_GUILD',
        executorId: 'OWNER'
      })
    );
    expect(interaction.editReply).toHaveBeenCalled();
  });
});

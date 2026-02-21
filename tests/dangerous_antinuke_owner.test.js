jest.mock('../src/lib/runtime', () => ({
  getAntiNuke: jest.fn()
}));

const runtime = require('../src/lib/runtime');

function makeInteraction(userId = 'USER_1') {
  return {
    user: { id: userId, tag: `User${userId}#0001` },
    member: {
      permissions: {
        has: () => true
      }
    },
    guild: { id: 'G1', name: 'GuildOne' },
    options: {
      getString: () => 'ban',
      getInteger: (name) => (name === 'count' ? 3 : 5),
      getBoolean: () => true
    },
    reply: jest.fn(async () => true),
    deferReply: jest.fn(async () => true),
    editReply: jest.fn(async () => true)
  };
}

describe('dangerous anti-nuke commands are owner-only', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test.each([
    '../src/commands/simulate_attack',
    '../src/commands/toggle_strict_mode',
    '../src/commands/toggle_aggressive_ban',
    '../src/commands/set_quarantine_options'
  ])('%s rejects non-owner', async (commandPath) => {
    runtime.getAntiNuke.mockReturnValue({ isOwner: () => false });

    const interaction = makeInteraction('NOT_OWNER');
    const cmd = require(commandPath);
    await cmd.execute(interaction);

    expect(interaction.reply).toHaveBeenCalled();
    expect(interaction.deferReply).not.toHaveBeenCalled();
  });
});

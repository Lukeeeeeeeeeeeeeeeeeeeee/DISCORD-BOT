const mockDbAll = jest.fn();
const mockEnsureCommandAccess = jest.fn();
const mockReplyError = jest.fn(async () => null);
const mockRecomputeLeaderboards = jest.fn();
const mockRecomputeWarningsLeaderboard = jest.fn();

jest.mock('../src/db_async', () => ({
  all: (...args) => mockDbAll(...args)
}));

jest.mock('../src/lib/command-auth', () => ({
  ensureCommandAccess: (...args) => mockEnsureCommandAccess(...args)
}));

jest.mock('../src/lib/embeds', () => ({
  replyError: (...args) => mockReplyError(...args)
}));

jest.mock('../src/scheduler', () => ({
  recomputeLeaderboards: (...args) => mockRecomputeLeaderboards(...args),
  recomputeWarningsLeaderboard: (...args) => mockRecomputeWarningsLeaderboard(...args)
}));

const cmd = require('../src/commands/recruiting/leaderboard');

function makeInteraction() {
  return {
    guild: { id: 'guild-1' },
    options: {
      getSubcommand: jest.fn(() => 'init')
    },
    deferReply: jest.fn(async () => null),
    editReply: jest.fn(async () => null),
    reply: jest.fn(async () => null)
  };
}

describe('/leaderboard init command', () => {
  let errorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    mockEnsureCommandAccess.mockResolvedValue(true);
    mockRecomputeLeaderboards.mockResolvedValue(undefined);
    mockRecomputeWarningsLeaderboard.mockResolvedValue(undefined);
    mockDbAll.mockResolvedValue([
      { channel_id: 'chan-1', region: 'EU', cnt: 2 },
      { channel_id: 'chan-2', region: 'WARNINGS', cnt: 1 }
    ]);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  test('acknowledges interaction before recompute and edits final summary', async () => {
    const interaction = makeInteraction();

    await cmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(mockRecomputeLeaderboards).toHaveBeenCalledWith(expect.any(Object), interaction.guild);
    expect(mockRecomputeWarningsLeaderboard).toHaveBeenCalledWith(expect.any(Object), interaction.guild);
    expect(interaction.reply).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Leaderboards initialized/updated.')
    }));
    expect(interaction.editReply).toHaveBeenCalledWith(expect.objectContaining({
      content: expect.stringContaining('Duplicate row groups: 1')
    }));

    const deferOrder = interaction.deferReply.mock.invocationCallOrder[0];
    const recomputeOrder = mockRecomputeLeaderboards.mock.invocationCallOrder[0];
    expect(deferOrder).toBeLessThan(recomputeOrder);
  });

  test('returns replyError on failure after deferring', async () => {
    const interaction = makeInteraction();
    mockRecomputeLeaderboards.mockRejectedValueOnce(new Error('boom'));

    await cmd.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledTimes(1);
    expect(mockReplyError).toHaveBeenCalledWith(interaction, 'Failed to initialize leaderboards.');
  });
});

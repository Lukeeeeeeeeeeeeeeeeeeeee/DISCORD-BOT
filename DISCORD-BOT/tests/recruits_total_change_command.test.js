const mockDbGet = jest.fn();
const mockDbRun = jest.fn();
const mockEnsureCommandAccess = jest.fn();
const mockGetWeekStartUtcTs = jest.fn();
const mockGetRolling7DayStartTs = jest.fn();
const mockReplyError = jest.fn(async () => null);
const mockRecomputeLeaderboards = jest.fn();
const mockRecomputeWarningsLeaderboard = jest.fn();
const mockLogUnexpectedError = jest.fn(async () => null);
const mockLogRuntimeEvent = jest.fn();

jest.mock('../src/db_async', () => ({
  get: (...args) => mockDbGet(...args),
  run: (...args) => mockDbRun(...args)
}));

jest.mock('../src/lib/command-auth', () => ({
  ensureCommandAccess: (...args) => mockEnsureCommandAccess(...args)
}));

jest.mock('../src/lib/week', () => ({
  getWeekStartUtcTs: (...args) => mockGetWeekStartUtcTs(...args),
  getRolling7DayStartTs: (...args) => mockGetRolling7DayStartTs(...args)
}));

jest.mock('../src/lib/embeds', () => ({
  replyError: (...args) => mockReplyError(...args)
}));

jest.mock('../src/scheduler', () => ({
  recomputeLeaderboards: (...args) => mockRecomputeLeaderboards(...args),
  recomputeWarningsLeaderboard: (...args) => mockRecomputeWarningsLeaderboard(...args)
}));

jest.mock('../src/lib/logger', () => ({
  logUnexpectedError: (...args) => mockLogUnexpectedError(...args),
  logRuntimeEvent: (...args) => mockLogRuntimeEvent(...args)
}));

const command = require('../src/commands/recruiting/recruits');

function makeInteraction({ total = 5, points = 5, subGroup = 'total', sub = 'change' } = {}) {
  return {
    guild: {
      id: 'guild-1',
      members: {
        fetch: jest.fn(async () => ({ id: 'target-1' }))
      }
    },
    user: { id: 'admin-1', tag: 'Admin#0001' },
    member: { id: 'admin-1' },
    options: {
      getSubcommandGroup: jest.fn(() => subGroup),
      getSubcommand: jest.fn(() => sub),
      getUser: jest.fn(() => ({ id: 'target-1', tag: 'Target#0001' })),
      getInteger: jest.fn(() => total),
      getNumber: jest.fn(() => points),
      getString: jest.fn(() => 'manual correction')
    },
    deferReply: jest.fn(async () => null),
    editReply: jest.fn(async () => null),
    reply: jest.fn(async () => null),
    deferred: true,
    replied: false
  };
}

describe('/recruits total change command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureCommandAccess.mockResolvedValue(true);
    mockGetWeekStartUtcTs.mockReturnValue(1700000000000);
    mockGetRolling7DayStartTs.mockReturnValue(1699500000000);
    mockRecomputeLeaderboards.mockResolvedValue(undefined);
    mockRecomputeWarningsLeaderboard.mockResolvedValue(undefined);
    mockDbRun.mockResolvedValue({ changes: 1 });
  });

  test('requires admin access', async () => {
    const interaction = makeInteraction();
    mockEnsureCommandAccess.mockResolvedValue(false);

    await command.execute(interaction);

    expect(mockDbGet).not.toHaveBeenCalled();
    expect(mockDbRun).not.toHaveBeenCalled();
  });

  test('clears override when requested total equals real count', async () => {
    const interaction = makeInteraction({ total: 3 });
    mockDbGet.mockResolvedValue({ c: 3 });

    await command.execute(interaction);

    expect(mockDbGet).toHaveBeenCalledWith(
      expect.stringContaining('SELECT COUNT(*) as c FROM recruits'),
      'guild-1',
      'target-1',
      1699500000000
    );
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(mockDbRun).toHaveBeenCalledWith(
      expect.stringContaining('DELETE FROM weekly_recruit_overrides'),
      'guild-1',
      'target-1',
      1700000000000
    );
    expect(mockRecomputeLeaderboards).toHaveBeenCalledTimes(1);
    expect(mockRecomputeWarningsLeaderboard).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('Cleared weekly override')
      })
    );
  });

  test('upserts override when requested total differs', async () => {
    const interaction = makeInteraction({ total: 8 });
    mockDbGet.mockResolvedValue({ c: 2 });

    await command.execute(interaction);

    expect(mockDbRun).toHaveBeenCalledWith(
      expect.stringContaining('INSERT INTO weekly_recruit_overrides'),
      'guild-1',
      'target-1',
      1700000000000,
      8,
      expect.any(Number),
      'admin-1',
      'manual correction'
    );
    expect(mockRecomputeLeaderboards).toHaveBeenCalledTimes(1);
    expect(mockRecomputeWarningsLeaderboard).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('weekly recruit total to **8**')
      })
    );
  });

  test('updates recruiter points when using points change', async () => {
    const interaction = makeInteraction({ subGroup: 'points', sub: 'change', points: 12.5 });
    mockDbGet.mockResolvedValue({ points: 4.25 });

    await command.execute(interaction);

    expect(mockDbRun).toHaveBeenNthCalledWith(
      1,
      expect.stringContaining('INSERT OR IGNORE INTO recruiters'),
      'guild-1',
      'target-1'
    );
    expect(mockDbRun).toHaveBeenNthCalledWith(
      2,
      expect.stringContaining('UPDATE recruiters SET points'),
      12.5,
      'guild-1',
      'target-1'
    );
    expect(mockRecomputeLeaderboards).toHaveBeenCalledTimes(1);
    expect(mockRecomputeWarningsLeaderboard).toHaveBeenCalledTimes(1);
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({
        content: expect.stringContaining('recruiter points to **12.5**')
      })
    );
  });

  test('validates points input for points change', async () => {
    const interaction = makeInteraction({ subGroup: 'points', sub: 'change', points: -1 });

    await command.execute(interaction);

    expect(mockReplyError).toHaveBeenCalledWith(
      interaction,
      'Please provide a valid member and a non-negative points total.',
      { flags: 64 }
    );
  });

  test('rejects unsupported subcommands', async () => {
    const interaction = makeInteraction({ subGroup: 'other', sub: 'noop' });

    await command.execute(interaction);

    expect(mockReplyError).toHaveBeenCalledWith(
      interaction,
      'Unsupported subcommand.',
      { flags: 64 }
    );
  });
});

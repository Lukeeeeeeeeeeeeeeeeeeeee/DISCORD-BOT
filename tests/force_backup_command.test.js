const mockEnsureCommandAccess = jest.fn();
const mockReplyError = jest.fn(async () => null);
const mockGetAntiNuke = jest.fn();

jest.mock('../src/lib/command-auth', () => ({
  ensureCommandAccess: (...args) => mockEnsureCommandAccess(...args)
}));

jest.mock('../src/lib/embeds', () => ({
  replyError: (...args) => mockReplyError(...args)
}));

jest.mock('../src/lib/runtime', () => ({
  getAntiNuke: (...args) => mockGetAntiNuke(...args)
}));

const command = require('../src/commands/force_backup');

function makeInteraction() {
  return {
    guild: { id: 'G1', name: 'Guild One' },
    user: { id: 'U1', tag: 'User#0001' },
    deferReply: jest.fn(async () => null),
    editReply: jest.fn(async () => null),
    reply: jest.fn(async () => null)
  };
}

describe('/force_backup command', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureCommandAccess.mockResolvedValue(true);
  });

  test('does not double-log manual backup action', async () => {
    const interaction = makeInteraction();
    const antiNuke = {
      createBackup: jest.fn(async () => ({
        id: 'B1',
        counts: { roles: 1, channels: 2, threads: 0, emojis: 0, stickers: 0, bans: 0 }
      })),
      logAction: jest.fn()
    };
    mockGetAntiNuke.mockReturnValue(antiNuke);

    await command.execute(interaction);

    expect(antiNuke.createBackup).toHaveBeenCalledWith(interaction.guild, {
      type: 'full',
      manual: true,
      executorId: interaction.user.id
    });
    expect(antiNuke.logAction).not.toHaveBeenCalled();
    expect(interaction.editReply).toHaveBeenCalledWith({
      embeds: [expect.any(Object)]
    });
  });
});

jest.mock('../src/db_async', () => ({
  run: jest.fn()
}));

jest.mock('../src/lib/recruiting-system', () => ({
  hasModPlusPermissions: jest.fn()
}));

jest.mock('../src/lib/permissions', () => ({
  hasAdministrator: jest.fn()
}));

jest.mock('../src/lib/embeds', () => ({
  replyError: jest.fn(async (_interaction, message) => ({ error: message }))
}));

const db = require('../src/db_async');
const { hasModPlusPermissions } = require('../src/lib/recruiting-system');
const { hasAdministrator } = require('../src/lib/permissions');
const { replyError } = require('../src/lib/embeds');
const command = require('../src/commands/recruiting/rookiepoints');

function makeInteraction() {
  return {
    guild: { id: 'G1' },
    member: { id: 'M1' },
    user: { id: 'U1', tag: 'User#0001' },
    client: { user: { id: 'BOT1' } },
    options: {
      getSubcommand: jest.fn(() => 'reset-all'),
      getUser: jest.fn(),
      getNumber: jest.fn()
    },
    deferReply: jest.fn(async () => true),
    editReply: jest.fn(async (payload) => payload),
    reply: jest.fn(async (payload) => payload)
  };
}

describe('rookiepoints reset-all', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    hasModPlusPermissions.mockReturnValue(true);
    hasAdministrator.mockReturnValue(true);
  });

  test('resets guild rookie points using guild-aware query', async () => {
    const interaction = makeInteraction();
    db.run.mockResolvedValueOnce({ changes: 4 });

    await command.execute(interaction);

    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(db.run).toHaveBeenCalledTimes(1);
    expect(db.run.mock.calls[0][0]).toContain('WHERE guild_id = ?');
    expect(db.run.mock.calls[0][2]).toBe('G1');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('4 record(s)') })
    );
  });

  test('falls back to legacy schema when guild_id column is missing', async () => {
    const interaction = makeInteraction();
    db.run
      .mockRejectedValueOnce(new Error('SQLITE_ERROR: no such column: guild_id'))
      .mockResolvedValueOnce({ changes: 7 });

    await command.execute(interaction);

    expect(db.run).toHaveBeenCalledTimes(2);
    expect(db.run.mock.calls[0][0]).toContain('WHERE guild_id = ?');
    expect(db.run.mock.calls[1][0]).toBe('UPDATE rookie_points SET points = 0, updated_at = ?');
    expect(interaction.editReply).toHaveBeenCalledWith(
      expect.objectContaining({ content: expect.stringContaining('7 record(s)') })
    );
  });

  test('requires admin permission for reset-all', async () => {
    const interaction = makeInteraction();
    hasAdministrator.mockReturnValue(false);

    await command.execute(interaction);

    expect(replyError).toHaveBeenCalledWith(
      interaction,
      'Administrator permission required for reset-all.',
      { flags: 64 }
    );
    expect(db.run).not.toHaveBeenCalled();
  });
});

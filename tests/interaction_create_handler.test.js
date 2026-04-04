const { createInteractionCreateHandler } = require('../src/events/interaction-create');

describe('interactionCreate handler', () => {
  let consoleErrorSpy;

  beforeEach(() => {
    jest.clearAllMocks();
    consoleErrorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    consoleErrorSpy.mockRestore();
  });

  test('suppresses stale original-reply errors while reporting command failures', async () => {
    const dispatchCommand = jest.fn().mockRejectedValue(new Error('boom'));
    const logUnexpectedError = jest.fn().mockResolvedValue({ supportId: 'SUP-123' });
    const buildErrorEmbed = jest.fn(() => ({ title: 'Error' }));
    const handler = createInteractionCreateHandler({
      isSystemsReady: () => true,
      client: { commands: new Map([['leaderboard', {}]]) },
      db: {},
      analytics: { recordCommand: jest.fn().mockResolvedValue(undefined) },
      dispatchCommand,
      getCommandCategory: () => 'recruiting',
      getInteractionMeta: () => ({ command: 'leaderboard', guildId: 'guild-1' }),
      isAppError: () => false,
      logUnexpectedError,
      buildErrorEmbed
    });
    const interaction = {
      commandName: 'leaderboard',
      guild: { id: 'guild-1' },
      deferred: true,
      replied: false,
      isChatInputCommand: () => true,
      editReply: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
      reply: jest.fn()
    };

    await handler(interaction);

    expect(dispatchCommand).toHaveBeenCalledTimes(1);
    expect(logUnexpectedError).toHaveBeenCalledTimes(1);
    expect(buildErrorEmbed).toHaveBeenCalledWith('Command failed. Support ID: `SUP-123`.', 'Error');
    expect(interaction.editReply).toHaveBeenCalledWith({ embeds: [{ title: 'Error' }] });
    expect(consoleErrorSpy).not.toHaveBeenCalled();
  });
});

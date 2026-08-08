const { replyError } = require('../src/lib/embeds');

describe('replyError', () => {
  test('swallows unknown-message errors for deferred interactions', async () => {
    const interaction = {
      deferred: true,
      replied: false,
      editReply: jest.fn().mockRejectedValue(Object.assign(new Error('Unknown Message'), { code: 10008 })),
      followUp: jest.fn(),
      reply: jest.fn()
    };

    await expect(replyError(interaction, 'Failed to initialize leaderboards.')).resolves.toBeNull();

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });

  test('rethrows non-acknowledgement errors', async () => {
    const interaction = {
      deferred: false,
      replied: false,
      reply: jest.fn().mockRejectedValue(Object.assign(new Error('Missing Permissions'), { code: 50013 }))
    };

    await expect(replyError(interaction, 'Denied')).rejects.toThrow('Missing Permissions');
  });

  test('swallows nested acknowledgement errors', async () => {
    const interaction = {
      deferred: true,
      replied: false,
      editReply: jest.fn().mockRejectedValue({
        message: 'Request failed',
        rawError: { code: 10062, message: 'Unknown interaction' }
      }),
      followUp: jest.fn(),
      reply: jest.fn()
    };

    await expect(replyError(interaction, 'Failed to initialize leaderboards.')).resolves.toBeNull();

    expect(interaction.editReply).toHaveBeenCalledTimes(1);
    expect(interaction.followUp).not.toHaveBeenCalled();
    expect(interaction.reply).not.toHaveBeenCalled();
  });
});

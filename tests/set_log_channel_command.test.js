const mockEnsureCommandAccess = jest.fn();
const mockGetAntiNuke = jest.fn();
const mockProvisionTelemetryWebhooks = jest.fn();
const mockSetTelemetryRouting = jest.fn();
const mockLogUnexpectedError = jest.fn();
const mockLogRuntimeEvent = jest.fn();

jest.mock('../src/lib/command-auth', () => ({
  ensureCommandAccess: (...args) => mockEnsureCommandAccess(...args)
}));

jest.mock('../src/lib/runtime', () => ({
  getAntiNuke: (...args) => mockGetAntiNuke(...args)
}));

jest.mock('../src/lib/aecs', () => ({
  AECS: {
    setTelemetryRouting: (...args) => mockSetTelemetryRouting(...args)
  },
  provisionTelemetryWebhooks: (...args) => mockProvisionTelemetryWebhooks(...args)
}));

jest.mock('../src/lib/logger', () => ({
  logUnexpectedError: (...args) => mockLogUnexpectedError(...args),
  logRuntimeEvent: (...args) => mockLogRuntimeEvent(...args)
}));

jest.mock('../src/lib/embeds', () => ({
  buildErrorEmbed: (message, title) => ({ message, title })
}));

const cmd = require('../src/commands/set_log_channel');

function createInteraction(channel) {
  const interaction = {
    guild: {
      id: 'guild-1',
      name: 'Guild One',
      members: {
        me: { id: 'bot-1' },
        fetchMe: jest.fn(async () => ({ id: 'bot-1' }))
      }
    },
    client: { id: 'client-1' },
    user: {
      id: 'user-1',
      tag: 'Tester#0001'
    },
    options: {
      getChannel: jest.fn(() => channel)
    },
    deferred: false,
    replied: false,
    deferReply: jest.fn(async () => {
      interaction.deferred = true;
    }),
    editReply: jest.fn(async () => null),
    followUp: jest.fn(async () => null),
    reply: jest.fn(async () => null)
  };
  return interaction;
}

describe('/set_log_channel command', () => {
  const originalTelemetryChannel = process.env.AECS_TELEMETRY_CHANNEL_ID;

  beforeEach(() => {
    jest.clearAllMocks();
    mockEnsureCommandAccess.mockResolvedValue(true);
    mockLogUnexpectedError.mockResolvedValue({ supportId: null });
    mockLogRuntimeEvent.mockResolvedValue(null);
  });

  afterAll(() => {
    if (originalTelemetryChannel === undefined) {
      delete process.env.AECS_TELEMETRY_CHANNEL_ID;
    } else {
      process.env.AECS_TELEMETRY_CHANNEL_ID = originalTelemetryChannel;
    }
  });

  test('syncs AECS telemetry routing when log channel is configured', async () => {
    const antiNuke = {
      setLogChannel: jest.fn(),
      logAction: jest.fn()
    };
    mockGetAntiNuke.mockReturnValue(antiNuke);
    mockProvisionTelemetryWebhooks.mockResolvedValue({
      changed: true,
      skipped: false,
      config: {
        telemetryWebhookUrl: 'https://discord.com/api/webhooks/1/default',
        telemetryFatalWebhookUrl: 'https://discord.com/api/webhooks/2/fatal',
        telemetryHighImpactWebhookUrl: 'https://discord.com/api/webhooks/3/high',
        telemetryChannelId: 'channel-1'
      }
    });

    const channel = {
      id: 'channel-1',
      name: 'logs',
      type: 0,
      toString: () => '<#channel-1>',
      permissionsFor: () => ({
        has: () => true
      })
    };
    const interaction = createInteraction(channel);

    await cmd.execute(interaction);

    expect(antiNuke.setLogChannel).toHaveBeenCalledWith('guild-1', 'channel-1');
    expect(process.env.AECS_TELEMETRY_CHANNEL_ID).toBe('channel-1');
    expect(mockProvisionTelemetryWebhooks).toHaveBeenCalledWith(interaction.client);
    expect(mockSetTelemetryRouting).toHaveBeenCalledWith(expect.objectContaining({
      telemetryChannelId: 'channel-1'
    }));
    expect(mockLogRuntimeEvent).toHaveBeenCalled();
    expect(interaction.deferReply).toHaveBeenCalledWith({ flags: 64 });
    expect(interaction.editReply).toHaveBeenCalled();
  });

  test('continues command execution if telemetry refresh fails', async () => {
    const antiNuke = {
      setLogChannel: jest.fn(),
      logAction: jest.fn()
    };
    mockGetAntiNuke.mockReturnValue(antiNuke);
    mockProvisionTelemetryWebhooks.mockRejectedValue(new Error('telemetry failed'));

    const channel = {
      id: 'channel-2',
      name: 'logs-2',
      type: 0,
      toString: () => '<#channel-2>',
      permissionsFor: () => ({
        has: () => true
      })
    };
    const interaction = createInteraction(channel);

    await cmd.execute(interaction);

    expect(antiNuke.setLogChannel).toHaveBeenCalledWith('guild-1', 'channel-2');
    expect(mockLogUnexpectedError).toHaveBeenCalledWith(
      'command.setLogChannel.aecsTelemetry',
      expect.any(Error),
      expect.objectContaining({
        command: 'set_log_channel',
        guildId: 'guild-1',
        channelId: 'channel-2'
      })
    );
    expect(interaction.editReply).toHaveBeenCalled();
  });
});

const { provisionTelemetryWebhooks } = require('../src/lib/aecs/provision-telemetry-webhooks');

function makeWebhook({ id, token, name = 'AECS Telemetry', ownerId = 'bot-user' }) {
  return {
    id: String(id),
    token: String(token),
    name,
    owner: { id: ownerId },
    url: `https://discord.com/api/webhooks/${id}/${token}`
  };
}

function makeChannel({ id = 'chan-1', webhooks = null, canManageWebhooks = true } = {}) {
  const webhookStore = webhooks || new Map();
  return {
    id,
    isTextBased: () => true,
    permissionsFor: () => ({
      has: () => canManageWebhooks
    }),
    fetchWebhooks: jest.fn(async () => webhookStore),
    createWebhook: jest.fn(async ({ name }) => {
      const next = makeWebhook({
        id: `${webhookStore.size + 1}`,
        token: `token-${webhookStore.size + 1}`,
        name
      });
      webhookStore.set(next.id, next);
      return next;
    })
  };
}

describe('AECS telemetry webhook provisioning', () => {
  const envKeys = [
    'AECS_AUTO_CREATE_WEBHOOK',
    'AECS_TELEMETRY_CHANNEL_ID',
    'AECS_TELEMETRY_WEBHOOK_URL',
    'AECS_TELEMETRY_WEBHOOK_URL_FATAL',
    'AECS_TELEMETRY_WEBHOOK_URL_HIGH',
    'AECS_TELEMETRY_FATAL_CHANNEL_ID',
    'AECS_TELEMETRY_HIGH_CHANNEL_ID',
    'AECS_TELEMETRY_SPLIT_WEBHOOKS',
    'TELEMETRY_CHANNEL_ID',
    'LOG_CHANNEL_ID',
    'ANTINUKE_LOG_CHANNEL_ID',
    'DISCORD_LOG_CHANNEL_ID'
  ];
  let envSnapshot = null;

  beforeEach(() => {
    envSnapshot = {};
    for (const key of envKeys) envSnapshot[key] = process.env[key];
    for (const key of envKeys) delete process.env[key];
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (envSnapshot[key] === undefined) delete process.env[key];
      else process.env[key] = envSnapshot[key];
    }
  });

  test('creates default webhook and reuses it for fatal/high when split routing is disabled', async () => {
    process.env.AECS_AUTO_CREATE_WEBHOOK = 'true';
    process.env.AECS_TELEMETRY_CHANNEL_ID = 'chan-1';

    const channel = makeChannel({ id: 'chan-1' });
    const client = {
      user: { id: 'bot-user' },
      channels: {
        cache: new Map([['chan-1', channel]]),
        fetch: jest.fn(async (id) => channel.id === id ? channel : null)
      }
    };

    const result = await provisionTelemetryWebhooks(client);

    expect(result.changed).toBe(true);
    expect(result.config.telemetryWebhookUrl).toMatch(/^https:\/\/discord\.com\/api\/webhooks\/\d+\/token-\d+$/);
    expect(result.config.telemetryFatalWebhookUrl).toBe(result.config.telemetryWebhookUrl);
    expect(result.config.telemetryHighImpactWebhookUrl).toBe(result.config.telemetryWebhookUrl);
    expect(channel.createWebhook).toHaveBeenCalledTimes(1);
  });

  test('reuses configured default webhook URL when webhook exists', async () => {
    const existing = makeWebhook({ id: '991', token: 'existing-token', name: 'AECS Telemetry' });
    process.env.AECS_AUTO_CREATE_WEBHOOK = 'true';
    process.env.AECS_TELEMETRY_CHANNEL_ID = 'chan-1';
    process.env.AECS_TELEMETRY_WEBHOOK_URL = existing.url;

    const channel = makeChannel({
      id: 'chan-1',
      webhooks: new Map([[existing.id, existing]])
    });
    const client = {
      user: { id: 'bot-user' },
      channels: {
        cache: new Map([['chan-1', channel]]),
        fetch: jest.fn(async (id) => channel.id === id ? channel : null)
      }
    };

    const result = await provisionTelemetryWebhooks(client);

    expect(result.config.telemetryWebhookUrl).toBe(existing.url);
    expect(result.changed).toBe(false);
    expect(channel.createWebhook).not.toHaveBeenCalled();
  });

  test('accepts channel mention format in AECS_TELEMETRY_CHANNEL_ID', async () => {
    process.env.AECS_AUTO_CREATE_WEBHOOK = 'true';
    process.env.AECS_TELEMETRY_CHANNEL_ID = '<#123456789012345678>';

    const channel = makeChannel({ id: '123456789012345678' });
    const client = {
      user: { id: 'bot-user' },
      channels: {
        cache: new Map([['123456789012345678', channel]]),
        fetch: jest.fn(async (id) => channel.id === id ? channel : null)
      }
    };

    const result = await provisionTelemetryWebhooks(client);
    const defaultRoute = result.routes.find((route) => route.routeKey === 'default');

    expect(defaultRoute.status).toBe('created');
    expect(channel.createWebhook).toHaveBeenCalledTimes(1);
  });

  test('falls back to LOG_CHANNEL_ID when AECS_TELEMETRY_CHANNEL_ID is missing', async () => {
    process.env.AECS_AUTO_CREATE_WEBHOOK = 'true';
    process.env.LOG_CHANNEL_ID = 'chan-1';

    const channel = makeChannel({ id: 'chan-1' });
    const client = {
      user: { id: 'bot-user' },
      channels: {
        cache: new Map([['chan-1', channel]]),
        fetch: jest.fn(async (id) => channel.id === id ? channel : null)
      }
    };

    const result = await provisionTelemetryWebhooks(client);
    const defaultRoute = result.routes.find((route) => route.routeKey === 'default');

    expect(defaultRoute.status).toBe('created');
    expect(channel.createWebhook).toHaveBeenCalledTimes(1);
  });
});

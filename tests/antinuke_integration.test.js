jest.setTimeout(15000);

const AntiNukeSystem = require('../src/lib/antinuke-system');

describe('integration: anti-nuke -> rollback recording', () => {
  test('setupIntegration records pre/post state for handleRapidAction bans', async () => {
    const system = new AntiNukeSystem();

    // Prevent filesystem writes during test
    system.rollback.saveRollbackData = jest.fn(async () => {});

    const guildId = 'G_ANTI';
    const userId = 'U_ANTI';

    const member = {
      id: userId,
      user: { id: userId, tag: 'BadActor#0001' },
      roles: { cache: { map: jest.fn(() => []) } },
      joinedAt: new Date(Date.now() - 1000),
      nickname: null,
      ban: jest.fn().mockResolvedValue(true)
    };

    const guild = {
      id: guildId,
      name: 'GuildAnti',
      iconURL: () => null,
      ownerId: 'OWNER',
      members: {
        fetch: jest.fn(async (id) => (id === userId ? member : null))
      }
    };

    const client = {
      user: { id: 'BOT' },
      guilds: { cache: new Map([[guildId, guild]]) },
      users: { fetch: jest.fn(async () => null) }
    };

    // Wire anti-nuke to our client + guild
    system.antiNuke.client = client;
    system.antiNuke.whitelist = new Set();

    // Enable integration wrapping
    system.setupIntegration();

    // Trigger the wrapped method
    await system.antiNuke.handleRapidAction(guildId, userId, 'ban', [{ type: 'ban', timestamp: Date.now() }]);

    const data = system.rollback.rollbackData.get(guildId);
    expect(data).toBeDefined();
    expect(Array.isArray(data.actions)).toBe(true);
    expect(data.actions.length).toBeGreaterThan(0);

    const last = data.actions[data.actions.length - 1];
    expect(last.actionType).toBe('ban');
    expect(last.preState).toBeTruthy();
    expect(last.postState).toBeTruthy();
  });
});

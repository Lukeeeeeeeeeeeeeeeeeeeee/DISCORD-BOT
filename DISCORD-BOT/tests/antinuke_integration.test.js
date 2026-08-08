jest.setTimeout(15000);

const AntiNukeSystem = require('../src/lib/antinuke-system');

describe('integration: anti-nuke -> rollback recording', () => {
  test('setupIntegration records pre/post state for dynamic rapid action types', async () => {
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
      shard: { ids: [0] },
      guilds: { cache: new Map([[guildId, guild]]) },
      users: { fetch: jest.fn(async () => null) }
    };

    // Wire anti-nuke to our client + guild
    system.antiNuke.client = client;
    system.antiNuke.whitelist = new Set();

    // Enable integration wrapping
    system.setupIntegration();

    // Trigger the wrapped method
    await system.antiNuke.handleRapidAction(guildId, userId, 'roleDelete', [{ type: 'roleDelete', timestamp: Date.now() }]);

    const data = system.rollback.rollbackData.get(guildId);
    expect(data).toBeDefined();
    expect(Array.isArray(data.actions)).toBe(true);
    expect(data.actions.length).toBeGreaterThan(0);

    const last = data.actions[data.actions.length - 1];
    expect(last.actionType).toBe('rapid_role_delete');
    expect(last.meta).toMatchObject({
      shardId: 0,
      triggerActionType: 'roleDelete',
      eventFamily: 'rapid_action'
    });
    expect(last.preState).toBeTruthy();
    expect(last.postState).toBeTruthy();
  });

  test('records shard-specific metadata across multiple system instances', async () => {
    const mkSystem = (shardId, guildId, userId) => {
      const system = new AntiNukeSystem();
      system.rollback.saveRollbackData = jest.fn(async () => {});

      const member = {
        id: userId,
        user: { id: userId, tag: `User${userId}#0001` },
        roles: { cache: { map: jest.fn(() => []) } },
        joinedAt: new Date(),
        nickname: null,
        ban: jest.fn().mockResolvedValue(true)
      };

      const guild = {
        id: guildId,
        name: `Guild-${guildId}`,
        iconURL: () => null,
        ownerId: 'OWNER',
        members: {
          fetch: jest.fn(async (id) => (id === userId ? member : null))
        }
      };

      const client = {
        user: { id: 'BOT' },
        shard: { ids: [shardId] },
        guilds: { cache: new Map([[guildId, guild]]) },
        users: { fetch: jest.fn(async () => null) }
      };

      system.antiNuke.client = client;
      system.antiNuke.whitelist = new Set();
      system.setupIntegration();
      return { system, guildId, userId };
    };

    const shard0 = mkSystem(0, 'G0', 'U0');
    const shard1 = mkSystem(1, 'G1', 'U1');

    await shard0.system.antiNuke.handleRapidAction(shard0.guildId, shard0.userId, 'kick', [{ type: 'kick', timestamp: Date.now() }]);
    await shard1.system.antiNuke.handleRapidAction(shard1.guildId, shard1.userId, 'webhookCreate', [{ type: 'webhookCreate', timestamp: Date.now() }]);

    const action0 = shard0.system.rollback.rollbackData.get('G0').actions.slice(-1)[0];
    const action1 = shard1.system.rollback.rollbackData.get('G1').actions.slice(-1)[0];

    expect(action0.actionType).toBe('rapid_kick');
    expect(action1.actionType).toBe('rapid_webhook_create');
    expect(action0.meta.shardId).toBe(0);
    expect(action1.meta.shardId).toBe(1);
  });
});

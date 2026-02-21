jest.setTimeout(10000);

const AntiNuke = require('../src/lib/antinuke');

describe('emergency recover role mapping', () => {
  const originalRequireEncryption = process.env.ANTINUKE_REQUIRE_ENCRYPTION;

  beforeEach(() => {
    process.env.ANTINUKE_REQUIRE_ENCRYPTION = 'false';
  });

  afterEach(() => {
    if (originalRequireEncryption === undefined) {
      delete process.env.ANTINUKE_REQUIRE_ENCRYPTION;
    } else {
      process.env.ANTINUKE_REQUIRE_ENCRYPTION = originalRequireEncryption;
    }
  });

  test('maps source @everyone overwrite to target @everyone during cross-server recover', async () => {
    const antiNuke = new AntiNuke();
    antiNuke.OWNER_ID = 'OWNER';
    antiNuke.saveData = jest.fn();
    antiNuke.logAction = jest.fn();

    const overwriteSet = jest.fn(async () => true);
    const createdChannel = {
      id: 'CH_TARGET_1',
      permissionOverwrites: {
        set: overwriteSet
      }
    };
    const createChannel = jest.fn(async () => createdChannel);

    const everyoneRole = {
      id: 'TARGET',
      name: '@everyone',
      editable: false,
      permissions: '0'
    };

    const guild = {
      id: 'TARGET',
      roles: {
        cache: new Map([
          ['TARGET', everyoneRole]
        ]),
        everyone: everyoneRole,
        create: jest.fn(async () => null),
        setPositions: jest.fn(async () => true)
      },
      channels: {
        cache: new Map(),
        create: createChannel
      },
      emojis: { cache: new Map() },
      stickers: { cache: new Map() }
    };

    antiNuke.client = {
      guilds: {
        cache: new Map([
          ['TARGET', guild]
        ])
      }
    };

    const snapshot = {
      timestamp: Date.now(),
      guildMeta: { id: 'SOURCE', name: 'Source Guild' },
      roles: [
        {
          id: 'SOURCE',
          name: '@everyone',
          permissions: '0',
          position: 0,
          color: 0,
          hoist: false,
          mentionable: false
        }
      ],
      channels: [
        {
          id: 'CH_SOURCE_1',
          name: 'general',
          type: 0,
          position: 0,
          parentId: null,
          permissionOverwrites: [
            {
              id: 'SOURCE',
              type: 0,
              allow: '1024',
              deny: '0'
            }
          ]
        }
      ],
      threads: [],
      emojis: [],
      stickers: [],
      bans: [],
      onboarding: null
    };

    antiNuke.backups.set('SOURCE', {
      latestId: 'bk_1',
      full: [
        {
          id: 'bk_1',
          type: 'full',
          timestamp: snapshot.timestamp,
          payload: snapshot,
          counts: {
            roles: 1,
            channels: 1,
            threads: 0,
            emojis: 0,
            stickers: 0,
            bans: 0
          }
        }
      ],
      incremental: []
    });

    const result = await antiNuke.emergencyRecover('TARGET', null, {
      sourceGuildId: 'SOURCE',
      executorId: 'OWNER',
      restoreGuildMeta: false,
      restoreAssets: false,
      restoreBans: false,
      restoreOnboarding: false,
      restoreThreads: false
    });

    expect(result.success).toBe(true);
    expect(createChannel).toHaveBeenCalledTimes(1);
    const createPayload = createChannel.mock.calls[0][0];
    expect(createPayload.permissionOverwrites).toBeTruthy();
    expect(createPayload.permissionOverwrites[0].id).toBe('TARGET');

    expect(overwriteSet).toHaveBeenCalledTimes(1);
    const overwritePayload = overwriteSet.mock.calls[0][0];
    expect(overwritePayload[0].id).toBe('TARGET');
  });

  test('drops invalid role overwrites when role mapping is unavailable', async () => {
    const antiNuke = new AntiNuke();
    antiNuke.OWNER_ID = 'OWNER';
    antiNuke.saveData = jest.fn();
    antiNuke.logAction = jest.fn();

    const overwriteSet = jest.fn(async () => true);
    const createdChannel = {
      id: 'CH_TARGET_2',
      permissionOverwrites: {
        set: overwriteSet
      }
    };
    const createChannel = jest.fn(async () => createdChannel);

    const everyoneRole = {
      id: 'TARGET',
      name: '@everyone',
      editable: false,
      permissions: '0'
    };

    const guild = {
      id: 'TARGET',
      roles: {
        cache: new Map([
          ['TARGET', everyoneRole]
        ]),
        everyone: everyoneRole,
        create: jest.fn(async () => null),
        setPositions: jest.fn(async () => true)
      },
      channels: {
        cache: new Map(),
        create: createChannel
      },
      emojis: { cache: new Map() },
      stickers: { cache: new Map() }
    };

    antiNuke.client = {
      guilds: {
        cache: new Map([
          ['TARGET', guild]
        ])
      }
    };

    const snapshot = {
      timestamp: Date.now(),
      guildMeta: { id: 'SOURCE', name: 'Source Guild' },
      roles: [],
      channels: [
        {
          id: 'CH_SOURCE_2',
          name: 'ops',
          type: 0,
          position: 0,
          parentId: null,
          permissionOverwrites: [
            { id: 'SOURCE', type: 0, allow: '1024', deny: '0' },
            { id: 'ROLE_UNKNOWN', type: 0, allow: '2048', deny: '0' }
          ]
        }
      ],
      threads: [],
      emojis: [],
      stickers: [],
      bans: [],
      onboarding: null
    };

    antiNuke.backups.set('SOURCE', {
      latestId: 'bk_2',
      full: [
        {
          id: 'bk_2',
          type: 'full',
          timestamp: snapshot.timestamp,
          payload: snapshot,
          counts: {
            roles: 0,
            channels: 1,
            threads: 0,
            emojis: 0,
            stickers: 0,
            bans: 0
          }
        }
      ],
      incremental: []
    });

    const result = await antiNuke.emergencyRecover('TARGET', null, {
      sourceGuildId: 'SOURCE',
      executorId: 'OWNER',
      recreateMissingRoles: false,
      restoreGuildMeta: false,
      restoreAssets: false,
      restoreBans: false,
      restoreOnboarding: false,
      restoreThreads: false
    });

    expect(result.success).toBe(true);
    const createPayload = createChannel.mock.calls[0][0];
    expect(createPayload.permissionOverwrites).toHaveLength(1);
    expect(createPayload.permissionOverwrites[0].id).toBe('TARGET');

    const overwritePayload = overwriteSet.mock.calls[0][0];
    expect(overwritePayload).toHaveLength(1);
    expect(overwritePayload[0].id).toBe('TARGET');
  });
});

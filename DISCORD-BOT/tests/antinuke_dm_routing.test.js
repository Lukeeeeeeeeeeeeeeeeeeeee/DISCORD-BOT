const AntiNuke = require('../src/lib/antinuke');

describe('anti-nuke DM routing', () => {
  const originalLogDmId = process.env.ANTINUKE_LOG_DM_ID;
  const originalLogDmMode = process.env.ANTINUKE_LOG_DM_MODE;
  const originalLogDmIncludeNonCritical = process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL;
  const originalLogDmIncludeBackups = process.env.ANTINUKE_LOG_DM_INCLUDE_BACKUPS;
  const originalLogDmDuplicateWithChannel = process.env.ANTINUKE_LOG_DM_DUPLICATE_WITH_CHANNEL;

  beforeEach(() => {
    jest.clearAllMocks();
    delete process.env.ANTINUKE_LOG_DM_ID;
    delete process.env.ANTINUKE_LOG_DM_MODE;
    delete process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL;
    delete process.env.ANTINUKE_LOG_DM_INCLUDE_BACKUPS;
    delete process.env.ANTINUKE_LOG_DM_DUPLICATE_WITH_CHANNEL;
  });

  afterAll(() => {
    if (originalLogDmId === undefined) delete process.env.ANTINUKE_LOG_DM_ID;
    else process.env.ANTINUKE_LOG_DM_ID = originalLogDmId;
    if (originalLogDmMode === undefined) delete process.env.ANTINUKE_LOG_DM_MODE;
    else process.env.ANTINUKE_LOG_DM_MODE = originalLogDmMode;
    if (originalLogDmIncludeNonCritical === undefined) delete process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL;
    else process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL = originalLogDmIncludeNonCritical;
    if (originalLogDmIncludeBackups === undefined) delete process.env.ANTINUKE_LOG_DM_INCLUDE_BACKUPS;
    else process.env.ANTINUKE_LOG_DM_INCLUDE_BACKUPS = originalLogDmIncludeBackups;
    if (originalLogDmDuplicateWithChannel === undefined) delete process.env.ANTINUKE_LOG_DM_DUPLICATE_WITH_CHANNEL;
    else process.env.ANTINUKE_LOG_DM_DUPLICATE_WITH_CHANNEL = originalLogDmDuplicateWithChannel;
  });

  function attachClient(anti, { fetchUser }) {
    anti.client = {
      guilds: {
        cache: new Map([
          ['G1', { id: 'G1', name: 'Guild One', channels: { cache: new Map() } }]
        ])
      },
      users: {
        fetch: fetchUser
      }
    };
  }

  test('does not DM owners by default', async () => {
    const anti = new AntiNuke();
    const ownerSend = jest.fn(async () => null);
    const fetchUser = jest.fn(async () => ({ send: ownerSend }));
    attachClient(anti, { fetchUser });

    await anti.logAction('G1', { type: 'backup_created' });

    expect(fetchUser).not.toHaveBeenCalled();
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test('does not DM backup events by default even when DM mode is all', async () => {
    process.env.ANTINUKE_LOG_DM_ID = 'OWNER_DM';
    process.env.ANTINUKE_LOG_DM_MODE = 'all';
    const anti = new AntiNuke();
    const ownerSend = jest.fn(async () => null);
    const fetchUser = jest.fn(async () => ({ send: ownerSend }));
    attachClient(anti, { fetchUser });

    await anti.logAction('G1', { type: 'backup_created' });

    expect(fetchUser).not.toHaveBeenCalled();
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test('DMs backup events when explicitly enabled via include-backups flag', async () => {
    process.env.ANTINUKE_LOG_DM_ID = 'OWNER_DM';
    process.env.ANTINUKE_LOG_DM_MODE = 'all';
    process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL = 'true';
    process.env.ANTINUKE_LOG_DM_INCLUDE_BACKUPS = 'true';
    const anti = new AntiNuke();
    const ownerSend = jest.fn(async () => null);
    const fetchUser = jest.fn(async () => ({ send: ownerSend }));
    attachClient(anti, { fetchUser });

    await anti.logAction('G1', { type: 'backup_created' });

    expect(fetchUser).toHaveBeenCalledWith('OWNER_DM');
    expect(ownerSend).toHaveBeenCalledTimes(1);
  });

  test('prefers log channel over DM for non-critical events unless duplicate mode is enabled', async () => {
    process.env.ANTINUKE_LOG_DM_ID = 'OWNER_DM';
    process.env.ANTINUKE_LOG_DM_MODE = 'all';
    process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL = 'true';
    const send = jest.fn(async () => null);
    const anti = new AntiNuke();
    const ownerSend = jest.fn(async () => null);
    const fetchUser = jest.fn(async () => ({ send: ownerSend }));
    anti.client = {
      guilds: {
        cache: new Map([
          ['G1', {
            id: 'G1',
            name: 'Guild One',
            channels: {
              cache: new Map([['LOG1', { send }]])
            }
          }]
        ])
      },
      users: {
        fetch: fetchUser
      }
    };
    anti.logChannels.set('G1', 'LOG1');

    await anti.logAction('G1', { type: 'strict_mode_enabled' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchUser).not.toHaveBeenCalled();
    expect(ownerSend).not.toHaveBeenCalled();
  });

  test('falls back to DM when log channel send fails for non-critical events', async () => {
    process.env.ANTINUKE_LOG_DM_ID = 'OWNER_DM';
    process.env.ANTINUKE_LOG_DM_MODE = 'all';
    process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL = 'true';
    const send = jest.fn(async () => {
      throw new Error('Missing Permissions');
    });
    const anti = new AntiNuke();
    const ownerSend = jest.fn(async () => null);
    const fetchUser = jest.fn(async () => ({ send: ownerSend }));
    const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
    anti.client = {
      guilds: {
        cache: new Map([
          ['G1', {
            id: 'G1',
            name: 'Guild One',
            channels: {
              cache: new Map([['LOG1', { send }]])
            }
          }]
        ])
      },
      users: {
        fetch: fetchUser
      }
    };
    anti.logChannels.set('G1', 'LOG1');

    await anti.logAction('G1', { type: 'strict_mode_enabled' });

    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchUser).toHaveBeenCalledWith('OWNER_DM');
    expect(ownerSend).toHaveBeenCalledTimes(1);
    consoleSpy.mockRestore();
  });

  test('fetches configured log channel when it is not in cache', async () => {
    process.env.ANTINUKE_LOG_DM_ID = 'OWNER_DM';
    process.env.ANTINUKE_LOG_DM_MODE = 'all';
    process.env.ANTINUKE_LOG_DM_INCLUDE_NON_CRITICAL = 'true';
    const send = jest.fn(async () => null);
    const fetchChannel = jest.fn(async () => ({ send }));
    const anti = new AntiNuke();
    const ownerSend = jest.fn(async () => null);
    const fetchUser = jest.fn(async () => ({ send: ownerSend }));
    anti.client = {
      guilds: {
        cache: new Map([
          ['G1', {
            id: 'G1',
            name: 'Guild One',
            channels: {
              cache: new Map(),
              fetch: fetchChannel
            }
          }]
        ])
      },
      users: {
        fetch: fetchUser
      }
    };
    anti.logChannels.set('G1', 'LOG_FALLBACK');

    await anti.logAction('G1', { type: 'strict_mode_enabled' });

    expect(fetchChannel).toHaveBeenCalledWith('LOG_FALLBACK');
    expect(send).toHaveBeenCalledTimes(1);
    expect(fetchUser).not.toHaveBeenCalled();
    expect(ownerSend).not.toHaveBeenCalled();
  });
});

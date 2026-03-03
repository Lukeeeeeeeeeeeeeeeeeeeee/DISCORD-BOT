describe('analytics backpressure safeguards', () => {
  const envKeys = [
    'ANALYTICS_REQUEUE_MAX',
    'ANALYTICS_ROLE_CHANGE_QUEUE_MAX',
    'ANALYTICS_ROLE_CHANGE_FLUSH_MS',
    'ANALYTICS_ROLE_CHANGE_BATCH_BASE',
    'ANALYTICS_ROLE_CHANGE_BATCH_MAX',
    'ANALYTICS_DROP_ON_REQUEUE_CAP'
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

  let warnSpy;
  let errorSpy;

  beforeEach(() => {
    warnSpy = jest.spyOn(console, 'warn').mockImplementation(() => {});
    errorSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
  });

  afterEach(() => {
    for (const key of envKeys) {
      if (typeof originalEnv[key] === 'undefined') {
        delete process.env[key];
      } else {
        process.env[key] = originalEnv[key];
      }
    }
    jest.resetModules();
    jest.clearAllMocks();
    warnSpy.mockRestore();
    errorSpy.mockRestore();
  });

  test('caps role-change queue when transactions repeatedly fail', async () => {
    process.env.ANALYTICS_ROLE_CHANGE_QUEUE_MAX = '2';
    process.env.ANALYTICS_ROLE_CHANGE_FLUSH_MS = '0';
    process.env.ANALYTICS_ROLE_CHANGE_BATCH_BASE = '100';
    process.env.ANALYTICS_ROLE_CHANGE_BATCH_MAX = '100';

    const withTransaction = jest.fn(async () => {
      throw new Error('SQLITE_BUSY: database is locked');
    });
    jest.doMock('../src/db_async', () => ({}));
    jest.doMock('../src/lib/transactions', () => ({ withTransaction }));

    const analytics = require('../src/lib/analytics');
    await analytics.recordRoleChange({ guildId: 'G1', userId: 'U1', roleId: 'R1', action: 'added', timestamp: 1 });
    await analytics.recordRoleChange({ guildId: 'G1', userId: 'U2', roleId: 'R2', action: 'added', timestamp: 2 });
    await analytics.recordRoleChange({ guildId: 'G1', userId: 'U3', roleId: 'R3', action: 'added', timestamp: 3 });
    await analytics.recordRoleChange({ guildId: 'G1', userId: 'U4', roleId: 'R4', action: 'added', timestamp: 4 });

    await analytics.flushRoleChanges({ forceAll: true });

    expect(warnSpy).toHaveBeenCalledWith(
      'Analytics role change queue capped',
      expect.objectContaining({ cap: 2 })
    );
  });

  test('drops flush snapshot when requeue cap is exceeded under SQLITE_BUSY', async () => {
    process.env.ANALYTICS_REQUEUE_MAX = '1';
    process.env.ANALYTICS_DROP_ON_REQUEUE_CAP = 'true';

    const exec = jest.fn(async (sql) => {
      if (sql === 'BEGIN') {
        throw new Error('SQLITE_BUSY: database is locked');
      }
      return undefined;
    });
    const run = jest.fn(async () => undefined);

    jest.doMock('../src/db_async', () => ({ exec, run }));
    jest.doMock('../src/lib/transactions', () => ({
      withTransaction: jest.fn(async () => undefined)
    }));

    const analytics = require('../src/lib/analytics');
    await analytics.recordCommand({ guildId: 'G1', commandName: 'one', timestamp: 1 });
    await analytics.recordCommand({ guildId: 'G1', commandName: 'two', timestamp: 2 });
    await analytics.flushAll();

    expect(warnSpy).toHaveBeenCalledWith(
      'Analytics snapshot dropped after flush failure to prevent unbounded memory growth',
      expect.objectContaining({
        cap: 1,
        sqliteBusy: true
      })
    );
  });
});

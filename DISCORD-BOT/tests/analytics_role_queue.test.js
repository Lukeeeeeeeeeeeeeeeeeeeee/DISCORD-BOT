describe('analytics role change queue', () => {
  const envKeys = [
    'ANALYTICS_ROLE_CHANGE_FLUSH_MS',
    'ANALYTICS_ROLE_CHANGE_BATCH_BASE',
    'ANALYTICS_ROLE_CHANGE_BATCH_MAX'
  ];
  const originalEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]));

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
  });

  test('flushes buffered role changes in a single transaction when forced', async () => {
    process.env.ANALYTICS_ROLE_CHANGE_FLUSH_MS = '0';
    process.env.ANALYTICS_ROLE_CHANGE_BATCH_BASE = '100';
    process.env.ANALYTICS_ROLE_CHANGE_BATCH_MAX = '100';

    const tx = { run: jest.fn().mockResolvedValue(undefined) };
    const withTransaction = jest.fn(async (_db, fn) => fn(tx));

    jest.doMock('../src/db_async', () => ({}));
    jest.doMock('../src/lib/transactions', () => ({ withTransaction }));

    const analytics = require('../src/lib/analytics');

    await analytics.recordRoleChange({ guildId: 'G1', userId: 'U1', roleId: 'R1', roleName: 'Role A', action: 'added', timestamp: 1 });
    await analytics.recordRoleChange({ guildId: 'G1', userId: 'U2', roleId: 'R2', roleName: 'Role B', action: 'removed', timestamp: 2 });
    await analytics.recordRoleChange({ guildId: 'G1', userId: 'U3', roleId: 'R3', roleName: 'Role C', action: 'added', timestamp: 3 });

    expect(withTransaction).toHaveBeenCalledTimes(0);

    await analytics.flushRoleChanges({ forceAll: true });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(tx.run).toHaveBeenCalledTimes(3);
    expect(tx.run.mock.calls[0][0]).toContain('INSERT INTO analytics_role_changes');
  });

  test('auto flushes when queued role changes reach batch size', async () => {
    process.env.ANALYTICS_ROLE_CHANGE_FLUSH_MS = '0';
    process.env.ANALYTICS_ROLE_CHANGE_BATCH_BASE = '2';
    process.env.ANALYTICS_ROLE_CHANGE_BATCH_MAX = '2';

    const tx = { run: jest.fn().mockResolvedValue(undefined) };
    const withTransaction = jest.fn(async (_db, fn) => fn(tx));

    jest.doMock('../src/db_async', () => ({}));
    jest.doMock('../src/lib/transactions', () => ({ withTransaction }));

    const analytics = require('../src/lib/analytics');

    await analytics.recordRoleChange({ guildId: 'G2', userId: 'U1', roleId: 'R1', action: 'added', timestamp: 10 });
    await analytics.recordRoleChange({ guildId: 'G2', userId: 'U2', roleId: 'R2', action: 'removed', timestamp: 11 });

    await new Promise((resolve) => setImmediate(resolve));
    await analytics.flushRoleChanges({ forceAll: true });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(tx.run).toHaveBeenCalledTimes(2);
  });
});

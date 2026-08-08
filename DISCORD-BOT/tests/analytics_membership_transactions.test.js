jest.mock('../src/db_async', () => ({}));

jest.mock('../src/lib/transactions', () => ({
  withTransaction: jest.fn()
}));

const { withTransaction } = require('../src/lib/transactions');
const analytics = require('../src/lib/analytics');

describe('analytics membership transactional writes', () => {
  beforeEach(() => {
    jest.clearAllMocks();
  });

  test('recordJoin writes daily join increment and member row inside transaction', async () => {
    const tx = { run: jest.fn().mockResolvedValue(undefined) };
    withTransaction.mockImplementation(async (_db, fn) => fn(tx));

    await analytics.recordJoin({ guildId: 'G1', userId: 'U1', joinedAt: 1_700_000_000_000 });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(tx.run).toHaveBeenCalledTimes(2);
    expect(tx.run.mock.calls[0][0]).toContain('joins = joins + 1');
    expect(tx.run.mock.calls[1][0]).toContain('INSERT OR REPLACE INTO analytics_members');
  });

  test('recordLeave writes daily leave increment and member left_at inside transaction', async () => {
    const tx = { run: jest.fn().mockResolvedValue(undefined) };
    withTransaction.mockImplementation(async (_db, fn) => fn(tx));

    await analytics.recordLeave({ guildId: 'G2', userId: 'U2', leftAt: 1_700_000_100_000 });

    expect(withTransaction).toHaveBeenCalledTimes(1);
    expect(tx.run).toHaveBeenCalledTimes(2);
    expect(tx.run.mock.calls[0][0]).toContain('leaves = leaves + 1');
    expect(tx.run.mock.calls[1][0]).toContain('left_at');
  });
});

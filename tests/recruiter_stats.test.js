const { batchCalculate7DayStats } = require('../src/lib/recruiter-stats');

describe('batchCalculate7DayStats weekly overrides', () => {
  test('treats weekly overrides as a floor instead of pinning lower than real recruits', async () => {
    const all = jest.fn()
      .mockResolvedValueOnce([{ recruiter_id: 'r1', c: 6 }])
      .mockResolvedValueOnce([{ recruiter_id: 'r1', total: 4 }])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const db = { all };

    const statsMap = await batchCalculate7DayStats(db, ['r1'], null, {
      guildId: 'guild-1',
      sinceTs: 1700000000000,
      untilTs: 1700600000000,
      overrideWeekStart: 1700438400000
    });

    expect(statsMap.get('r1')).toEqual(
      expect.objectContaining({
        recruits7d: 6,
        activityRate: 6
      })
    );
  });
});

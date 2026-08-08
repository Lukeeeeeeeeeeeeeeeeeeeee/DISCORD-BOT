const { calculate7DayStats } = require('../src/lib/recruiting-system');

describe('calculate7DayStats weekly overrides', () => {
  test('uses weekly override total when present', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ c: 3 })
      .mockResolvedValueOnce({ total: 8 })
      .mockResolvedValueOnce({ c: 2 });
    const db = { get, all: jest.fn() };

    const stats = await calculate7DayStats(db, 'recruiter-1', null, {
      guildId: 'guild-1',
      sinceTs: 1700000000000,
      untilTs: 1700600000000
    });

    expect(stats.recruits7d).toBe(8);
    expect(stats.activityRate).toBe(8);
    expect(stats.verifyRate).toBeCloseTo(0.25, 5);
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('weekly_recruit_overrides'),
      'guild-1',
      'recruiter-1',
      1700000000000
    );
  });

  test('falls back to raw recruit count when no override row exists', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ c: 4 })
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ c: 1 });
    const db = { get, all: jest.fn() };

    const stats = await calculate7DayStats(db, 'recruiter-1', null, {
      guildId: 'guild-1',
      sinceTs: 1700000000000,
      untilTs: 1700600000000
    });

    expect(stats.recruits7d).toBe(4);
    expect(stats.activityRate).toBe(4);
    expect(stats.verifyRate).toBeCloseTo(0.25, 5);
  });

  test('supports rolling windows while still reading the current week override key', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ c: 4 })
      .mockResolvedValueOnce({ total: 6 })
      .mockResolvedValueOnce({ c: 3 });
    const db = { get, all: jest.fn() };

    const stats = await calculate7DayStats(db, 'recruiter-1', null, {
      guildId: 'guild-1',
      sinceTs: 1700000000000,
      untilTs: 1700600000000,
      overrideWeekStart: 1700438400000
    });

    expect(stats.recruits7d).toBe(6);
    expect(stats.activityRate).toBe(6);
    expect(stats.verifyRate).toBeCloseTo(0.5, 5);
    expect(get).toHaveBeenCalledWith(
      expect.stringContaining('weekly_recruit_overrides'),
      'guild-1',
      'recruiter-1',
      1700438400000
    );
  });

  test('does not let an older override pin counts below newer real recruits', async () => {
    const get = jest.fn()
      .mockResolvedValueOnce({ c: 7 })
      .mockResolvedValueOnce({ total: 5 })
      .mockResolvedValueOnce({ c: 2 });
    const db = { get, all: jest.fn() };

    const stats = await calculate7DayStats(db, 'recruiter-1', null, {
      guildId: 'guild-1',
      sinceTs: 1700000000000,
      untilTs: 1700600000000,
      overrideWeekStart: 1700438400000
    });

    expect(stats.recruits7d).toBe(7);
    expect(stats.activityRate).toBe(7);
  });
});

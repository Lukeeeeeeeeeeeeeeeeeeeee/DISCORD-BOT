const { getAverageWeeklyRecruitsMap } = require('../src/lib/recruiter-helpers');

describe('recruiter helpers', () => {
  test('getAverageWeeklyRecruitsMap uses recent weekly rows per recruiter', async () => {
    const db = {
      all: jest.fn()
        .mockResolvedValueOnce([
          { recruiter_id: 'r1', recruits7d: 6, sort_ts: 400 },
          { recruiter_id: 'r1', recruits7d: 4, sort_ts: 300 },
          { recruiter_id: 'r1', recruits7d: 2, sort_ts: 200 },
          { recruiter_id: 'r2', recruits7d: 10, sort_ts: 500 }
        ])
        .mockResolvedValueOnce([])
    };

    const result = await getAverageWeeklyRecruitsMap(db, ['r1', 'r2', 'r3'], 'g1', 2);

    expect(result.get('r1')).toBe(5);
    expect(result.get('r2')).toBe(10);
    expect(result.get('r3')).toBe(0);
    expect(db.all).toHaveBeenCalledTimes(2);
  });

  test('getAverageWeeklyRecruitsMap falls back to recruits counts when weekly data is missing', async () => {
    const db = {
      all: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([{ recruiter_id: 'r1', c: 7 }])
    };

    const result = await getAverageWeeklyRecruitsMap(db, ['r1', 'r2'], 'g1', 4);

    expect(result.get('r1')).toBe(1.8);
    expect(result.get('r2')).toBe(0);
    expect(db.all).toHaveBeenCalledTimes(2);
  });

  test('getAverageWeeklyRecruitsMap returns empty map for empty recruiter list', async () => {
    const db = { all: jest.fn() };
    const result = await getAverageWeeklyRecruitsMap(db, [], 'g1', 4);
    expect(result).toBeInstanceOf(Map);
    expect(result.size).toBe(0);
    expect(db.all).not.toHaveBeenCalled();
  });
});


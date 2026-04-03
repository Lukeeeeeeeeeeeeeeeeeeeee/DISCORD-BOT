const { fetchLeaderboardRows, loadRecruiterIdsFromRecentRecruits } = require('../src/lib/leaderboard-utils');

describe('fetchLeaderboardRows weekly overrides', () => {
  test('joins weekly overrides when weekStart is provided', async () => {
    const all = jest.fn().mockResolvedValue([]);
    const db = { all };

    await fetchLeaderboardRows(db, ['r1', 'r2'], {
      guildId: 'guild-1',
      weekStart: 1700000000000,
      sinceTs: 1700000000000
    });

    const sql = all.mock.calls[0][0];
    expect(sql).toContain('weekly_recruit_overrides');
    expect(sql).toContain('COALESCE(wro.total, c.cnt, 0) AS cnt');
  });

  test('does not join weekly overrides without weekStart', async () => {
    const all = jest.fn().mockResolvedValue([]);
    const db = { all };

    await fetchLeaderboardRows(db, ['r1'], {
      guildId: 'guild-1',
      sinceTs: 1700000000000
    });

    const sql = all.mock.calls[0][0];
    expect(sql).not.toContain('weekly_recruit_overrides');
    expect(sql).toContain('COALESCE(c.cnt, 0) AS cnt');
  });

  test('loads distinct recruiter ids from recent recruits globally', async () => {
    const all = jest.fn().mockResolvedValue([
      { recruiter_id: 'r1' },
      { recruiter_id: 'r2' },
      { recruiter_id: 'r1' }
    ]);
    const db = { all };

    const ids = await loadRecruiterIdsFromRecentRecruits(db, {
      guildId: 'guild-1',
      sinceTs: 1700000000000
    });

    expect(ids).toEqual(['r1', 'r2', 'r1']);
    expect(all).toHaveBeenCalledWith(
      expect.stringContaining('SELECT DISTINCT recruiter_id FROM recruits'),
      'guild-1',
      1700000000000
    );
  });

  test('loads distinct recruiter ids from recent recruits for a region', async () => {
    const all = jest.fn().mockResolvedValue([{ recruiter_id: 'r3' }]);
    const db = { all };

    const ids = await loadRecruiterIdsFromRecentRecruits(db, {
      guildId: 'guild-1',
      region: 'NA',
      sinceTs: 1700000000000
    });

    expect(ids).toEqual(['r3']);
    expect(all).toHaveBeenCalledWith(
      expect.stringContaining('region = ?'),
      'guild-1',
      'NA',
      1700000000000
    );
  });
});

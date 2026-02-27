const { fetchLeaderboardRows } = require('../src/lib/leaderboard-utils');

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
});

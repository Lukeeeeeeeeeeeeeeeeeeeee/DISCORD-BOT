const { makeLeaderboardEmbed } = require('../src/lib/messages');
const { MIN_LEADERBOARD_ENTRIES } = require('../src/constants');

describe('makeLeaderboardEmbed', () => {
  test('returns no-recruits embed for empty rows', () => {
    const embed = makeLeaderboardEmbed([], 'EU');
    const json = embed.toJSON();
    expect(json.title).toContain('Europe');
    expect(json.description).toBe('No weekly recruits yet.');
  });

  test('returns not-enough-data when below threshold', () => {
    const rows = Array(MIN_LEADERBOARD_ENTRIES - 1).fill(0).map((_,i)=>({ recruiter_id: `u${i}`, cnt: 1 }));
    const embed = makeLeaderboardEmbed(rows, 'NA');
    const json = embed.toJSON();
    expect(json.title).toContain('North America');
    expect(json.description).toContain('Not enough data yet');
  });

  test('returns podium and other fields when enough data', () => {
    const rows = [
      { recruiter_id: 'a', cnt: 10 },
      { recruiter_id: 'b', cnt: 7 },
      { recruiter_id: 'c', cnt: 5 },
      { recruiter_id: 'd', cnt: 3 },
      { recruiter_id: 'e', cnt: 2 }
    ];
    const embed = makeLeaderboardEmbed(rows, 'AS');
    const json = embed.toJSON();
    expect(json.title).toContain('Asia');
    const fields = json.fields.map(f => f.name);
    expect(fields).toContain('🏆 Podium');
    expect(fields).toContain('Other');
  });

  test('supports localization (spanish)', () => {
    const rows = [
      { recruiter_id: 'a', cnt: 5 },
      { recruiter_id: 'b', cnt: 4 },
      { recruiter_id: 'c', cnt: 3 },
      { recruiter_id: 'd', cnt: 1 },
      { recruiter_id: 'e', cnt: 1 }
    ];
    const embed = makeLeaderboardEmbed(rows, 'EU', 'es');
    const json = embed.toJSON();
    expect(json.title).toContain('Clasificación');
    expect(json.fields[0].name).toBe('🏆 Podio');
  });
});
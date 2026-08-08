const { makeLeaderboardEmbed } = require('../src/lib/messages');

describe('makeLeaderboardEmbed', () => {
  test('returns no-recruits embed for empty rows', () => {
    const embed = makeLeaderboardEmbed([], 'EU');
    const json = embed.toJSON();
    expect(json.title).toContain('Fire');
    expect(json.description).toContain('No recruiters');
  });

  test('lists below-threshold recruiters when there are few', () => {
    const rows = Array(3).fill(0).map((_,i)=>({ recruiter_id: `u${i}`, cnt: i+1, points: (i+1)*5 }));
    const embed = makeLeaderboardEmbed(rows, 'NA');
    const json = embed.toJSON();
    expect(json.title).toContain('Water');
    expect(json.fields[0].value).toMatch(/<@u0>/);
  });

  test('returns a full listing when enough data', () => {
    const rows = [
      { recruiter_id: 'a', cnt: 10, points: 50 },
      { recruiter_id: 'b', cnt: 7, points: 30 },
      { recruiter_id: 'c', cnt: 5, points: 20 }
    ];
    const embed = makeLeaderboardEmbed(rows, 'AS');
    const json = embed.toJSON();
    expect(json.title).toContain('Air');
    const fields = json.fields.map(f => f.name);
    expect(fields[0]).toMatch(/Leaderboard/);
  });

  test('supports localization (spanish)', () => {
    const rows = [
      { recruiter_id: 'a', cnt: 5, points: 10 },
      { recruiter_id: 'b', cnt: 4, points: 8 }
    ];
    const embed = makeLeaderboardEmbed(rows, 'EU', 'es');
    const json = embed.toJSON();
    expect(json.title).toContain('Clasificación');
    expect(json.fields[0].name).toContain('Clasificación');
  });
});

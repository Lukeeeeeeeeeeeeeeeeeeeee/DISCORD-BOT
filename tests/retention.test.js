jest.setTimeout(10000);
const econ = require('../src/lib/economy');

describe('computeRetentionFromGuild', () => {
  test('counts active recruits based on message thresholds', async () => {
    const twoIds = ['u1','u2'];
    // Channel mock: returns 20 messages from u1 within window, and 5 from u2
    const messages = [];
    const now = Date.now();
    for (let i = 0; i < 20; i++) messages.push({ author: { id: 'u1' }, createdTimestamp: now - (1 * 24 * 60 * 60 * 1000) });
    for (let i = 0; i < 5; i++) messages.push({ author: { id: 'u2' }, createdTimestamp: now - (1 * 24 * 60 * 60 * 1000) });

    const channel = { isTextBased: () => true, messages: { fetch: jest.fn(async () => messages) } };
    const guild = { channels: { cache: { values: () => [channel] } } };

    const ret = await econ.computeRetentionFromGuild(guild, twoIds, 7, 15, { maxChannels: 1, perChannelLimit: 100 });
    expect(ret).toBeCloseTo(0.5);
  });

  test('returns 0 if no recruits', async () => {
    const guild = { channels: { cache: { values: () => [] } } };
    const ret = await econ.computeRetentionFromGuild(guild, [], 7, 15);
    expect(ret).toBe(0);
  });

  test('fallback to heuristic when message fetch permission denied', async () => {
    const channel = { isTextBased: () => true, messages: { fetch: jest.fn(async () => { throw new Error('Missing Permissions'); }) } };
    const guild = { channels: { cache: { values: () => [channel] } } };
    const ret = await econ.computeRetentionFromGuild(guild, ['u1','u2'], 7, 15, { maxChannels: 1, perChannelLimit: 100, fallbackToHeuristic: true });
    expect(ret).toBe(0.5);

    const ret2 = await econ.computeRetentionFromGuild(guild, ['u1','u2'], 7, 15, { maxChannels: 1, perChannelLimit: 100, fallbackToHeuristic: false });
    expect(ret2).toBeNull();
  });
});

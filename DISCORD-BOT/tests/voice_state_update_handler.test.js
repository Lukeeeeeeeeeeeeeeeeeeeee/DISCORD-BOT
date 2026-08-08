const { createVoiceStateUpdateHandler } = require('../src/events/voice-state-update');

function makeMember(id = 'U1') {
  return { id, user: { bot: false } };
}

describe('voice state update handler hardening', () => {
  test('reports analytics failures with trace id and still clears in-memory session on leave', async () => {
    const voiceSessions = new Map();
    voiceSessions.set('G1:U1', { joinedAt: Date.now() - 120000 });
    const analytics = {
      recordVoiceMinutes: jest.fn(async () => {
        throw new Error('voice write failed');
      })
    };
    const onError = jest.fn();

    const handler = createVoiceStateUpdateHandler({
      analytics,
      voiceSessions,
      createTraceId: () => 'TRACE-VOICE-1',
      onError
    });

    const member = makeMember('U1');
    const guild = { id: 'G1' };
    await handler(
      { member, guild, channelId: 'VOICE_1' },
      { member, guild, channelId: null }
    );

    expect(analytics.recordVoiceMinutes).toHaveBeenCalledTimes(1);
    expect(voiceSessions.has('G1:U1')).toBe(false);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toEqual(expect.objectContaining({
      traceId: 'TRACE-VOICE-1',
      event: 'voiceStateUpdate',
      guildId: 'G1',
      userId: 'U1',
      stage: 'recordVoiceMinutes.leave'
    }));
  });

  test('reports persistence errors on join without aborting session tracking', async () => {
    const voiceSessions = new Map();
    const upsertVoiceSession = jest.fn(async () => {
      throw new Error('db unavailable');
    });
    const onError = jest.fn();

    const handler = createVoiceStateUpdateHandler({
      voiceSessions,
      upsertVoiceSession,
      createTraceId: () => 'TRACE-VOICE-2',
      onError
    });

    const member = makeMember('U2');
    const guild = { id: 'G2' };
    await handler(
      { member, guild, channelId: null },
      { member, guild, channelId: 'VOICE_2' }
    );

    expect(upsertVoiceSession).toHaveBeenCalledTimes(1);
    expect(voiceSessions.has('G2:U2')).toBe(true);
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0][1]).toEqual(expect.objectContaining({
      traceId: 'TRACE-VOICE-2',
      event: 'voiceStateUpdate',
      guildId: 'G2',
      userId: 'U2',
      stage: 'upsertVoiceSession.join'
    }));
  });
});

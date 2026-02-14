function createVoiceStateUpdateHandler({
  isSystemsReady,
  analytics,
  voiceSessions,
  upsertVoiceSession,
  deleteVoiceSession
} = {}) {
  return async function onVoiceStateUpdate(oldState, newState) {
    try {
      if (!isSystemsReady || !isSystemsReady()) return;
      const member = (newState && newState.member) || (oldState && oldState.member);
      if (!member || !member.user || member.user.bot) return;
      const guild = (newState && newState.guild) || (oldState && oldState.guild);
      if (!guild) return;
      const key = `${guild.id}:${member.id}`;
      const now = Date.now();
      const oldChannelId = oldState ? oldState.channelId : null;
      const newChannelId = newState ? newState.channelId : null;

      if (!oldChannelId && newChannelId) {
        voiceSessions.set(key, { joinedAt: now });
        if (typeof upsertVoiceSession === 'function') {
          await upsertVoiceSession(guild.id, member.id, now);
        }
        return;
      }

      if (oldChannelId && !newChannelId) {
        const session = voiceSessions.get(key);
        const joinedAt = session ? session.joinedAt : null;
        if (joinedAt && analytics && typeof analytics.recordVoiceMinutes === 'function') {
          const minutes = Math.max(1, Math.round((now - joinedAt) / 60000));
          await analytics.recordVoiceMinutes({ guildId: guild.id, userId: member.id, minutes, timestamp: now });
        }
        voiceSessions.delete(key);
        if (typeof deleteVoiceSession === 'function') {
          await deleteVoiceSession(guild.id, member.id);
        }
        return;
      }

      if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
        const session = voiceSessions.get(key);
        const joinedAt = session ? session.joinedAt : null;
        if (joinedAt && analytics && typeof analytics.recordVoiceMinutes === 'function') {
          const minutes = Math.max(1, Math.round((now - joinedAt) / 60000));
          await analytics.recordVoiceMinutes({ guildId: guild.id, userId: member.id, minutes, timestamp: now });
        }
        voiceSessions.set(key, { joinedAt: now });
        if (typeof upsertVoiceSession === 'function') {
          await upsertVoiceSession(guild.id, member.id, now);
        }
      }
    } catch (e) {
      console.error('Failed to process voiceStateUpdate analytics:', e);
    }
  };
}

module.exports = { createVoiceStateUpdateHandler };

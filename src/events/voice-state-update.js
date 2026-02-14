function createVoiceStateUpdateHandler({
  isSystemsReady,
  analytics,
  voiceSessions,
  upsertVoiceSession,
  deleteVoiceSession,
  createTraceId,
  onError
} = {}) {
  function fallbackTraceId() {
    return `VS-${Date.now().toString(36)}-${Math.random().toString(16).slice(2, 8)}`.toUpperCase();
  }

  function reportError(error, meta = {}) {
    const traceId = typeof createTraceId === 'function' ? createTraceId() : fallbackTraceId();
    const payload = {
      ...meta,
      traceId,
      event: 'voiceStateUpdate'
    };

    if (typeof onError === 'function') {
      try {
        onError(error, payload);
      } catch (handlerError) {
        console.error('voiceStateUpdate error handler failed:', handlerError);
        console.error('Failed to process voiceStateUpdate analytics:', error, payload);
      }
      return;
    }

    console.error('Failed to process voiceStateUpdate analytics:', error, payload);
  }

  return async function onVoiceStateUpdate(oldState, newState) {
    try {
      if (typeof isSystemsReady === 'function' && !isSystemsReady()) return;
      const member = (newState && newState.member) || (oldState && oldState.member);
      if (!member || !member.user || member.user.bot) return;
      const guild = (newState && newState.guild) || (oldState && oldState.guild);
      if (!guild) return;
      const key = `${guild.id}:${member.id}`;
      const now = Date.now();
      const oldChannelId = oldState ? oldState.channelId : null;
      const newChannelId = newState ? newState.channelId : null;
      const baseMeta = {
        guildId: guild.id,
        userId: member.id,
        oldChannelId,
        newChannelId
      };

      if (!oldChannelId && newChannelId) {
        voiceSessions.set(key, { joinedAt: now });
        if (typeof upsertVoiceSession === 'function') {
          await upsertVoiceSession(guild.id, member.id, now).catch(err => {
            reportError(err, { ...baseMeta, stage: 'upsertVoiceSession.join' });
          });
        }
        return;
      }

      if (oldChannelId && !newChannelId) {
        const session = voiceSessions.get(key);
        const joinedAt = session ? session.joinedAt : null;
        if (joinedAt && analytics && typeof analytics.recordVoiceMinutes === 'function') {
          const minutes = Math.max(1, Math.round((now - joinedAt) / 60000));
          await analytics.recordVoiceMinutes({ guildId: guild.id, userId: member.id, minutes, timestamp: now }).catch(err => {
            reportError(err, { ...baseMeta, stage: 'recordVoiceMinutes.leave', minutes });
          });
        }
        voiceSessions.delete(key);
        if (typeof deleteVoiceSession === 'function') {
          await deleteVoiceSession(guild.id, member.id).catch(err => {
            reportError(err, { ...baseMeta, stage: 'deleteVoiceSession.leave' });
          });
        }
        return;
      }

      if (oldChannelId && newChannelId && oldChannelId !== newChannelId) {
        const session = voiceSessions.get(key);
        const joinedAt = session ? session.joinedAt : null;
        if (joinedAt && analytics && typeof analytics.recordVoiceMinutes === 'function') {
          const minutes = Math.max(1, Math.round((now - joinedAt) / 60000));
          await analytics.recordVoiceMinutes({ guildId: guild.id, userId: member.id, minutes, timestamp: now }).catch(err => {
            reportError(err, { ...baseMeta, stage: 'recordVoiceMinutes.move', minutes });
          });
        }
        voiceSessions.set(key, { joinedAt: now });
        if (typeof upsertVoiceSession === 'function') {
          await upsertVoiceSession(guild.id, member.id, now).catch(err => {
            reportError(err, { ...baseMeta, stage: 'upsertVoiceSession.move' });
          });
        }
      }
    } catch (e) {
      const member = (newState && newState.member) || (oldState && oldState.member);
      const guild = (newState && newState.guild) || (oldState && oldState.guild);
      reportError(e, {
        guildId: guild ? guild.id : null,
        userId: member ? member.id : null,
        oldChannelId: oldState ? oldState.channelId : null,
        newChannelId: newState ? newState.channelId : null,
        stage: 'handler'
      });
    }
  };
}

module.exports = { createVoiceStateUpdateHandler };

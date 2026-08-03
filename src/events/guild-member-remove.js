function createGuildMemberRemoveHandler({
  isSystemsReady,
  analytics,
  voiceSessions,
  deleteVoiceSession,
  handleMemberLeave,
  db
} = {}) {
  return async function onGuildMemberRemove(member) {
    if (!isSystemsReady || !isSystemsReady()) return;
    if (!member || !member.guild || !member.id) return;

    try {
      if (analytics && typeof analytics.recordLeave === 'function') {
        await analytics.recordLeave({ guildId: member.guild.id, userId: member.id, leftAt: Date.now() });
      }
    } catch (e) {
      console.error('Failed to record leave analytics:', e);
    }

    try {
      if (voiceSessions && typeof voiceSessions.delete === 'function') {
        voiceSessions.delete(`${member.guild.id}:${member.id}`);
      }
      if (typeof deleteVoiceSession === 'function') {
        await deleteVoiceSession(member.guild.id, member.id);
      }
    } catch (e) {
      console.error(e);
    }

    try {
      await handleMemberLeave(db, member.guild, member);
    } catch (err) {
      console.error('Error handling member leave:', err);
    }
  };
}

module.exports = { createGuildMemberRemoveHandler };


function createGuildBanAddHandler({
  voiceSessions,
  deleteVoiceSession
} = {}) {
  return function onGuildBanAdd(ban) {
    if (!ban || !ban.guild || !ban.user) return;
    try {
      voiceSessions.delete(`${ban.guild.id}:${ban.user.id}`);
      void deleteVoiceSession(ban.guild.id, ban.user.id);
    } catch (e) {
      void e;
    }
  };
}

module.exports = { createGuildBanAddHandler };

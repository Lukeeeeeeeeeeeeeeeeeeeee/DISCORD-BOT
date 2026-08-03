function createGuildBanAddHandler({
  voiceSessions,
  deleteVoiceSession
} = {}) {
  return function onGuildBanAdd(ban) {
    if (!ban || !ban.guild || !ban.user) return;
    try {
      voiceSessions.delete(`${ban.guild.id}:${ban.user.id}`);
      if (typeof deleteVoiceSession === 'function') {
        deleteVoiceSession(ban.guild.id, ban.user.id).catch(err => {
          console.error('Failed to delete voice session on ban:', err);
        });
      } else {
        console.warn('deleteVoiceSession is not available');
      }
    } catch (e) {
      console.error(e);
    }
  };
}

module.exports = { createGuildBanAddHandler };


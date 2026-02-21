function createGuildMemberAddHandler({
  isSystemsReady,
  analytics,
  inviteInitPromise,
  getCachedInviteSystem,
  initInviteSystem,
  trackInviteUsage,
  db
} = {}) {
  return async function onGuildMemberAdd(member) {
    if (!isSystemsReady || !isSystemsReady()) return;
    try {
      await analytics.recordJoin({
        guildId: member.guild.id,
        userId: member.id,
        joinedAt: member.joinedAt ? member.joinedAt.getTime() : Date.now()
      });
    } catch (e) {
      console.error('Failed to record join analytics:', e);
    }

    try {
      await inviteInitPromise.catch(() => null);
      let inviteSystem = getCachedInviteSystem(member.guild.id);
      if (!inviteSystem) {
        inviteSystem = await initInviteSystem(member.guild.id, db);
      } else if (typeof inviteSystem.setDb === 'function') {
        inviteSystem.setDb(db);
      }
      if (!inviteSystem) return;

      console.log(` Member ${member.user.tag} joined the server`);
      await trackInviteUsage(member.guild, inviteSystem, member.id).catch(err => {
        console.error('Invite usage tracking failed:', err);
      });
    } catch (error) {
      console.error('Error tracking invite usage:', error);
    }
  };
}

module.exports = { createGuildMemberAddHandler };

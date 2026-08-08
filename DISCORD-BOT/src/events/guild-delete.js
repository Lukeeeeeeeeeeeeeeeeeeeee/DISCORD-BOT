function createGuildDeleteHandler({
  inviteSnapshots,
  inviteTrackLocks,
  invitePendingAttributions,
  invitePendingUpdatedAt,
  voiceSessions,
  db,
  disposeInviteSystem
} = {}) {
  return function onGuildDelete(guild) {
    if (!guild) return;
    inviteSnapshots.delete(guild.id);
    inviteTrackLocks.delete(guild.id);
    invitePendingAttributions.delete(guild.id);
    invitePendingUpdatedAt.delete(guild.id);
    for (const key of voiceSessions.keys()) {
      if (typeof key === 'string' && key.startsWith(`${guild.id}:`)) {
        voiceSessions.delete(key);
      }
    }
    db.run('DELETE FROM runtime_voice_sessions WHERE guild_id = ?', guild.id).catch(err => {
      console.error('Failed to delete runtime voice sessions for removed guild:', err);
    });
    try {
      disposeInviteSystem(guild.id);
    } catch (e) {
      console.error('Failed to dispose invite system state for guild:', e);
    }
  };
}

module.exports = { createGuildDeleteHandler };

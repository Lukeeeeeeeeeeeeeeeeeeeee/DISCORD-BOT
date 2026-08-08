function createMessageCreateHandler({
  isSystemsReady,
  enableMessageContent,
  analytics,
  db,
  client,
  trackRookieChatMessage,
  handleRookieWarLogMessage
} = {}) {
  return async function onMessageCreate(message) {
    if (!isSystemsReady || !isSystemsReady()) return;
    if (!message || !message.guild) return;
    if (!message.author || message.author.bot) return;

    const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
    if (!member) return;

    try {
      await analytics.recordMessage({
        guildId: message.guild.id,
        channelId: message.channelId,
        userId: message.author.id,
        timestamp: message.createdTimestamp || Date.now()
      });
    } catch (e) {
      console.error('Failed to record analytics message:', e);
    }

    try {
      await trackRookieChatMessage({ db, member, guild: message.guild, client });
    } catch (e) {
      console.error('Failed to track rookie chat message:', e);
    }

    if (enableMessageContent) {
      try {
        await handleRookieWarLogMessage({ db, message, member, guild: message.guild, client });
      } catch (e) {
        console.error('Failed to track rookie war log:', e);
      }
    }
  };
}

module.exports = { createMessageCreateHandler };

const { ROLE_IDS } = require('../constants');
const { getWeekStartUtcTs } = require('./week');

const CHAT_MESSAGES_PER_BLOCK = 105;
const CHAT_POINTS_PER_BLOCK = 1.5;

function isGuildColumnIssue(error) {
  const msg = String(error && error.message ? error.message : '').toLowerCase();
  if (msg.includes('on conflict clause does not match any primary key or unique constraint')) {
    return true;
  }
  return msg.includes('guild_id') && (
    msg.includes('no such column')
    || msg.includes('has no column named')
  );
}

async function trackRookieChatMessage({ db, member, guild, client }) {
  if (!db || !member || !guild) return;
  if (!member.roles || !member.roles.cache || !member.roles.cache.has(ROLE_IDS.ROOKIE)) return;

  const guildId = guild.id || 'GLOBAL';
  const weekStart = getWeekStartUtcTs();
  const now = Date.now();

  let row = null;
  try {
    try {
      row = await db.get(
        'SELECT message_count, awarded_chunks FROM rookie_chat_activity WHERE guild_id = ? AND member_id = ? AND week_start = ?',
        guildId,
        member.id,
        weekStart
      );
    } catch (e) {
      if (!isGuildColumnIssue(e)) throw e;
      row = await db.get(
        'SELECT message_count, awarded_chunks FROM rookie_chat_activity WHERE member_id = ? AND week_start = ?',
        member.id,
        weekStart
      );
    }
  } catch (e) {
    console.error('Failed to load rookie chat activity:', e);
  }

  const messageCount = (row ? Number(row.message_count) : 0) + 1;
  const awardedChunks = row ? Number(row.awarded_chunks || 0) : 0;
  const newChunks = Math.floor(messageCount / CHAT_MESSAGES_PER_BLOCK);

  try {
    try {
      await db.run(
        `INSERT INTO rookie_chat_activity (guild_id, member_id, week_start, message_count, awarded_chunks, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, member_id, week_start) DO UPDATE SET
           message_count = excluded.message_count,
           awarded_chunks = MAX(awarded_chunks, excluded.awarded_chunks),
           updated_at = excluded.updated_at`,
        guildId,
        member.id,
        weekStart,
        messageCount,
        Math.max(awardedChunks, newChunks),
        now
      );
    } catch (e) {
      if (!isGuildColumnIssue(e)) throw e;
      await db.run(
        `INSERT INTO rookie_chat_activity (member_id, week_start, message_count, awarded_chunks, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(member_id, week_start) DO UPDATE SET
           message_count = excluded.message_count,
           awarded_chunks = MAX(awarded_chunks, excluded.awarded_chunks),
           updated_at = excluded.updated_at`,
        member.id,
        weekStart,
        messageCount,
        Math.max(awardedChunks, newChunks),
        now
      );
    }
  } catch (e) {
    console.error('Failed to update rookie chat activity:', e);
  }

  if (newChunks > awardedChunks) {
    // We still track it in DB, but we no longer automatically award points.
    // Points can only be added manually via command.
  }
}

module.exports = {
  CHAT_MESSAGES_PER_BLOCK,
  CHAT_POINTS_PER_BLOCK,
  getWeekStartUtcTs,
  trackRookieChatMessage
};

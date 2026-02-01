const { CHANNELS, ROLE_IDS } = require('../constants');
const { addRookiePoints, formatPoints } = require('./rookie-points');

const CHAT_MESSAGES_PER_BLOCK = 105;
const CHAT_POINTS_PER_BLOCK = 1.5;

function getWeekStartUtcTs(now = new Date()) {
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  weekStart.setUTCDate(weekStart.getUTCDate() - diffToMonday);
  return weekStart.getTime();
}

async function trackRookieChatMessage({ db, member, guild, client }) {
  if (!db || !member || !guild) return;
  if (!member.roles || !member.roles.cache || !member.roles.cache.has(ROLE_IDS.ROOKIE)) return;

  const weekStart = getWeekStartUtcTs();
  const now = Date.now();

  let row = null;
  try {
    row = await db.get(
      'SELECT message_count, awarded_chunks FROM rookie_chat_activity WHERE member_id = ? AND week_start = ?',
      member.id,
      weekStart
    );
  } catch (e) {
    console.error('Failed to load rookie chat activity:', e);
  }

  const messageCount = (row ? Number(row.message_count) : 0) + 1;
  const awardedChunks = row ? Number(row.awarded_chunks || 0) : 0;
  const newChunks = Math.floor(messageCount / CHAT_MESSAGES_PER_BLOCK);

  try {
    await db.run(
      'INSERT OR REPLACE INTO rookie_chat_activity (member_id, week_start, message_count, awarded_chunks, updated_at) VALUES (?, ?, ?, ?, ?)',
      member.id,
      weekStart,
      messageCount,
      Math.max(awardedChunks, newChunks),
      now
    );
  } catch (e) {
    console.error('Failed to update rookie chat activity:', e);
  }

  if (newChunks <= awardedChunks) return;

  const deltaChunks = newChunks - awardedChunks;
  const pointsToAdd = deltaChunks * CHAT_POINTS_PER_BLOCK;

  const verifierId = client && client.user ? client.user.id : member.id;
  const result = await addRookiePoints({ db, member, delta: pointsToAdd, guild, verifierId });

  const logChannelId = CHANNELS && CHANNELS.ROOKIE_LOGS;
  if (logChannelId && guild.channels && guild.channels.cache) {
    const logChannel = guild.channels.cache.get(logChannelId);
    if (logChannel && logChannel.send) {
      const totalPoints = Number.isFinite(result.points) ? formatPoints(result.points) : '0';
      const msg = `💬 <@${member.id}> earned **${formatPoints(pointsToAdd)}** chat points (${messageCount} msgs this week). Total: **${totalPoints}/10**.`;
      logChannel.send(msg).catch(() => { });
    }
  }
}

module.exports = {
  CHAT_MESSAGES_PER_BLOCK,
  CHAT_POINTS_PER_BLOCK,
  getWeekStartUtcTs,
  trackRookieChatMessage
};

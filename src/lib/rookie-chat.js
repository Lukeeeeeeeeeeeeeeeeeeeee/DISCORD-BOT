const { CHANNELS, ROLE_IDS } = require('../constants');
const { addRookiePoints, formatPoints } = require('./rookie-points');
const { getWeekStartUtcTs } = require('./week');
const { resolveGuildId } = require('./guild');
const { withTransaction } = require('./transactions');
const { ROOKIE_CHAT_RULES } = require('../services/recruiting/rules-service');

const CHAT_MESSAGES_PER_BLOCK = ROOKIE_CHAT_RULES.MESSAGES_PER_BLOCK;
const CHAT_POINTS_PER_BLOCK = ROOKIE_CHAT_RULES.POINTS_PER_BLOCK;

async function trackRookieChatMessage({ db, member, guild, client }) {
  if (!db || !member || !guild) return;
  if (!member.roles || !member.roles.cache || !member.roles.cache.has(ROLE_IDS.ROOKIE)) return;
  const guildId = resolveGuildId(guild);

  const weekStart = getWeekStartUtcTs();
  const now = Date.now();

  let messageCount = 0;
  let awardedChunks = 0;
  let newChunks = 0;

  await withTransaction(db, async (tx) => {
    await tx.run(
      `INSERT OR IGNORE INTO rookie_chat_activity
       (guild_id, member_id, week_start, message_count, awarded_chunks, updated_at)
       VALUES (?, ?, ?, 0, 0, ?)`,
      guildId,
      member.id,
      weekStart,
      now
    );

    await tx.run(
      `UPDATE rookie_chat_activity
       SET message_count = message_count + 1, updated_at = ?
       WHERE guild_id = ? AND member_id = ? AND week_start = ?`,
      now,
      guildId,
      member.id,
      weekStart
    );

    const row = await tx.get(
      `SELECT message_count, awarded_chunks
       FROM rookie_chat_activity
       WHERE guild_id = ? AND member_id = ? AND week_start = ?`,
      guildId,
      member.id,
      weekStart
    );
    messageCount = row ? Number(row.message_count || 0) : 0;
    awardedChunks = row ? Number(row.awarded_chunks || 0) : 0;
    newChunks = Math.floor(messageCount / CHAT_MESSAGES_PER_BLOCK);
  }).catch((e) => {
    console.error('Failed to update rookie chat activity:', e);
  });

  if (newChunks <= awardedChunks) return;

  const deltaChunks = newChunks - awardedChunks;
  const pointsToAdd = deltaChunks * CHAT_POINTS_PER_BLOCK;

  // Reserve chunk payout atomically to avoid duplicate awards under concurrency.
  const claimRes = await db.run(
    `UPDATE rookie_chat_activity
     SET awarded_chunks = ?, updated_at = ?
     WHERE guild_id = ? AND member_id = ? AND week_start = ? AND awarded_chunks = ?`,
    newChunks,
    Date.now(),
    guildId,
    member.id,
    weekStart,
    awardedChunks
  ).catch((e) => {
    console.error('Failed to reserve rookie chat chunk payout:', e);
    return null;
  });
  if (!claimRes || !claimRes.changes) return;

  const beforePointsRow = await db.get(
    'SELECT points FROM rookie_points WHERE guild_id = ? AND member_id = ?',
    guildId,
    member.id
  ).catch(() => null);
  const beforePoints = beforePointsRow && Number.isFinite(Number(beforePointsRow.points))
    ? Number(beforePointsRow.points)
    : 0;

  const verifierId = client && client.user ? client.user.id : member.id;
  let result = null;
  try {
    result = await addRookiePoints({ db, member, delta: pointsToAdd, guild, verifierId });
  } catch (e) {
    const afterPointsRow = await db.get(
      'SELECT points FROM rookie_points WHERE guild_id = ? AND member_id = ?',
      guildId,
      member.id
    ).catch(() => null);
    const afterPoints = afterPointsRow && Number.isFinite(Number(afterPointsRow.points))
      ? Number(afterPointsRow.points)
      : beforePoints;
    if (afterPoints <= beforePoints && beforePoints < 10) {
      await db.run(
        `UPDATE rookie_chat_activity
         SET awarded_chunks = ?, updated_at = ?
         WHERE guild_id = ? AND member_id = ? AND week_start = ? AND awarded_chunks = ?`,
        awardedChunks,
        Date.now(),
        guildId,
        member.id,
        weekStart,
        newChunks
      ).catch(() => {});
    }
    console.error('Failed to add rookie chat points after chunk reservation:', e);
    return;
  }

  const logChannelId = CHANNELS && CHANNELS.ROOKIE_LOGS;
  if (logChannelId && guild.channels && guild.channels.cache) {
    const logChannel = guild.channels.cache.get(logChannelId);
    if (logChannel && logChannel.send) {
      const totalPoints = Number.isFinite(result.points) ? formatPoints(result.points) : '0';
      const msg = `💬 <@${member.id}> earned **${formatPoints(pointsToAdd)}** chat points (${messageCount} msgs this week). Total: **${totalPoints}/10**.`;
      logChannel.send(msg).catch(err => {
        console.error('Failed to post rookie chat log:', err);
      });
    }
  }
}

module.exports = {
  CHAT_MESSAGES_PER_BLOCK,
  CHAT_POINTS_PER_BLOCK,
  getWeekStartUtcTs,
  trackRookieChatMessage
};

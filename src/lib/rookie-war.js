const { CHANNELS, ROLE_IDS } = require('../constants');
const { addRookiePoints, formatPoints } = require('./rookie-points');
const { resolveGuildId } = require('./guild');
const { ROOKIE_WAR_RULES } = require('../services/recruiting/rules-service');

const WAR_GANK_POINTS = ROOKIE_WAR_RULES.POINTS;
const WAR_GANK_WINDOW_DAYS = ROOKIE_WAR_RULES.WINDOW_DAYS;
const WAR_GANK_MAX_PER_WINDOW = ROOKIE_WAR_RULES.MAX_PER_WINDOW;
const WAR_KEYWORD_RE = /\b(war|gank)(?:s|ed)?\b/i;

function isStructuredWarLogMessage(message) {
  if (!message || typeof message.content !== 'string') return false;
  const content = message.content.trim();
  if (!content || !WAR_KEYWORD_RE.test(content)) return false;

  const hasMention = !!(
    message.mentions
    && message.mentions.users
    && typeof message.mentions.users.size === 'number'
    && message.mentions.users.size > 0
  );
  const hasAttachment = !!(
    message.attachments
    && typeof message.attachments.size === 'number'
    && message.attachments.size > 0
  );
  const hasLink = /https?:\/\/\S+/i.test(content);
  const hasCombatHint = /\b(vs|versus)\b/i.test(content) || /\d+\s*-\s*\d+/.test(content);
  return hasMention || hasAttachment || hasLink || hasCombatHint;
}

async function handleRookieWarLogMessage({ db, message, member, guild, client }) {
  if (!db || !message || !guild) return;
  if (!member || !member.roles || !member.roles.cache || !member.roles.cache.has(ROLE_IDS.ROOKIE)) return;
  if (!CHANNELS || !CHANNELS.ROOKIE_LOGS) return;
  if (message.channelId !== CHANNELS.ROOKIE_LOGS) return;
  if (!isStructuredWarLogMessage(message)) return;
  const guildId = resolveGuildId(guild);

  const now = Date.now();

  try {
    const insertResult = await db.run(
      `INSERT OR IGNORE INTO rookie_war_logs
       (guild_id, member_id, message_id, created_at, type)
       VALUES (?, ?, ?, ?, ?)`,
      guildId,
      member.id,
      message.id,
      now,
      'war'
    );
    if (!insertResult || !insertResult.changes) return;
  } catch (e) {
    console.error('Failed to store rookie war log:', e);
    return;
  }

  const windowStart = now - (WAR_GANK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  const countRow = await db.get(
    'SELECT COUNT(*) as c FROM rookie_war_logs WHERE guild_id = ? AND member_id = ? AND created_at >= ?',
    guildId,
    member.id,
    windowStart
  ).catch((e) => {
    console.error('Failed to count rookie war logs:', e);
    return null;
  });

  const countAfterInsert = countRow ? Number(countRow.c || 0) : 0;
  if (countAfterInsert > WAR_GANK_MAX_PER_WINDOW) {
    if (message.channel && typeof message.channel.send === 'function') {
      message.channel.send(
        `Logged war/gank for <@${member.id}>, but no points awarded. `
        + `Window cap reached (${WAR_GANK_MAX_PER_WINDOW} logs every ${WAR_GANK_WINDOW_DAYS} days).`
      ).catch(err => {
        console.error('Failed to post rookie war cap response:', err);
      });
    }
    return;
  }

  const verifierId = client && client.user ? client.user.id : member.id;
  const result = await addRookiePoints({ db, member, delta: WAR_GANK_POINTS, guild, verifierId });

  const totalPoints = Number.isFinite(result.points) ? formatPoints(result.points) : '0';
  let response;
  if (result.promoted) {
    response = `Logged war/gank for <@${member.id}> (+${WAR_GANK_POINTS} points). Total: 10/10. Promoted to ${result.teamName}.`;
  } else if (result.promotionError) {
    response = `Logged war/gank for <@${member.id}> (+${WAR_GANK_POINTS} points). Total: ${totalPoints}/10. Promotion could not be completed: ${result.promotionError}`;
  } else {
    response = `Logged war/gank for <@${member.id}> (+${WAR_GANK_POINTS} points). Total: ${totalPoints}/10.`;
  }

  if (message.channel && message.channel.send) {
    message.channel.send(response).catch(err => {
      console.error('Failed to post rookie war response:', err);
    });
  }
}

module.exports = {
  WAR_GANK_POINTS,
  WAR_GANK_WINDOW_DAYS,
  WAR_GANK_MAX_PER_WINDOW,
  isStructuredWarLogMessage,
  handleRookieWarLogMessage
};

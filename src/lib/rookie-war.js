const { CHANNELS, ROLE_IDS } = require('../constants');
const { addRookiePoints, formatPoints } = require('./rookie-points');

const WAR_GANK_POINTS = 5;
const WAR_GANK_WINDOW_DAYS = 14;
const WAR_GANK_MAX_PER_WINDOW = 2;
const WAR_KEYWORD_RE = /\b(war|wars|gank|ganks|ganked)\b/i;

async function handleRookieWarLogMessage({ db, message, member, guild, client }) {
  if (!db || !message || !guild) return;
  if (!member || !member.roles || !member.roles.cache || !member.roles.cache.has(ROLE_IDS.ROOKIE)) return;
  if (!CHANNELS || !CHANNELS.ROOKIE_LOGS) return;
  if (message.channelId !== CHANNELS.ROOKIE_LOGS) return;
  if (!message.content || !WAR_KEYWORD_RE.test(message.content)) return;

  const now = Date.now();

  try {
    const existing = await db.get('SELECT id FROM rookie_war_logs WHERE message_id = ?', message.id);
    if (existing) return;
  } catch (e) {
    console.error('Failed to check rookie war logs:', e);
  }

  const windowStart = now - (WAR_GANK_WINDOW_DAYS * 24 * 60 * 60 * 1000);
  let countRow = null;
  try {
    countRow = await db.get(
      'SELECT COUNT(*) as c FROM rookie_war_logs WHERE member_id = ? AND created_at >= ?',
      member.id,
      windowStart
    );
  } catch (e) {
    console.error('Failed to count rookie war logs:', e);
  }

  const currentCount = countRow ? Number(countRow.c || 0) : 0;

  try {
    await db.run(
      'INSERT INTO rookie_war_logs (member_id, message_id, created_at, type) VALUES (?, ?, ?, ?)',
      member.id,
      message.id,
      now,
      'war'
    );
  } catch (e) {
    console.error('Failed to store rookie war log:', e);
  }

  if (currentCount >= WAR_GANK_MAX_PER_WINDOW) return;

  const verifierId = client && client.user ? client.user.id : member.id;
  const result = await addRookiePoints({ db, member, delta: WAR_GANK_POINTS, guild, verifierId });

  const totalPoints = Number.isFinite(result.points) ? formatPoints(result.points) : '0';
  const response = result.promoted
    ? `Logged war/gank for <@${member.id}> (+${WAR_GANK_POINTS} points). Total: 10/10. Promoted to ${result.teamName}.`
    : `Logged war/gank for <@${member.id}> (+${WAR_GANK_POINTS} points). Total: ${totalPoints}/10.`;

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
  handleRookieWarLogMessage
};

const { EmbedBuilder } = require('discord.js');
const { formatPointsValue } = require('./economy');

function makeRecruitEmbed(recruiter, recruited, region, ign, lang = 'en', meta = {}) {
  const { REGION_INFO } = require('../constants');
  const { t } = require('./i18n');
  const info = REGION_INFO[region] || { emoji: '', color: 0x00AAFF, name: region };
  const title = `${info.emoji} ${t('recruit.title', lang)}`;
  const embed = new EmbedBuilder()
    .setTitle(title)
    .setColor(info.color)
    .addFields(
      { name: 'Recruiter', value: `<@${recruiter}>`, inline: true },
      { name: 'Recruited', value: `<@${recruited}>`, inline: true },
      { name: 'Team', value: `${info.name}`, inline: true },
      { name: 'IGN', value: ign || 'N/A', inline: true }
    )
    .setTimestamp();

  if (meta.points !== undefined) embed.addFields({ name: 'Points', value: `${meta.points}`, inline: true });
  if (meta.recruiterRole) embed.addFields({ name: 'Recruiter Role', value: `${meta.recruiterRole}`, inline: true });

  if (info.thumbnail) embed.setThumbnail(info.thumbnail);
  return embed;
}

function normalizeMinReq(row) {
  const rawMinReq = row && row.minReq !== undefined ? row.minReq : null;
  if (rawMinReq == null) return row && row.absence ? 0 : 2;
  if (rawMinReq <= 0 && !(row && row.absence)) return 2;
  return rawMinReq;
}

function getRecruitCount(row) {
  return (row && (row.recruits7d || row.cnt)) ? (row.recruits7d || row.cnt) : 0;
}

function sortLeaderboardRows(rows) {
  return [...rows].sort((a, b) => {
    const aCount = getRecruitCount(a);
    const bCount = getRecruitCount(b);
    if (bCount !== aCount) return bCount - aCount;
    const aPoints = Number(a && a.points != null ? a.points : 0);
    const bPoints = Number(b && b.points != null ? b.points : 0);
    if (bPoints !== aPoints) return bPoints - aPoints;
    const aMinReq = normalizeMinReq(a);
    const bMinReq = normalizeMinReq(b);
    if (aMinReq !== bMinReq) return aMinReq - bMinReq;
    return 0;
  });
}

function sortDemotionRows(rows) {
  return [...rows].sort((a, b) => {
    const aWarnings = Number(a && a.warningCount != null ? a.warningCount : (a && a.activeWarnings != null ? a.activeWarnings : 0)) || 0;
    const bWarnings = Number(b && b.warningCount != null ? b.warningCount : (b && b.activeWarnings != null ? b.activeWarnings : 0)) || 0;
    if (bWarnings !== aWarnings) return bWarnings - aWarnings;
    const aCount = getRecruitCount(a);
    const bCount = getRecruitCount(b);
    if (bCount !== aCount) return bCount - aCount;
    const aPoints = Number(a && a.points != null ? a.points : 0);
    const bPoints = Number(b && b.points != null ? b.points : 0);
    if (bPoints !== aPoints) return bPoints - aPoints;
    const aMinReq = normalizeMinReq(a);
    const bMinReq = normalizeMinReq(b);
    if (aMinReq !== bMinReq) return aMinReq - bMinReq;
    return 0;
  });
}

function formatLeaderboardLine(row, index) {
  const mention = row && row.recruiter_id ? `<@${row.recruiter_id}>` : 'Unknown';
  const recruitCount = getRecruitCount(row);
  const minReq = normalizeMinReq(row);
  const points = row && row.points != null ? row.points : 0;
  const warningCountRaw = row && row.warningCount != null
    ? Number(row.warningCount)
    : (row && row.activeWarnings != null ? Number(row.activeWarnings) : null);
  const warningCount = Number.isFinite(warningCountRaw) ? warningCountRaw : null;
  const warningCountText = warningCount && warningCount > 0 ? ` ⚠️${warningCount}` : '';
  const warningFlag = row && row.systemWarning ? ' ⚠️**!**' : '';
  return `${index + 1}. ${mention} [${recruitCount}/${minReq} | ${formatPointsValue(points)} pts]${warningCountText}${warningFlag}`;
}

function makeLeaderboardText(rows, regionLabel, lang = 'en') {
  const { REGION_INFO } = require('../constants');
  const { t } = require('./i18n');

  // Map region codes to team names
  let info;
  if (regionLabel === 'GLOBAL') {
    info = { emoji: '🌍', name: 'Global' };
  } else if (regionLabel === 'EU') {
    info = { emoji: '🔥', name: 'Fire' };
  } else if (regionLabel === 'NA') {
    info = { emoji: '💧', name: 'Water' };
  } else if (regionLabel === 'AS') {
    info = { emoji: '🌬️', name: 'Air' };
  } else {
    info = REGION_INFO[regionLabel] || { emoji: '', name: regionLabel };
  }

  // Use big text header format
  const title = `# ${info.emoji} ${t('leaderboard.title', lang, { region: info.name })}`.trim();
  if (!rows || rows.length === 0) {
    const msg = `${title}\nNo recruiters found.`;
    return msg.length > 2000 ? msg.slice(0, 1997) + '...' : msg;
  }

  // Sort by recruits desc, then points desc, then minReq asc.
  const sortedRows = sortLeaderboardRows(rows);

  const lines = sortedRows.map((r, i) => formatLeaderboardLine(r, i));

  const out = [title, ...lines];
  let text = out.join('\n');
  if (text.length <= 2000) return text;

  // Fit as many lines as possible into a single message
  const kept = [title];
  for (const line of lines) {
    const next = kept.concat(line).join('\n');
    if (next.length > 1950) break;
    kept.push(line);
  }
  const remaining = lines.length - (kept.length - 1);
  if (remaining > 0) kept.push(`...and ${remaining} more`);
  text = kept.join('\n');
  return text.length > 2000 ? text.slice(0, 1997) + '...' : text;
}

function makeDemotionWatchText(rows, _lang = 'en') {
  const title = '# Demotion Watch';
  if (!rows || rows.length === 0) {
    const msg = `${title}\nNo recruiters on demotion watch.`;
    return msg.length > 2000 ? msg.slice(0, 1997) + '...' : msg;
  }

  const sortedRows = sortDemotionRows(rows);
  const lines = sortedRows.map((r, i) => formatLeaderboardLine(r, i));
  const out = [title, ...lines];
  let text = out.join('\n');
  if (text.length <= 2000) return text;

  const kept = [title];
  for (const line of lines) {
    const next = kept.concat(line).join('\n');
    if (next.length > 1950) break;
    kept.push(line);
  }
  const remaining = lines.length - (kept.length - 1);
  if (remaining > 0) kept.push(`...and ${remaining} more`);
  text = kept.join('\n');
  return text.length > 2000 ? text.slice(0, 1997) + '...' : text;
}

async function upsertLeaderboardMessage(db, channel, region, content, embed) {
  // record keyed by channel_id + region
  const record = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', channel.id, region);
  if (record) {
    const msg = await channel.messages.fetch(record.message_id).catch(() => null);
    if (msg) {
      if (embed && typeof embed === 'object' && typeof embed.toJSON === 'function') {
        await msg.edit({ content: content || null, embeds: [embed] });
      } else {
        await msg.edit(content);
      }
      await db.run('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?', Date.now(), record.id);
      return msg;
    } else {
      const m = embed && typeof embed === 'object' && typeof embed.toJSON === 'function' ? await channel.send({ content: content || null, embeds: [embed] }) : await channel.send(content);
      try {
        await db.run('UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE id = ?', m.id, Date.now(), record.id);
      } catch (e) {
        // best-effort: ignore DB problems
      }
      return m;
    }
  } else {
    const m = embed && typeof embed === 'object' && typeof embed.toJSON === 'function' ? await channel.send({ content: content || null, embeds: [embed] }) : await channel.send(content);
    try {
      await db.run('INSERT INTO leaderboard_messages (channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?)', channel.id, m.id, region, Date.now());
    } catch (e) {
      // ignore insert failure
    }
    return m;
  }
}

function makeLeaderboardEmbed(rows, regionLabel, lang = 'en') {
  const { REGION_INFO } = require('../constants');
  const { t } = require('./i18n');

  let info;
  if (regionLabel === 'GLOBAL') {
    info = { emoji: '🌍', color: 0xFFD700, name: 'Global' };
  } else {
    info = REGION_INFO[regionLabel] || { emoji: '', color: 0xFFD700, name: regionLabel };
  }

  const title = `${info.emoji} ${t('leaderboard.title', lang, { region: info.name })}`;
  const embed = new EmbedBuilder().setTitle(title).setColor(info.color).setTimestamp();

  if (!rows || rows.length === 0) {
    embed.setDescription('No recruiters found.');
    return embed;
  }

  const sortedRows = sortLeaderboardRows(rows);
  const lines = sortedRows.map((r, i) => formatLeaderboardLine(r, i));

  const fieldName = t('leaderboard.title', lang, { region: info.name });
  const chunks = [];
  let current = '';
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > 1024) {
      if (current) chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  const maxFields = 25;
  const toRender = chunks.slice(0, maxFields);
  for (let i = 0; i < toRender.length; i++) {
    const name = i === 0 ? fieldName : `${fieldName} (${i + 1})`;
    embed.addFields({ name, value: toRender[i] });
  }
  return embed;
}

function makeWarningsEmbed(rows, _lang = 'en') {
  const { t } = require('./i18n');
  const title = '⚠️ Warnings Leaderboard';

  const embed = new EmbedBuilder().setTitle(title).setColor(0xffaa00).setTimestamp();

  if (!rows || rows.length === 0) {
    embed.setDescription('No active warnings.');
    return embed;
  }

  const lines = rows.map((r, i) => `${i + 1}. <@${r.recruiter_id}> — **${r.cnt}** warnings`).join('\n');
  embed.addFields({ name: 'Warnings', value: lines });
  void t;
  return embed;
}

module.exports = {
  makeRecruitEmbed,
  upsertLeaderboardMessage,
  makeLeaderboardEmbed,
  makeLeaderboardText,
  makeWarningsEmbed,
  makeDemotionWatchText
};

const { EmbedBuilder } = require('discord.js');
const { formatPointsValue } = require('./economy');
const { getRegionInfo } = require('./regions');
const { t } = require('./i18n');

function makeRecruitEmbed(recruiter, recruited, region, ign, lang = 'en', meta = {}) {
  const info = getRegionInfo(region);
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
  // Map region codes to team names
  let info;
  if (regionLabel === 'GLOBAL') {
    info = { emoji: '🌍', name: 'Global' };
  } else {
    info = getRegionInfo(regionLabel);
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
    const msg = `${title}\nNo recruiter data available.`;
    return msg.length > 2000 ? msg.slice(0, 1997) + '...' : msg;
  }

  const sortedRows = sortDemotionRows(rows);
  const warningCount = (row) => {
    const raw = row && row.warningCount != null
      ? Number(row.warningCount)
      : (row && row.activeWarnings != null ? Number(row.activeWarnings) : 0);
    return Number.isFinite(raw) ? raw : 0;
  };

  const criticalRows = sortedRows.filter((row) => warningCount(row) >= 2);
  const warningRows = sortedRows.filter((row) => warningCount(row) === 1);
  const safeRows = sortedRows.filter((row) => warningCount(row) <= 0);

  const sections = [
    { title: '🔴 Critical (2+ warnings)', rows: criticalRows },
    { title: '⚠️ Warning (1 warning)', rows: warningRows },
    { title: '✅ Safe (0 warnings)', rows: safeRows }
  ];

  const lines = [title];
  for (const section of sections) {
    lines.push('');
    lines.push(section.title);
    if (!section.rows.length) {
      lines.push('None');
      continue;
    }
    section.rows.forEach((row, index) => {
      lines.push(formatLeaderboardLine(row, index));
    });
  }

  let text = lines.join('\n');
  if (text.length <= 2000) return text;

  const kept = [];
  let remainingRows = 0;
  for (const line of lines) {
    const next = kept.concat(line).join('\n');
    if (next.length > 1950) {
      break;
    }
    kept.push(line);
  }

  for (const section of sections) {
    remainingRows += section.rows.length;
  }
  const keptRows = kept.filter((line) => /^\d+\.\s/.test(line)).length;
  const hiddenRows = Math.max(0, remainingRows - keptRows);
  if (hiddenRows > 0) kept.push(`...and ${hiddenRows} more`);

  text = kept.join('\n');
  return text.length > 2000 ? text.slice(0, 1997) + '...' : text;
}

const LEADERBOARD_HISTORY_SCAN_LIMIT = Number.parseInt(process.env.LEADERBOARD_HISTORY_SCAN_LIMIT || '100', 10);

function isEmbedLike(value) {
  return Boolean(value && typeof value === 'object' && typeof value.toJSON === 'function');
}

function buildMessagePayload(content, embed) {
  const payload = { allowedMentions: { parse: [] } };
  if (isEmbedLike(embed)) {
    payload.content = content || null;
    payload.embeds = [embed];
    return payload;
  }
  payload.content = content == null ? '' : String(content);
  return payload;
}

function extractMessageText(message) {
  if (!message) return '';
  const parts = [];
  if (message.content) parts.push(String(message.content));
  const embeds = Array.isArray(message.embeds) ? message.embeds : [];
  for (const embed of embeds) {
    if (!embed) continue;
    if (embed.title) parts.push(String(embed.title));
    if (embed.description) parts.push(String(embed.description));
  }
  return parts.join('\n').toLowerCase();
}

function messageMatchesLeaderboardRegion(message, region) {
  const text = extractMessageText(message);
  if (!text) return false;
  const regionKey = region == null ? '' : String(region).toUpperCase();
  const hasLeaderboardWord = text.includes('leaderboard') || text.includes('clasificacion') || text.includes('clasificación');

  if (regionKey === 'WARNINGS') {
    return text.includes('demotion watch') || text.includes('warnings leaderboard');
  }
  if (regionKey === 'GLOBAL') {
    return text.includes('global') && hasLeaderboardWord;
  }
  const info = getRegionInfo(regionKey);
  const regionName = info && info.name ? String(info.name).toLowerCase() : '';
  return hasLeaderboardWord && (
    (regionName && text.includes(regionName))
    || text.includes(` ${regionKey.toLowerCase()} `)
  );
}

async function fetchRecentChannelMessages(channel, limit = LEADERBOARD_HISTORY_SCAN_LIMIT) {
  if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') return [];
  const fetched = await Promise.resolve(channel.messages.fetch({ limit })).catch(() => null);
  if (!fetched) return [];
  if (typeof fetched.values === 'function') return Array.from(fetched.values());
  if (Array.isArray(fetched)) return fetched;
  return [];
}

async function findReusableLeaderboardMessage(channel, region, keepMessageId = null) {
  const botUserId = channel && channel.client && channel.client.user ? channel.client.user.id : null;
  const recent = await fetchRecentChannelMessages(channel);
  for (const message of recent) {
    if (!message) continue;
    if (keepMessageId && message.id === keepMessageId) continue;
    if (botUserId && message.author && message.author.id !== botUserId) continue;
    if (!messageMatchesLeaderboardRegion(message, region)) continue;
    return message;
  }
  return null;
}

async function pruneDuplicateLeaderboardMessages(channel, region, keepMessageId) {
  if (!keepMessageId) return 0;
  const botUserId = channel && channel.client && channel.client.user ? channel.client.user.id : null;
  const recent = await fetchRecentChannelMessages(channel);
  let deleted = 0;
  for (const message of recent) {
    if (!message || message.id === keepMessageId) continue;
    if (botUserId && message.author && message.author.id !== botUserId) continue;
    if (!messageMatchesLeaderboardRegion(message, region)) continue;
    if (typeof message.delete !== 'function') continue;
    await message.delete().catch(() => null);
    deleted += 1;
  }
  return deleted;
}

async function getCanonicalLeaderboardRecord(db, guildId, channelId, region) {
  const records = await db.all(
    'SELECT * FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND region = ? ORDER BY updated_at DESC, id DESC',
    guildId,
    channelId,
    region
  );
  if (!records || records.length === 0) return null;
  const keep = records[0];
  for (let i = 1; i < records.length; i += 1) {
    await db.run('DELETE FROM leaderboard_messages WHERE id = ?', records[i].id).catch(() => null);
  }
  return keep;
}

function isUniqueConstraintError(error) {
  const msg = String(error && error.message ? error.message : '').toLowerCase();
  return msg.includes('unique constraint') || msg.includes('constraint failed');
}

async function upsertLeaderboardMessage(db, channel, region, content, embed, guildId) {
  // Try to resolve guildId from channel if not provided
  const resolvedGuildId = guildId || (channel && channel.guild ? channel.guild.id : null);
  const regionKey = region == null ? null : String(region).toUpperCase();
  const payload = buildMessagePayload(content, embed);

  if (!resolvedGuildId) {
    console.error('upsertLeaderboardMessage: Missing guildId', { channelId: channel && channel.id, region: regionKey });
    return null;
  }

  let record = await getCanonicalLeaderboardRecord(db, resolvedGuildId, channel.id, regionKey);
  const now = Date.now();

  if (record) {
    let msg = await channel.messages.fetch(record.message_id).catch(() => null);
    if (!msg) {
      msg = await findReusableLeaderboardMessage(channel, regionKey);
      if (msg) {
        await db.run(
          'UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE id = ?',
          msg.id,
          now,
          record.id
        ).catch((error) => {
          console.error('Failed to relink leaderboard message record:', error);
        });
      } else {
        const created = await channel.send(payload);
        try {
          await db.run(
            'UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE id = ?',
            created.id,
            now,
            record.id
          );
        } catch (error) {
          // Fail-closed: avoid orphan duplicates if we cannot persist pointer update.
          if (created && typeof created.delete === 'function') await created.delete().catch(() => null);
          console.error('Failed to update leaderboard message record:', error);
          return null;
        }
        msg = created;
      }
    }
    await msg.edit(payload);
    await db.run('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?', Date.now(), record.id).catch(() => null);
    await pruneDuplicateLeaderboardMessages(channel, regionKey, msg.id).catch(() => null);
    return msg;
  }

  let msg = await findReusableLeaderboardMessage(channel, regionKey);
  if (!msg) {
    msg = await channel.send(payload);
  } else {
    await msg.edit(payload);
  }

  try {
    await db.run(
      'INSERT INTO leaderboard_messages (guild_id, channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?, ?)',
      resolvedGuildId,
      channel.id,
      msg.id,
      regionKey,
      Date.now()
    );
  } catch (error) {
    if (isUniqueConstraintError(error)) {
      // Another runner won the race: reconcile and reuse canonical record.
      record = await getCanonicalLeaderboardRecord(db, resolvedGuildId, channel.id, regionKey);
      if (record) {
        const existing = await channel.messages.fetch(record.message_id).catch(() => null);
        if (existing) {
          await existing.edit(payload).catch(() => null);
          if (msg && existing.id !== msg.id && typeof msg.delete === 'function') {
            await msg.delete().catch(() => null);
          }
          await pruneDuplicateLeaderboardMessages(channel, regionKey, existing.id).catch(() => null);
          return existing;
        }
      }
    }
    if (msg && typeof msg.delete === 'function') await msg.delete().catch(() => null);
    console.error('Failed to insert leaderboard message record:', error);
    return null;
  }

  await pruneDuplicateLeaderboardMessages(channel, regionKey, msg.id).catch(() => null);
  return msg;
}

function makeLeaderboardEmbed(rows, regionLabel, lang = 'en') {
  let info;
  if (regionLabel === 'GLOBAL') {
    info = { emoji: '🌍', color: 0xFFD700, name: 'Global' };
  } else {
    info = getRegionInfo(regionLabel);
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
  const title = '⚠️ Warnings Leaderboard';

  const embed = new EmbedBuilder().setTitle(title).setColor(0xffaa00).setTimestamp();

  if (!rows || rows.length === 0) {
    embed.setDescription('No active warnings.');
    return embed;
  }

  const lines = rows.map((r, i) => `${i + 1}. <@${r.recruiter_id}> — **${r.cnt}** warnings`).join('\n');
  embed.addFields({ name: 'Warnings', value: lines });
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

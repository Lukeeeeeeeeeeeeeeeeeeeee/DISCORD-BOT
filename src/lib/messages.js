const { EmbedBuilder } = require('discord.js');

function makeRecruitEmbed(recruiter, recruited, region, ign, lang='en', meta = {}) {
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
      { name: 'Region', value: `${info.name} (${region})`, inline: true },
      { name: 'IGN', value: ign || 'N/A', inline: true }
    )
    .setTimestamp();

  if (meta.points !== undefined) embed.addFields({ name: 'Points', value: `${meta.points}`, inline: true });
  if (meta.recruiterRole) embed.addFields({ name: 'Recruiter Role', value: `${meta.recruiterRole}`, inline: true });

  if (info.thumbnail) embed.setThumbnail(info.thumbnail);
  return embed;
}

async function upsertLeaderboardMessage(db, channel, region, content, embed) {
  // record keyed by channel_id + region
  const record = await db.get('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?', channel.id, region);
  if (record) {
    const msg = await channel.messages.fetch(record.message_id).catch(()=>null);
    if (msg) {
      if (embed) await msg.edit({ content: content || null, embeds: [embed] });
      else await msg.edit(content);
      await db.run('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?', Date.now(), record.id);
      return msg;
    } else {
      const m = embed ? await channel.send({ content: content || null, embeds: [embed] }) : await channel.send(content);
      try {
        await db.run('UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE id = ?', m.id, Date.now(), record.id);
      } catch (e) {
        // best-effort: ignore DB problems
      }
      return m;
    }
  } else {
    const m = embed ? await channel.send({ content: content || null, embeds: [embed] }) : await channel.send(content);
    try {
      await db.run('INSERT INTO leaderboard_messages (channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?)', channel.id, m.id, region, Date.now());
    } catch (e) {
      // ignore insert failure
    }
    return m;
  }
}

function makeLeaderboardEmbed(rows, regionLabel, lang='en') {
  const { MIN_LEADERBOARD_ENTRIES, REGION_INFO } = require('../constants');
  const { t } = require('./i18n');
  const info = REGION_INFO[regionLabel] || { emoji: '', color: 0xFFD700, name: regionLabel };
  const title = `${info.emoji} ${t('leaderboard.title', lang, { region: info.name })}`;
  const embed = new EmbedBuilder().setTitle(title).setColor(info.color).setTimestamp();

  if (!rows || rows.length === 0) {
    embed.setDescription('No recruiters found.');
    if (info.thumbnail) embed.setThumbnail(info.thumbnail);
    return embed;
  }

  // Build a simple ordered list of all recruiters: rank. @user — N recruits — M pts
  // Show all recruiters, even those with 0 weekly recruits
  const lines = rows.map((r, i) => {
    const displayName = r.recruiter_id ? `<@${r.recruiter_id}>` : 'Unknown';
    const recruitCount = r.cnt || 0;
    const points = (r.points || 0);
    const minReq = r.minReq !== undefined ? ` — min: ${r.minReq}` : '';
    return `${i+1}. ${displayName} — **${recruitCount}** recruits — **${points}** pts${minReq}`;
  });
  
  embed.addFields({ name: t('leaderboard.title', lang), value: lines.join('\n') });

  if (info.thumbnail) embed.setThumbnail(info.thumbnail);
  return embed; 
}

function makeWarningsEmbed(rows, lang='en') {
  const { t } = require('./i18n');
  const embed = new EmbedBuilder().setTitle('⚠️ Warnings Leaderboard').setColor(0xFF4400).setTimestamp();
  if (!rows || rows.length === 0) {
    embed.setDescription('No active warnings.');
    return embed;
  }
  const lines = rows.map((r, i) => `${i+1}. <@${r.recruiter_id}> — **${r.cnt}** warnings`).join('\n');
  embed.setDescription(lines);
  return embed;
}

module.exports = {
  makeRecruitEmbed,
  upsertLeaderboardMessage,
  makeLeaderboardEmbed,
  makeWarningsEmbed
};

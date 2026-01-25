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
      if (embed && typeof embed === 'object' && embed.embeds) {
        await msg.edit({ content: content || null, embeds: [embed] });
      } else {
        await msg.edit(content);
      }
      await db.run('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?', Date.now(), record.id);
      return msg;
    } else {
      const m = embed && typeof embed === 'object' && embed.embeds ? await channel.send({ content: content || null, embeds: [embed] }) : await channel.send(content);
      try {
        await db.run('UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE id = ?', m.id, Date.now(), record.id);
      } catch (e) {
        // best-effort: ignore DB problems
      }
      return m;
    }
  } else {
    const m = embed && typeof embed === 'object' && embed.embeds ? await channel.send({ content: content || null, embeds: [embed] }) : await channel.send(content);
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
  const title = `# ${info.emoji} ${t('leaderboard.title', lang, { region: info.name })}`;

  if (!rows || rows.length === 0) {
    return { content: `${title}\n\nNo recruiters found.` };
  }

  // Build the new format: 1. @user [amount]/[min] **RETENTION RATIO [%]**
  const lines = rows.map((r, i) => {
    const displayName = r.recruiter_id ? `<@${r.recruiter_id}>` : 'Unknown';
    const recruitCount = r.recruits7d || r.cnt || 0;
    const minReq = r.minReq !== undefined ? r.minReq : 0;
    const retention = r.retention !== undefined ? Math.round(r.retention * 100) : 0;
    
    return `${i+1}. ${displayName} [${recruitCount}/${minReq}] **RETENTION RATIO [${retention}%]**`;
  });
  
  return { content: `${title}\n\n${lines.join('\n')}` };
}

function makeWarningsEmbed(rows, lang='en') {
  const { t } = require('./i18n');
  const title = '⚠️ Warnings Leaderboard';
  
  if (!rows || rows.length === 0) {
    return { content: `${title}\n\nNo active warnings.` };
  }
  
  const lines = rows.map((r, i) => `${i+1}. <@${r.recruiter_id}> — **${r.cnt}** warnings`).join('\n');
  return { content: `${title}\n\n${lines}` };
}

module.exports = {
  makeRecruitEmbed,
  upsertLeaderboardMessage,
  makeLeaderboardEmbed,
  makeWarningsEmbed
};

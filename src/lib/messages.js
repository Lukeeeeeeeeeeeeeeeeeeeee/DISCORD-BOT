const { EmbedBuilder } = require('discord.js');

function makeRecruitEmbed(recruiter, recruited, region, ign, lang='en') {
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
    embed.setDescription(t('leaderboard.no_recruits', lang));
    if (info.thumbnail) embed.setThumbnail(info.thumbnail);
    return embed;
  }
  if (rows.length < MIN_LEADERBOARD_ENTRIES) {
    embed.setDescription(t('leaderboard.not_enough', lang, { min: MIN_LEADERBOARD_ENTRIES }));
    if (info.thumbnail) embed.setThumbnail(info.thumbnail);
    return embed;
  }

  const podium = rows.slice(0,3);
  const others = rows.slice(3);

  const podiumText = podium.map((r, i) => `${['🥇','🥈','🥉'][i] || `${i+1}.`} <@${r.recruiter_id}> — **${r.cnt}**`).join('\n');
  embed.addFields({ name: t('leaderboard.podium', lang), value: podiumText });

  const peopleWith3 = rows.filter(r => r.cnt >= 3 && !podium.find(p => p.recruiter_id === r.recruiter_id));
  if (peopleWith3.length) {
    embed.addFields({ name: t('leaderboard.people_with_3', lang), value: peopleWith3.map(r => `<@${r.recruiter_id}> — ${r.cnt}`).join('\n') });
  }

  if (others.length) {
    embed.addFields({ name: t('leaderboard.other', lang), value: others.map((r, i) => `${i+4}. <@${r.recruiter_id}> — ${r.cnt}`).join('\n') });
  }

  if (info.thumbnail) embed.setThumbnail(info.thumbnail);
  return embed;
}

module.exports = {
  makeRecruitEmbed,
  upsertLeaderboardMessage,
  makeLeaderboardEmbed
};

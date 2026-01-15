const { EmbedBuilder } = require('discord.js');

function makeRecruitEmbed(recruiter, recruited, region, ign) {
  return new EmbedBuilder()
    .setTitle('New Recruit')
    .setColor(0x00AAFF)
    .addFields(
      { name: 'Recruiter', value: `<@${recruiter}>`, inline: true },
      { name: 'Recruited', value: `<@${recruited}>`, inline: true },
      { name: 'Region', value: region, inline: true },
      { name: 'IGN', value: ign || 'N/A', inline: true }
    )
    .setTimestamp();
}

async function upsertLeaderboardMessage(db, channel, region, content, embed) {
  // record keyed by channel_id + region
  const record = db.prepare('SELECT * FROM leaderboard_messages WHERE channel_id = ? AND region = ?').get(channel.id, region);
  if (record) {
    const msg = await channel.messages.fetch(record.message_id).catch(()=>null);
    if (msg) {
      if (embed) await msg.edit({ content: content || null, embeds: [embed] });
      else await msg.edit(content);
      db.prepare('UPDATE leaderboard_messages SET updated_at = ? WHERE id = ?').run(Date.now(), record.id);
      return msg;
    } else {
      const m = embed ? await channel.send({ content: content || null, embeds: [embed] }) : await channel.send(content);
      try {
        db.prepare('UPDATE leaderboard_messages SET message_id = ?, updated_at = ? WHERE id = ?').run(m.id, Date.now(), record.id);
      } catch (e) {
        // best-effort: ignore DB problems
      }
      return m;
    }
  } else {
    const m = embed ? await channel.send({ content: content || null, embeds: [embed] }) : await channel.send(content);
    try {
      db.prepare('INSERT INTO leaderboard_messages (channel_id, message_id, region, updated_at) VALUES (?, ?, ?, ?)')
        .run(channel.id, m.id, region, Date.now());
    } catch (e) {
      // ignore insert failure
    }
    return m;
  }
}

module.exports = {
  makeRecruitEmbed,
  upsertLeaderboardMessage
};

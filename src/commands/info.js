const db = require('../db_async');
const { EmbedBuilder } = require('discord.js');

function toUnixSeconds(ms) {
  return Math.floor(ms / 1000);
}

function safeDaysLeftFromEndDate(endDateStr) {
  if (!endDateStr) return null;
  const d = new Date(`${endDateStr}T23:59:59.000Z`);
  const diffMs = d.getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function getPrimaryMemberRoleLabel(guildMember) {
  if (!guildMember || !guildMember.roles || !guildMember.roles.cache) return 'Member';
  const { ROLE_IDS } = require('../constants');
  const picks = [
    { id: ROLE_IDS.LEADER, label: 'Leader' },
    { id: ROLE_IDS.CO_LEADER, label: 'Co-Leader' },
    { id: ROLE_IDS.CHIEF, label: 'Chief' },
    { id: ROLE_IDS.MOD, label: 'Mod' },
    { id: ROLE_IDS.HIGH_STAFF, label: 'High Staff' },
    { id: ROLE_IDS.HELPER_PLUS, label: 'Helper+' },
    { id: ROLE_IDS.HELPER, label: 'Helper' },
    { id: ROLE_IDS.RECRUITER, label: 'Recruiter' },
    { id: ROLE_IDS.TRIAL_RECRUITER, label: 'Trial Recruiter' },
    { id: ROLE_IDS.VIP, label: 'VIP' },
    { id: ROLE_IDS.MVP, label: 'MVP' },
    { id: ROLE_IDS.CUSTOM, label: 'Custom' },
    { id: ROLE_IDS.ROOKIE, label: 'Rookie' },
    { id: ROLE_IDS.UNVERIFIED, label: 'Unverified' }
  ].filter(r => r.id);

  for (const p of picks) {
    if (guildMember.roles.cache.has(p.id)) return p.label;
  }
  return 'Member';
}

module.exports = {
  data: { name: 'info' },
  async execute(interaction) {
    const member = interaction.options.getUser('member');
    if (!interaction.guild) return interaction.reply({ content: 'This command can only be used in a server.', flags: 64 });
    if (!member) return interaction.reply({ content: 'Missing member option.', flags: 64 });

    const rows = await db.all('SELECT * FROM recruits WHERE recruited_id = ? ORDER BY created_at DESC', member.id);
    if (!rows || rows.length === 0) return interaction.reply({ content: 'No recruit record for that member.', flags: 64 });
    const recruit = rows[0];

    const recruitMember = await interaction.guild.members.fetch(member.id).catch(() => null);
    const recruiterMember = await interaction.guild.members.fetch(recruit.recruiter_id).catch(() => null);
    const primaryRole = getPrimaryMemberRoleLabel(recruitMember);

    const embed = new EmbedBuilder()
      .setTitle(`Info: ${member.tag}`)
      .setColor(recruit.valid ? 0x00CC66 : 0xFF4444)
      .setTimestamp();

    embed.addFields(
      { name: 'Recruit', value: `<@${member.id}> (${member.id})`, inline: false },
      { name: 'Role', value: primaryRole, inline: true },
      { name: 'Valid', value: recruit.valid ? 'Yes' : 'No', inline: true },
      { name: 'Region', value: String(recruit.region || 'Unknown'), inline: true },
      { name: 'IGN', value: String(recruit.ign || 'Unknown'), inline: true }
    );

    if (recruit.created_at) {
      embed.addFields({
        name: 'Recruited',
        value: `<t:${toUnixSeconds(recruit.created_at)}:F> (<t:${toUnixSeconds(recruit.created_at)}:R>)`,
        inline: false
      });
    }

    if (recruitMember) {
      const joinedAtMs = recruitMember.joinedAt ? recruitMember.joinedAt.getTime() : null;
      const createdAtMs = recruitMember.user && recruitMember.user.createdAt ? recruitMember.user.createdAt.getTime() : null;
      const parts = [];
      if (joinedAtMs) parts.push(`Joined: <t:${toUnixSeconds(joinedAtMs)}:F> (<t:${toUnixSeconds(joinedAtMs)}:R>)`);
      if (createdAtMs) parts.push(`Account: <t:${toUnixSeconds(createdAtMs)}:F> (<t:${toUnixSeconds(createdAtMs)}:R>)`);
      if (parts.length) embed.addFields({ name: 'Member timing', value: parts.join('\n'), inline: false });
      embed.addFields({ name: 'Still in server', value: 'Yes', inline: true });
    } else {
      embed.addFields({ name: 'Still in server', value: 'No', inline: true });
    }

    embed.addFields({
      name: 'Recruiter',
      value: recruiterMember ? `<@${recruiterMember.id}> (${recruiterMember.user.tag})` : `<@${recruit.recruiter_id}> (${recruit.recruiter_id})`,
      inline: false
    });

    const absence = await db.get(
      'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now") ORDER BY created_at DESC LIMIT 1',
      recruit.recruiter_id
    );
    if (absence) {
      const daysLeft = safeDaysLeftFromEndDate(absence.end_date);
      embed.addFields({
        name: 'Recruiter absence',
        value: `Absent until **${absence.end_date}**${Number.isFinite(daysLeft) ? ` (${daysLeft}d left)` : ''}\nSet by: <@${absence.created_by}>`,
        inline: false
      });
    }

    const recentByRecruiter = await db.all(
      'SELECT recruited_id, created_at FROM recruits WHERE recruiter_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 5',
      recruit.recruiter_id
    );
    if (recentByRecruiter && recentByRecruiter.length) {
      embed.addFields({
        name: 'Recent recruits by this recruiter (last 5)',
        value: recentByRecruiter
          .map(r => `<@${r.recruited_id}> — <t:${toUnixSeconds(r.created_at)}:R>`)
          .join('\n'),
        inline: false
      });
    }

    embed.addFields({
      name: 'Recruit record history',
      value: rows.length === 1
        ? '1 record found'
        : `${rows.length} records found\n${rows.slice(0, 5).map(r => `#${r.id || '?'} — ${r.valid ? 'valid' : 'invalid'} — <t:${toUnixSeconds(r.created_at)}:R>`).join('\n')}`,
      inline: false
    });

    return interaction.reply({ embeds: [embed], flags: 64 });
  }
};
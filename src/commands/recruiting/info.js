const { EmbedBuilder } = require('discord.js');
const { replyError } = require('../../lib/embeds');
const { createResponder } = require('../../lib/respond');
const { getInfoData } = require('../../services/recruiting/info-service');
const defaultDb = require('../../db_async');

module.exports = {
  data: { name: 'info' },
  async execute(interaction, _client, db) {
    const member = interaction.options.getUser('member');
    if (!interaction.guild) return replyError(interaction, 'This command can only be used in a server.');
    if (!member) return replyError(interaction, 'Missing member option.');

    const { respond, defer } = createResponder(interaction, { allowedMentions: { parse: [] } });
    await defer();

    const dbHandle = db || defaultDb;
    const data = await getInfoData({ db: dbHandle, guild: interaction.guild, member });
    if (!data) return replyError(interaction, 'No recruit record for that member.');

    const embed = new EmbedBuilder()
      .setTitle(data.clampText(`Info: ${member.tag}`, 256))
      .setColor(data.recruit.valid ? 0x00CC66 : 0xFF4444)
      .setTimestamp();

    embed.addFields(
      { name: 'Recruit', value: `<@${member.id}> (${member.id})`, inline: false },
      { name: 'Role', value: data.primaryRole, inline: true },
      { name: 'Valid', value: data.recruit.valid ? 'Yes' : 'No', inline: true },
      { name: 'Region', value: String(data.recruit.region || 'Unknown'), inline: true },
      { name: 'IGN', value: String(data.recruit.ign || 'Unknown'), inline: true },
      { name: 'Verified', value: data.verification ? 'Yes' : 'No', inline: true },
      { name: 'Points', value: data.points != null ? `${data.formatPoints(data.points)}/10` : 'N/A', inline: true },
      { name: 'Points updated', value: data.pointsUpdatedAt ? `<t:${data.toUnixSeconds(data.pointsUpdatedAt)}:R>` : 'Unknown', inline: true }
    );

    if (data.verification && data.verification.verified_at) {
      const verifiedBy = data.verification.verified_by ? `\nBy: <@${data.verification.verified_by}>` : '';
      embed.addFields({
        name: 'Verified at',
        value: `<t:${data.toUnixSeconds(data.verification.verified_at)}:F> (<t:${data.toUnixSeconds(data.verification.verified_at)}:R>)${verifiedBy}`,
        inline: false
      });
    }

    if (data.recruit.created_at) {
      embed.addFields({
        name: 'Recruited',
        value: `<t:${data.toUnixSeconds(data.recruit.created_at)}:F> (<t:${data.toUnixSeconds(data.recruit.created_at)}:R>)`,
        inline: false
      });
    }

    if (data.recruitMember) {
      const joinedAtMs = data.recruitMember.joinedAt ? data.recruitMember.joinedAt.getTime() : null;
      const createdAtMs = data.recruitMember.user && data.recruitMember.user.createdAt ? data.recruitMember.user.createdAt.getTime() : null;
      const parts = [];
      if (joinedAtMs) parts.push(`Joined: <t:${data.toUnixSeconds(joinedAtMs)}:F> (<t:${data.toUnixSeconds(joinedAtMs)}:R>)`);
      if (createdAtMs) parts.push(`Account: <t:${data.toUnixSeconds(createdAtMs)}:F> (<t:${data.toUnixSeconds(createdAtMs)}:R>)`);
      if (parts.length) embed.addFields({ name: 'Member timing', value: parts.join('\n'), inline: false });
      embed.addFields({ name: 'Still in server', value: 'Yes', inline: true });
    } else {
      embed.addFields({ name: 'Still in server', value: 'No', inline: true });
    }

    embed.addFields({
      name: 'Recruiter',
      value: data.recruiterMember ? `<@${data.recruiterMember.id}> (${data.recruiterMember.user.tag})` : `<@${data.recruit.recruiter_id}> (${data.recruit.recruiter_id})`,
      inline: false
    });

    if (data.absence) {
      const daysLeft = data.safeDaysLeftFromEndDate(data.absence.end_date);
      embed.addFields({
        name: 'Recruiter absence',
        value: `Absent until **${data.absence.end_date}**${Number.isFinite(daysLeft) ? ` (${daysLeft}d left)` : ''}\nSet by: <@${data.absence.created_by}>`,
        inline: false
      });
    }

    if (data.recentByRecruiter && data.recentByRecruiter.length) {
      embed.addFields({
        name: 'Recent recruits by this recruiter (last 5)',
        value: data.recentByRecruiter
          .map(r => `<@${r.recruited_id}> � <t:${data.toUnixSeconds(r.created_at)}:R>`)
          .join('\n'),
        inline: false
      });
    }

    embed.addFields({
      name: 'Recruit record history',
      value: data.rows.length === 1
        ? '1 record found'
        : `${data.rows.length} records found\n${data.rows.slice(0, 5).map(r => `#${r.id || '?'} � ${r.valid ? 'valid' : 'invalid'} � <t:${data.toUnixSeconds(r.created_at)}:R>`).join('\n')}`,
      inline: false
    });

    return respond({ embeds: [embed] });
  }
};


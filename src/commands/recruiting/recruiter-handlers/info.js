const { EmbedBuilder } = require('discord.js');
const { hasRecruiterOrStaffPermissions, hasAdminOrStaffPermissions } = require('../../../lib/permissions');
const { formatPointsValue } = require('../../../lib/economy');
const { formatDiscordTimestamp, formatUtcDate } = require('../../../lib/time');
const { clampText, sanitizeForEmbed } = require('../../../lib/text');
const { safeDaysLeftFromEndDate, formatPct } = require('../../../lib/recruiter-helpers');
const { createResponder } = require('../../../lib/respond');
const { getRecruiterInfoData } = require('../../../services/recruiting/recruiter-info-service');

async function handleInfo({ interaction, db, guildId }) {
  const member = interaction.options.getUser('member') || interaction.user;
  const { respond, defer } = createResponder(interaction, { allowedMentions: { parse: [] } });
  await defer();

  const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
  if (!guildMember) {
    return respond({ content: 'Unable to verify your guild membership.' });
  }

  if (!hasRecruiterOrStaffPermissions(guildMember)) {
    return respond({ content: 'Recruiter/staff only.' });
  }

  if (member.id !== interaction.user.id && !hasAdminOrStaffPermissions(interaction.member)) {
    return respond({ content: 'You can only view your own recruiter info.' });
  }

  if (!interaction.guild) {
    return respond({ content: 'This command can only be used in a server.' });
  }

  const data = await getRecruiterInfoData({ db, guild: interaction.guild, guildId, memberId: member.id });

  const recentText = data.recruits.length
    ? data.recruits.map(r => `<@${r.recruited_id}> (${formatDiscordTimestamp(r.created_at, 'R')}) - ${formatPointsValue(r.points || 0)} pts`).join('\n')
    : 'None';

  const embed = new EmbedBuilder()
    .setTitle(clampText(`Recruiter: ${member.tag}`, 256))
    .addFields(
      { name: 'Points', value: `${data.pointsValue}`, inline: true },
      { name: 'Active Multiplier', value: data.mul && data.mul.type ? `${data.mul.type} - x${data.mul.value}` : 'None', inline: true },
      { name: 'Total recruits (all time)', value: `${data.totalAll}`, inline: true },
      { name: 'Recruits (7 days)', value: `${data.stats7d.recruits7d}`, inline: true },
      { name: 'Verify rate (7d)', value: formatPct(data.stats7d.verifyRate), inline: true },
      { name: 'Avg recruits/week', value: data.avgRecruitsDisplay, inline: true },
      { name: 'Warnings (active)', value: `${data.activeWarnings}`, inline: true },
      { name: 'Warnings (all time)', value: `${data.totalWarnings}`, inline: true },
      { name: 'Min recruits required', value: `${data.minReq}`, inline: true }
    )
    .addFields(
      { name: 'Recent recruits (last 5)', value: sanitizeForEmbed(recentText || 'None') },
      { name: 'Status', value: data.statusLabel, inline: true }
    )
    .setColor(data.statusColor)
    .setTimestamp();

  if (data.absence) {
    const daysLeft = safeDaysLeftFromEndDate(data.absence.end_date);
    embed.addFields({
      name: 'Absence details',
      value: `Until **${data.absence.end_date}**${Number.isFinite(daysLeft) ? ` (${daysLeft}d left)` : ''}\nSet by: <@${data.absence.created_by}>`,
      inline: false
    });
  }

  embed.addFields({
    name: 'Retention (7d cohort)',
    value: data.cohort7d.cohortSize > 0
      ? `${data.retention7dPct}% (${data.cohort7d.retained}/${data.cohort7d.cohortSize})${data.cohort7d.sampled ? ' (sampled)' : ''}`
      : 'N/A',
    inline: true
  });
  embed.addFields({
    name: 'Retention (all time, =7d old)',
    value: data.allTimeCohortSize > 0
      ? `${data.retentionAllPct}% (${data.allTimeRetained}/${data.allTimeCohortSize})${data.allTimeSampled ? ' (sampled)' : ''}`
      : 'N/A',
    inline: true
  });

  const topN = data.totalAll >= 10 ? 5 : 3;
  const topRetained = data.retainedDurations.slice(0, topN);
  if (topRetained.length) {
    embed.addFields({
      name: `Longest retained recruits (top ${topRetained.length})`,
      value: topRetained
        .map(r => `<@${r.recruitedId}> - ${r.days}d (recruited <t:${data.toUnixSeconds(r.createdAt)}:R>)`)
        .join('\n'),
      inline: false
    });
  }

  if (data.purchases.length) {
    embed.addFields({
      name: 'Recent purchases',
      value: sanitizeForEmbed(data.purchases.map(p => `${p.item} - ${formatPointsValue(p.cost)} pts`).join('\n'))
    });
  }
  if (data.multipliers.length) {
    embed.addFields({
      name: 'Multipliers (recent)',
      value: sanitizeForEmbed(data.multipliers.slice(0, 3).map(m => `${m.type} - x${m.value} (exp ${formatDiscordTimestamp(m.expires_at, 'R')})`).join('\n'))
    });
  }
  if (data.recentFlags.length) {
    embed.addFields({
      name: 'Recent flags',
      value: sanitizeForEmbed(data.recentFlags.map(f => `${formatDiscordTimestamp(f.created_at, 'R')} - ${f.reason}`).join('\n'))
    });
  }
  if (data.recentWarnings.length) {
    embed.addFields({
      name: 'Recent warnings',
      value: sanitizeForEmbed(data.recentWarnings.map(w => `${formatDiscordTimestamp(w.created_at, 'R')} - ${w.note || ''}`).join('\n'))
    });
  }

  embed.setFooter({ text: `7-Day Retention: ${Math.round(data.stats7d.retention * 100)}% - Last recruit: ${data.lastTs ? formatUtcDate(data.lastTs) : 'Never'}` });

  return respond({ embeds: [embed] });
}

const handlers = { info: handleInfo };

module.exports = { handlers };

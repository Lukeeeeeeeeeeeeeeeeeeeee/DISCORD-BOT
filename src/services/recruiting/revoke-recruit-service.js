const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { ROLE_IDS, CHANNELS } = require('../../constants');
const { replyError } = require('../../lib/embeds');
const recruitsRepo = require('../../repos/recruits-repo');
const { withTransaction } = require('../../lib/transactions');
const { changeRecruiterPoints } = require('./ledger-service');
const scheduler = require('../../scheduler');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');

function reportRevokeRecruitServiceError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'revoke-recruit',
    ...meta
  });
}

async function revokeRecruit({ interaction, db, guildId, member, reason }) {
  // Validate member exists
  const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
  if (!targetMember) {
    return replyError(interaction, 'Member not found in this guild.');
  }

  // Get the recruit record to find region and recruiter info
  const recruit = await recruitsRepo.getActiveByRecruitedId(db, guildId, member.id);
  if (!recruit) {
    return replyError(interaction, 'No valid recruit record found for this member.');
  }

  const recruitPoints = recruit.points || 0;

  // Mark recruit as invalid in database and adjust recruiter points
  await withTransaction(db, async (tx) => {
    await recruitsRepo.markInvalidById(tx, guildId, recruit.id);
    await changeRecruiterPoints(tx, {
      guildId,
      recruiterId: recruit.recruiter_id,
      delta: -recruitPoints,
      reason: 'recruit_revoked',
      refType: 'recruit',
      refId: String(recruit.id),
      minPoints: 0
    });
  });

  // Remove roles from the member
  try {
    const onboarding = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
    const roleIdsToRemove = Array.from(new Set([
      ROLE_IDS.ROOKIE,
      ROLE_IDS.UNVERIFIED,
      ...onboarding
    ].filter(Boolean)));
    const removableRoleIds = roleIdsToRemove.filter(roleId => targetMember.roles.cache.has(roleId));
    if (removableRoleIds.length) {
      await targetMember.roles.remove(removableRoleIds, 'Recruit revoked');
    }

    const botMember = interaction.guild && interaction.guild.members
      ? (interaction.guild.members.me
        || (typeof interaction.guild.members.fetch === 'function'
          ? await interaction.guild.members.fetch(interaction.client.user.id).catch(() => null)
          : null))
      : null;
    const canManageNicknames = !!(
      botMember
      && botMember.permissions
      && typeof botMember.permissions.has === 'function'
      && botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames)
    );
    if (targetMember.manageable && canManageNicknames) {
      await targetMember.setNickname(null).catch(err => {
        reportRevokeRecruitServiceError('service.revokeRecruit.clearNickname', err, {
          guildId,
          recruitedId: member.id
        });
      });
    }
  } catch (roleError) {
    reportRevokeRecruitServiceError('service.revokeRecruit.removeRoles', roleError, {
      guildId,
      recruitedId: member.id
    });
  }

  // Update leaderboards to reflect the change
  try {
    await scheduler.recomputeLeaderboards(db, interaction.guild);
    if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
      await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
    }
  } catch (e) {
    reportRevokeRecruitServiceError('service.revokeRecruit.recomputeLeaderboards', e, {
      guildId,
      recruitedId: member.id
    });
  }

  // Post notification to invite channels
  const embed = new EmbedBuilder()
    .setTitle('🚫 Recruit Revoked')
    .setDescription(`**${member.tag}** has been revoked as a recruit.`)
    .addFields(
      { name: 'Recruiter', value: `<@${recruit.recruiter_id}>`, inline: true },
      { name: 'Region', value: recruit.region, inline: true },
      { name: 'Reason', value: reason, inline: false },
      { name: 'Revoked By', value: `<@${interaction.user.id}>`, inline: true }
    )
    .setColor(0xFF4444)
    .setTimestamp();

  const logChannel = interaction.guild.channels.cache.get(CHANNELS.ECONOMY_NOTIFICATIONS);
  if (logChannel) {
    await logChannel.send({ embeds: [embed] }).catch(err => {
      reportRevokeRecruitServiceError('service.revokeRecruit.logChannel', err, {
        guildId,
        recruitedId: member.id,
        channelId: CHANNELS.ECONOMY_NOTIFICATIONS
      });
    });
  }

  void logRuntimeEvent('info', 'service.revokeRecruit.completed', 'Recruit revoked', {
    recruitedId: member.id,
    recruiterId: recruit.recruiter_id,
    region: recruit.region,
    by: interaction.user.id,
    reason,
    guildId
  });

  return null;
}

module.exports = { revokeRecruit };

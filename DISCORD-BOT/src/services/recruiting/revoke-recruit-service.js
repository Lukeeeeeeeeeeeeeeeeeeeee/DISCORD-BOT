const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { ROLE_IDS, CHANNELS } = require('../../constants');
const { replyError } = require('../../lib/embeds');
const recruitsRepo = require('../../repos/recruits-repo');
const { withTransaction } = require('../../lib/transactions');
const { changeRecruiterPoints } = require('./ledger-service');
const scheduler = require('../../scheduler');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');

function roleIsManageable(botMember, role) {
  if (!role || !botMember || !botMember.roles || !botMember.roles.highest) return false;
  return botMember.roles.highest.position > role.position;
}

function resolveBotMemberSync(guild, client) {
  if (!guild) return null;
  if (guild.members && guild.members.me) return guild.members.me;
  if (client && client.user && guild.members && guild.members.cache) {
    return guild.members.cache.get(client.user.id);
  }
  return null;
}

function reportRevokeRecruitServiceError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'revoke-recruit',
    ...meta
  });
}

async function revokeRecruit({ interaction, db, guildId, member, reason }) {
  // Validate member existence (Allow graceful cleanup if member has already left)
  const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
  const memberExists = !!targetMember;

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

  // Remove roles from the member (only if they are still in the guild)
  if (memberExists) {
    try {
      const onboarding = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
      const roleIdsToRemove = Array.from(new Set([
        ROLE_IDS.ROOKIE,
        ROLE_IDS.UNVERIFIED,
        ...onboarding
      ].filter(Boolean)));
      
      const botMember = resolveBotMemberSync(interaction.guild, interaction.client);
      const safeRemovableRoleIds = [];
      for (const rid of roleIdsToRemove) {
        if (targetMember.roles.cache.has(rid)) {
          const role = interaction.guild.roles.cache.get(rid);
          if (role && roleIsManageable(botMember, role)) {
            safeRemovableRoleIds.push(rid);
          } else if (role) {
            logRuntimeEvent('warn', 'service.revokeRecruit.hierarchy', 'Skipping role removal: Bot too low in hierarchy', { 
              recruitedId: member.id, roleName: role.name 
            });
          }
        }
      }

      if (safeRemovableRoleIds.length) {
        await targetMember.roles.remove(safeRemovableRoleIds, 'Recruit status revoked');
      }

      const canManageNicknames = !!(
        botMember &&
        botMember.permissions &&
        botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames)
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

  return { success: true, message: `Successfully revoked recruit status for ${member.tag}. ✅` };
}

module.exports = { revokeRecruit };

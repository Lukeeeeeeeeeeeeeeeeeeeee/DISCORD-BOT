const { SlashCommandBuilder, PermissionFlagsBits, EmbedBuilder, PermissionsBitField } = require('discord.js');
const db = require('../../db_async');
const { ROLE_IDS, CHANNELS } = require('../../constants');
const { ensureCommandAccess } = require('../../lib/command-auth');
const { resolveGuildId } = require('../../lib/guild');
const { replyError } = require('../../lib/embeds');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');
const { withTransaction } = require('../../lib/transactions');
const recruitsRepo = require('../../repos/recruits-repo');
const { changeRecruiterPoints } = require('../../services/recruiting/ledger-service');
const { calculate7DayStats, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement } = require('../../lib/recruiting-system');
const { getWeekStartUtcTs } = require('../../lib/week');
const scheduler = require('../../scheduler');

function reportRevokeRecruitError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'revoke-recruit',
    ...meta
  });
}

async function refreshCurrentWeekCalculation(guild, recruiterId) {
  try {
    const guildId = resolveGuildId(guild);
    const recruiterMember = await guild.members.fetch(recruiterId).catch(() => null);
    if (!recruiterMember) return;

    const weekStart = getWeekStartUtcTs();
    const stats = await calculate7DayStats(db, recruiterId, guild, { sinceTs: weekStart, untilTs: Date.now(), guildId });
    const warnings = (await db.get('SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0', guildId, recruiterId))?.c || 0;
    const roleBase = getBaseRequirement(recruiterMember);
    
    const calculatedMinReq = calculateMinRecruitsFixed({
      roleBase, member: recruiterMember, recruits7d: stats.recruits7d, activityRate: stats.activityRate,
      verifyRate: stats.verifyRate, retention: stats.retention, warnings, absent: false, isNewStaff: false
    });

    await storeWeeklyCalculation(db, {
      guildId, recruiterId, weekStart, ...stats, warnings, calculatedMinReq, roleBase
    });
  } catch (e) {
    void e;
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('revoke-recruit')
    .setDescription('Revoke a recruit and update invite channels')
    .addUserOption(option =>
      option.setName('member')
        .setDescription('The member to revoke')
        .setRequired(true))
    .addStringOption(option =>
      option.setName('reason')
        .setDescription('Reason for revocation')
        .setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles)
    .setDMPermission(false),

  async execute(interaction) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: true,
      deniedMessage: 'Admin/Staff only.'
    });
    if (!allowed) return null;

    const guildId = resolveGuildId(interaction.guild);
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ flags: 64 });
    }

    const member = interaction.options.getUser('member');
    const reason = interaction.options.getString('reason') || 'Recruit revoked by staff';

    try {
      const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
      if (!targetMember) {
        return replyError(interaction, 'Member not found in this guild.');
      }

      if (!targetMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
        return replyError(interaction, 'This member does not have the Rookie role.');
      }

      // Get the recruit record
      const recruit = await recruitsRepo.getActiveByRecruitedId(db, guildId, member.id);
      if (!recruit) {
        return replyError(interaction, 'No valid recruit record found for this member.');
      }

      const recruitPoints = recruit.points || 0;

      // HARDENED TRANSACTION
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

      // DISCORD UPDATES (with safety guards)
      try {
        const onboarding = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
        const roleIdsToRemove = Array.from(new Set([
          ROLE_IDS.ROOKIE,
          ROLE_IDS.UNVERIFIED,
          ...onboarding
        ].filter(Boolean)));
        
        const removableRoleIds = roleIdsToRemove.filter(rid => targetMember.roles.cache.has(rid));
        
        // VULN-11: Hierarchy Guard
        const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id);
        const manageableRoles = [];
        for (const rid of removableRoleIds) {
          let role = interaction.guild.roles.cache.get(rid);
          if (!role) {
            role = await interaction.guild.roles.fetch(rid).catch(() => null);
          }
          if (role) {
            if (botMember.roles.highest.position > role.position) {
              manageableRoles.push(rid);
            } else {
              void logRuntimeEvent('warn', 'command.revokeRecruit.hierarchySkip', 'Cannot remove role due to hierarchy', { role: role.name, recruitedId: member.id });
            }
          }
        }

        if (manageableRoles.length) {
          await targetMember.roles.remove(manageableRoles, 'Recruit revoked');
        }

        if (targetMember.manageable && botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames)) {
          await targetMember.setNickname(null).catch(() => null);
        }
      } catch (discordErr) {
        reportRevokeRecruitError('command.revokeRecruit.discordUpdate', discordErr, { recruitedId: member.id });
      }

      // BACKGROUND TASKS
      void scheduler.recomputeLeaderboards(db, interaction.guild).catch(() => null);
      if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
        void scheduler.recomputeWarningsLeaderboard(db, interaction.guild).catch(() => null);
      }
      
      try {
        await refreshCurrentWeekCalculation(interaction.guild, recruit.recruiter_id);
      } catch (bgErr) {
        void bgErr;
      }

      // NOTIFICATIONS
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
        await logChannel.send({ embeds: [embed] }).catch(() => null);
      }

      void logRuntimeEvent('info', 'command.revokeRecruit.completed', 'Recruit revoked', {
        recruitedId: member.id,
        recruiterId: recruit.recruiter_id,
        by: interaction.user.id,
        reason,
        guildId
      });

      return interaction.editReply({ content: `Successfully revoked recruit status for ${member.tag}. ✅` });

    } catch (err) {
      void logUnexpectedError('command.revokeRecruit.execute', err, { guildId, recruitedId: member.id });
      return replyError(interaction, 'Failed to revoke recruit. Please try again later.');
    }
  }
};

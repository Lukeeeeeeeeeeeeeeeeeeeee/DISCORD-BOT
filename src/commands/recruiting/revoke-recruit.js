const db = require('../../db_async');
const { EmbedBuilder } = require('discord.js');
const { hasAdminOrStaffPermissions } = require('../../lib/permissions');
const { resolveGuildId } = require('../../lib/guild');
const { replyError } = require('../../lib/embeds');

module.exports = {
  data: {
    name: 'revoke-recruit',
    description: 'Revoke a recruit and update invite channels',
  },
  async execute(interaction) {
    // Admin/staff only
    if (!hasAdminOrStaffPermissions(interaction.member)) {
      return replyError(interaction, 'Admin/Staff only.');
    }
    const guildId = resolveGuildId(interaction.guild);

    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: 64 });
    }
    const respond = (payload) => {
      if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
        return interaction.editReply(payload);
      }
      return interaction.reply(payload);
    };

    const member = interaction.options.getUser('member');
    const reason = interaction.options.getString('reason') || 'Recruit revoked by staff';

    // Validate member exists
    const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
    if (!targetMember) {
      return replyError(interaction, 'Member not found in this guild.');
    }

    try {
      // Get the recruit record to find region and recruiter info
      const recruit = await db.get('SELECT * FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 1', guildId, member.id);
      if (!recruit) {
        return replyError(interaction, 'No valid recruit record found for this member.');
      }

      const recruitPoints = recruit.points || 0;

      // Mark recruit as invalid in database and adjust recruiter points
      await db.run('BEGIN TRANSACTION');
      try {
        await db.run('UPDATE recruits SET valid = 0 WHERE guild_id = ? AND id = ?', guildId, recruit.id);
        await db.run(
          'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
          guildId,
          recruit.recruiter_id
        );
        const recRow = await db.get('SELECT points FROM recruiters WHERE guild_id = ? AND id = ?', guildId, recruit.recruiter_id);
        const currentPoints = recRow ? recRow.points || 0 : 0;
        const newPoints = Math.max(0, currentPoints - recruitPoints);
        await db.run('UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?', newPoints, guildId, recruit.recruiter_id);
        await db.run('COMMIT');
      } catch (err) {
        await db.run('ROLLBACK');
        throw err;
      }

      // Remove roles from the member
      const { ROLE_IDS } = require('../../constants');
      try {
        // Remove rookie role
        if (targetMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
          await targetMember.roles.remove(ROLE_IDS.ROOKIE);
        }

        // Remove onboarding roles
        for (const roleId of ROLE_IDS.ONBOARDING) {
          if (targetMember.roles.cache.has(roleId)) {
            await targetMember.roles.remove(roleId);
          }
        }

        // Remove unverified role if they have it
        if (targetMember.roles.cache.has(ROLE_IDS.UNVERIFIED)) {
          await targetMember.roles.remove(ROLE_IDS.UNVERIFIED);
        }

        // Reset nickname
        if (targetMember.manageable) {
          await targetMember.setNickname(null).catch(err => {
            console.error('Failed to clear recruit nickname:', err);
          });
        }
      } catch (roleError) {
        console.error('Failed to remove roles:', roleError);
      }

      // Update leaderboards to reflect the change
      try {
        const scheduler = require('../../scheduler');
        await scheduler.recomputeLeaderboards(db, interaction.guild);
      } catch (e) {
        console.error('Failed to update leaderboards after recruit revocation:', e);
      }

      // Post notification to invite channels
      // Post to economy notifications channel
      const { CHANNELS } = require('../../constants');
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
          console.error('Failed to log recruit revocation:', err);
        });
      }

      // DM the revoked member
      try {
        const dmEmbed = new EmbedBuilder()
          .setTitle('🚫 Your Recruit Status Has Been Revoked')
          .setDescription(`Your recruit status in **${recruit.region}** has been revoked.`)
          .addFields(
            { name: 'Reason', value: reason, inline: false },
            { name: 'Revoked By', value: `<@${interaction.user.id}>`, inline: true }
          )
          .setColor(0xFF4444)
          .setTimestamp();
        await targetMember.send({ embeds: [dmEmbed] }).catch(err => {
          console.error('Failed to DM recruit revocation:', err);
        });
      } catch (dmError) {
        console.error('Failed to DM revoked member:', dmError);
      }

      console.info('Recruit revoked', {
        guildId,
        recruitedId: member.id,
        recruiterId: recruit.recruiter_id,
        region: recruit.region,
        by: interaction.user.id,
        reason
      });

      return respond({ content: `Successfully revoked recruit status for ${member.tag}. ✅` });

    } catch (error) {
      console.error('Failed to revoke recruit:', error);
      return replyError(interaction, 'Failed to revoke recruit. Please try again later.');
    }
  }
};

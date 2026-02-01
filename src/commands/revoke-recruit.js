const db = require('../db_async');
const { EmbedBuilder } = require('discord.js');
const { hasAdminOrStaffPermissions } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'revoke-recruit',
    description: 'Revoke a recruit and update invite channels',
  },
  async execute(interaction) {
    // Admin/staff only
    if (!hasAdminOrStaffPermissions(interaction.member)) {
      return interaction.reply({ content: 'Admin/Staff only.' });
    }

    const member = interaction.options.getUser('member');
    const reason = interaction.options.getString('reason') || 'Recruit revoked by staff';

    // Validate member exists
    const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({ content: 'Member not found in this guild.' });
    }

    try {
      // Get the recruit record to find region and recruiter info
      const recruit = await db.get('SELECT * FROM recruits WHERE recruited_id = ? AND valid = 1', member.id);
      if (!recruit) {
        return interaction.reply({ content: 'No valid recruit record found for this member.' });
      }

      // Mark recruit as invalid in database
      await db.run('UPDATE recruits SET valid = 0 WHERE id = ?', recruit.id);

      // Remove roles from the member
      const { ROLE_IDS } = require('../constants');
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
        await targetMember.setNickname(null).catch(() => { });
      } catch (roleError) {
        console.error('Failed to remove roles:', roleError);
      }

      // Update leaderboards to reflect the change
      try {
        const scheduler = require('../scheduler');
        await scheduler.recomputeLeaderboards(db, interaction.guild);
      } catch (e) {
        console.error('Failed to update leaderboards after recruit revocation:', e);
      }

      // Post notification to invite channels
      // Post to economy notifications channel
      const { CHANNELS } = require('../constants');
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
        await logChannel.send({ embeds: [embed] }).catch(() => { });
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
        await targetMember.send({ embeds: [dmEmbed] }).catch(() => { });
      } catch (dmError) {
        console.error('Failed to DM revoked member:', dmError);
      }

      console.info('Recruit revoked', {
        recruitedId: member.id,
        recruiterId: recruit.recruiter_id,
        region: recruit.region,
        by: interaction.user.id,
        reason
      });

      return interaction.reply({ content: `Successfully revoked recruit status for ${member.tag}. ✅` });

    } catch (error) {
      console.error('Failed to revoke recruit:', error);
      return interaction.reply({ content: 'Failed to revoke recruit. Please try again later.' });
    }
  }
};

const { EmbedBuilder } = require('discord.js');
const InviteSystem = require('../../lib/invite-system');
const { hasAdministrator } = require('../../lib/permissions');
const analytics = require('../../lib/analytics');
const { replyError } = require('../../lib/embeds');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');

// Global invite system instance
let inviteSystem = null;
const INTERACTION_ACK_ERROR_CODES = new Set([10008, 10062, 40060]);

function isInteractionAckError(error) {
  return Boolean(error && INTERACTION_ACK_ERROR_CODES.has(Number(error.code)));
}

module.exports = {
  data: {
    name: 'invite',
    description: 'Create a time-limited invite link (Recruiters only)'
  },
  async execute(interaction) {
    try {
      if (!interaction.guild) {
        return replyError(interaction, 'This command can only be used in a server.', { flags: 64 });
      }

      // Acknowledge quickly to avoid Unknown interaction (10062) on slow paths.
      if (!interaction.deferred && !interaction.replied && typeof interaction.deferReply === 'function') {
        await interaction.deferReply({ flags: 64 });
      }

      // Initialize invite system if not already done
      if (!inviteSystem) {
        inviteSystem = new InviteSystem();
        await inviteSystem.init();
      }

      // Recruiters/trial/team recruiters only (admins always allowed)
      const isAdmin = hasAdministrator(interaction.member);
      const isRecruiter = interaction.guild
        ? await inviteSystem.isRecruiter(interaction.user.id, interaction.guild, interaction.member)
        : false;

      if (!isAdmin && !isRecruiter) {
        return replyError(interaction, 'This command is only available to recruiters (Trial/Team included).', { flags: 64 });
      }

      // Get current invite status
      const status = inviteSystem.getInviteStatus(interaction.user.id);

      if (status.hasActive) {
        // User has an active unused invite
        const embed = new EmbedBuilder()
          .setColor('#FFA500')
          .setTitle('🔗 Active Invite Found')
          .setDescription('You already have an active unused invite!')
          .addFields(
            { 
              name: '📧 Invite Code', 
              value: `**${status.code}**`, 
              inline: true 
            },
            { 
              name: '⏰ Expires In', 
              value: status.timeLeft, 
              inline: true 
            },
            { 
              name: '🔗 Invite Link', 
              value: `||${status.url}||`, 
              inline: false 
            }
          )
          .addFields({
            name: '⚠️ Important',
            value: 'You must use this invite or wait for it to expire before creating a new one.',
            inline: false
          })
          .setFooter({ text: 'Right-click the link above and select "Copy Link"' })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      if (status.onCooldown) {
        // User is on cooldown
        const embed = new EmbedBuilder()
          .setColor('#FF6B6B')
          .setTitle('⏱️ Invite Cooldown')
          .setDescription('You must wait before creating another invite.')
          .addFields(
            { 
              name: '⏰ Cooldown Remaining', 
              value: status.cooldownLeft, 
              inline: true 
            }
          )
          .addFields({
            name: 'ℹ️ Cooldown Info',
            value: 'After using an invite, you must wait 1 hour 30 minutes before creating another one.',
            inline: false
          })
          .setTimestamp();

        return interaction.editReply({ embeds: [embed] });
      }

      const result = await inviteSystem.createInvite(interaction.user.id, interaction.guild);

      if (result.success) {
        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Invite Created Successfully')
          .setDescription('Your time-limited invite has been created!')
          .addFields(
            { 
              name: '📧 Invite Code', 
              value: `**${result.invite.code}**`, 
              inline: true 
            },
            { 
              name: '⏰ Expires In', 
              value: result.invite.expiresIn, 
              inline: true 
            },
            { 
              name: '🔗 Invite Link', 
              value: `||${result.invite.url}||`, 
              inline: false 
            }
          )
          .addFields({
            name: '📋 Instructions',
            value: '1. Share this invite link with your recruit\n2. They have 1 hour 30 minutes to use it\n3. The invite can only be used once\n4. After use, wait 1h 30m for next invite',
            inline: false
          })
          .setFooter({ text: `Created by ${interaction.user.tag} • Right-click link and select "Copy Link"` })
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });

        if (!result.reused) {
          await analytics.recordInviteCreated({ guildId: interaction.guild.id, timestamp: Date.now() }).catch(err => {
            void logUnexpectedError('command.invite.analytics.recordInviteCreated', err, {
              command: 'invite',
              guildId: interaction.guild.id,
              userId: interaction.user.id
            });
          });
        }

        // Log the invite creation
        void logRuntimeEvent('info', 'command.invite.created', 'Invite created', {
          command: 'invite',
          guildId: interaction.guild.id,
          userId: interaction.user.id,
          inviteCode: result.invite.code,
          reused: Boolean(result.reused)
        });

      } else {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ Failed to Create Invite')
          .setDescription(result.message)
          .setTimestamp();

        await interaction.editReply({ embeds: [embed] });
      }

    } catch (error) {
      if (isInteractionAckError(error)) return;
      const dispatchResult = await logUnexpectedError('command.invite.execute', error, {
        command: 'invite',
        guildId: interaction.guild ? interaction.guild.id : null,
        userId: interaction.user ? interaction.user.id : null
      });
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Invite System Error')
        .setDescription(`An error occurred while processing your request. Please try again later.${dispatchResult && dispatchResult.supportId ? ` Support ID: \`${dispatchResult.supportId}\`.` : ''}`)
        .setTimestamp();

      try {
        if (interaction.replied || interaction.deferred) {
          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.reply({ embeds: [embed], flags: 64 });
        }
      } catch (responseError) {
        if (isInteractionAckError(responseError)) return;
        await logUnexpectedError('command.invite.errorResponse', responseError, {
          command: 'invite',
          guildId: interaction.guild ? interaction.guild.id : null,
          userId: interaction.user ? interaction.user.id : null
        });
      }
    }
  },

  // Method to initialize the invite system (called from main bot)
  async init() {
    if (!inviteSystem) {
      inviteSystem = new InviteSystem();
      await inviteSystem.init();
    }
    return inviteSystem;
  }
};

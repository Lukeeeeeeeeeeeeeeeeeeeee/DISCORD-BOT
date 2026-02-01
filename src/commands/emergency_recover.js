const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'emergency_recover',
    description: 'Recover from emergency lockdown (Admin only)',
    options: [
      {
        name: 'backup_id',
        description: 'Backup ID to restore (optional, defaults to latest)',
        type: 3,
        required: false
      },
      {
        name: 'force',
        description: 'Force recovery even if not in emergency mode (owner only)',
        type: 5,
        required: false
      }
    ]
  },
  async execute(interaction) {
    // Check admin permissions
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ 
        content: '❌ Administrator permission required.'
      });
    }

    const antiNuke = global.antiNuke;
    if (!antiNuke) {
      return interaction.reply({ 
        content: '❌ Anti-nuke system not initialized.'
      });
    }

    try {
      const backupId = interaction.options.getString('backup_id');
      const force = interaction.options.getBoolean('force') || false;
      if (force && !antiNuke.isOwner(interaction.user.id)) {
        return interaction.reply({ content: '❌ Force recovery is restricted to the bot owner.' });
      }

      // Check if server is in emergency mode
      const status = antiNuke.getStatus(interaction.guild.id);
      if (!status.isEmergency && !force) {
        const embed = new EmbedBuilder()
          .setColor('#FFFF00')
          .setTitle('⚠️ Not in Emergency Mode')
          .setDescription('This server is not currently in emergency mode.')
          .addFields(
            { name: 'Current Status', value: '🟢 Normal Operation', inline: true },
            { name: 'Backup Available', value: status.hasBackup ? '✅ Yes' : '❌ No', inline: true }
          )
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }

      // Check if backup exists
      if (!status.hasBackup) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ No Backup Available')
          .setDescription('Cannot recover: no backup found for this server.')
          .setTimestamp();
        return interaction.reply({ embeds: [embed] });
      }

      await interaction.deferReply();

      // Perform emergency recovery
      const result = await antiNuke.emergencyRecover(interaction.guild.id, backupId, {
        force,
        traceId: antiNuke.createTraceId(),
        executorId: interaction.user.id
      });
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Emergency Recovery Successful')
        .setDescription('Server has been recovered from emergency lockdown.')
        .addFields(
          { name: 'Roles Restored', value: result.rolesRestored.toString(), inline: true },
          { name: 'Channels Restored', value: result.channelsRestored.toString(), inline: true },
          { name: 'Recovered By', value: interaction.user.tag, inline: true },
          { name: 'Backup ID', value: backupId || status.backupId || 'Latest', inline: true }
        )
        .addFields(
          {
            name: '🔧 What Was Restored',
            value: '• All role permissions\n• Channel permission overwrites\n• Server settings\n• Emergency mode disabled',
            inline: false
          }
        )
        .setFooter({ text: 'Server is now back to normal operation' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Emergency recovery error:', error);
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Emergency Recovery Failed')
        .setDescription(`Failed to recover from emergency mode: ${error.message}`)
        .setTimestamp();

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.reply({ embeds: [embed] });
      }
    }
  }
};

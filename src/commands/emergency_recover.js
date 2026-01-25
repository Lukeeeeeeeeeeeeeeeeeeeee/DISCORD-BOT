const { EmbedBuilder } = require('discord.js');
const AntiNuke = require('../lib/antinuke');

module.exports = {
  data: {
    name: 'emergency_recover',
    description: 'Recover from emergency lockdown (Admin only)'
  },
  async execute(interaction) {
    // Check admin permissions
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ 
        content: '❌ Administrator permission required.', 
        flags: 64 
      });
    }

    const antiNuke = global.antiNuke;
    if (!antiNuke) {
      return interaction.reply({ 
        content: '❌ Anti-nuke system not initialized.', 
        flags: 64 
      });
    }

    try {
      // Check if server is in emergency mode
      const status = antiNuke.getStatus(interaction.guild.id);
      if (!status.isEmergency) {
        const embed = new EmbedBuilder()
          .setColor('#FFFF00')
          .setTitle('⚠️ Not in Emergency Mode')
          .setDescription('This server is not currently in emergency mode.')
          .addFields(
            { name: 'Current Status', value: '🟢 Normal Operation', inline: true },
            { name: 'Backup Available', value: status.hasBackup ? '✅ Yes' : '❌ No', inline: true }
          )
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // Check if backup exists
      if (!status.hasBackup) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('❌ No Backup Available')
          .setDescription('Cannot recover: no backup found for this server.')
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      // Perform emergency recovery
      const result = await antiNuke.emergencyRecover(interaction.guild.id);
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Emergency Recovery Successful')
        .setDescription('Server has been recovered from emergency lockdown.')
        .addFields(
          { name: 'Roles Restored', value: result.rolesRestored.toString(), inline: true },
          { name: 'Channels Restored', value: result.channelsRestored.toString(), inline: true },
          { name: 'Recovered By', value: interaction.user.tag, inline: true }
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
        await interaction.reply({ embeds: [embed], flags: 64 });
      }
    }
  }
};

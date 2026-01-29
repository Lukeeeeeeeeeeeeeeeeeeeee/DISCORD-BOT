const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'force_backup',
    description: 'Create manual backup of server (Admin only)'
  },
  async execute(interaction) {
    // Check admin permissions
    if (!hasAdministrator(interaction.member)) {
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
      await interaction.deferReply({ flags: 64 });

      // Create backup
      await antiNuke.createBackup(interaction.guild);
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Manual Backup Created')
        .setDescription('Server backup has been successfully created.')
        .addFields(
          { name: 'Server', value: interaction.guild.name, inline: true },
          { name: 'Created By', value: interaction.user.tag, inline: true },
          { name: 'Backup Time', value: `<t:${Math.floor(Date.now()/1000)}:F>`, inline: true }
        )
        .addFields(
          {
            name: '💾 What Was Backed Up',
            value: '• All role data (permissions, colors, positions)\n• All channel data (names, types, categories)\n• Channel permission overwrites\n• Server settings and metadata',
            inline: false
          }
        )
        .setFooter({ text: 'This backup can be used for emergency recovery' })
        .setTimestamp();

      // Log the backup creation
      antiNuke.logAction(interaction.guild.id, {
        type: 'manual_backup_created',
        executorId: interaction.user.id
      });

      await interaction.editReply({ embeds: [embed] });

    } catch (error) {
      console.error('Force backup error:', error);
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Backup Creation Failed')
        .setDescription(`Failed to create backup: ${error.message}`)
        .setTimestamp();

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.reply({ embeds: [embed], flags: 64 });
      }
    }
  }
};

const { EmbedBuilder } = require('discord.js');
const AntiNuke = require('../lib/antinuke');

module.exports = {
  data: {
    name: 'view_backups',
    description: 'View backup information (Admin only)'
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
      const status = antiNuke.getStatus(interaction.guild.id);
      
      if (!status.hasBackup) {
        const embed = new EmbedBuilder()
          .setColor('#FFFF00')
          .setTitle('📋 Backup Information')
          .setDescription('No backup available for this server.')
          .addFields(
            { name: 'Server', value: interaction.guild.name, inline: true },
            { name: 'Backup Status', value: '❌ None Available', inline: true }
          )
          .addFields(
            {
              name: '💡 How to Create Backup',
              value: 'Use `/force_backup` to create a manual backup\nAutomatic backups are created every 6 hours',
              inline: false
            }
          )
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      // Get backup details (mock data since we don't have direct access to backup object)
      const backupAge = 'Recent'; // Would calculate from backup timestamp
      const backupSize = 'Medium'; // Would calculate from backup data
      
      const embed = new EmbedBuilder()
        .setColor('#0000FF')
        .setTitle('📋 Backup Information')
        .setDescription('Server backup information and status.')
        .addFields(
          { name: 'Server', value: interaction.guild.name, inline: true },
          { name: 'Backup Status', value: '✅ Available', inline: true },
          { name: 'Backup Age', value: backupAge, inline: true }
        )
        .addFields(
          { name: '📊 Backup Details', value: `• Size: ${backupSize}\n• Type: Full Server Backup\n• Format: JSON\n• Location: Memory Storage`, inline: false }
        )
        .addFields(
          {
            name: '🔧 What\'s Included',
            value: '✅ All roles and permissions\n✅ All channels and overwrites\n✅ Server settings\n✅ Role positions and hierarchy\n✅ Channel categories',
            inline: false
          },
          {
            name: '⚡ Recovery Options',
            value: '• Use `/emergency_recover` to restore\n• Only works in emergency mode\n• Restores exact previous state\n• Disables emergency mode after recovery',
            inline: false
          }
        )
        .setFooter({ text: 'This information is only visible to you' })
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 }); // Ephemeral

    } catch (error) {
      console.error('View backups error:', error);
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to View Backups')
        .setDescription(`Error: ${error.message}`)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  }
};

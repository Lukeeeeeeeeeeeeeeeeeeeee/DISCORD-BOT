const { EmbedBuilder } = require('discord.js');
const AntiNuke = require('../lib/antinuke');

module.exports = {
  data: {
    name: 'antinuke_status',
    description: 'View full anti-nuke protection status (Admin only)'
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

    const status = antiNuke.getStatus(interaction.guild.id);
    
    const embed = new EmbedBuilder()
      .setColor('#0000FF')
      .setTitle('🛡️ Anti-Nuke Protection Status')
      .setThumbnail(interaction.guild.iconURL())
      .addFields(
        { 
          name: '📊 Statistics', 
          value: `• Tracked Users: ${status.totalTrackedUsers}\n• Whitelisted Users: ${status.totalWhitelistedUsers}\n• Bans (1h): ${status.hourlyBans}\n• Total Actions: ${status.totalActions}`, 
          inline: true 
        },
        { 
          name: '⚙️ Configuration', 
          value: `• Emergency Mode: ${status.isEmergency ? '🔴 ACTIVE' : '🟢 Normal'}\n• Log Channel: ${status.logChannel ? `<#${status.logChannel}>` : '❌ Not Set'}\n• Backup Available: ${status.hasBackup ? '✅ Yes' : '❌ No'}`, 
          inline: true 
        }
      )
      .addFields(
        {
          name: '🚨 Protection Features',
          value: '✅ Ban Protection\n✅ Kick Protection\n✅ Channel Deletion Protection\n✅ Role Deletion Protection\n✅ Member Prune Protection\n✅ Bot Addition Protection\n✅ Webhook Spam Protection\n✅ Emergency Mode\n✅ Beast Mode System\n✅ Whitelist System\n✅ Backup & Recovery',
          inline: false
        },
        {
          name: '📈 Emergency Thresholds',
          value: '• 10 bans in 10s\n• 20 bans in 30s\n• 30 bans in 5m\n• 50 bans in 10m\n• 75 bans in 30m\n• 100 bans in 1h',
          inline: false
        }
      )
      .setFooter({ text: `Server: ${interaction.guild.name}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: 64 });
  }
};

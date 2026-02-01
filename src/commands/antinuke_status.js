const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'antinuke_status',
    description: 'View full anti-nuke protection status (Admin only)'
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

    const status = antiNuke.getStatus(interaction.guild.id);
    const formatWindow = (ms) => {
      if (!ms && ms !== 0) return 'unknown';
      if (ms % 3600000 === 0) return `${ms / 3600000}h`;
      if (ms % 60000 === 0) return `${ms / 60000}m`;
      return `${Math.round(ms / 1000)}s`;
    };
    const emergencyThresholds = Array.isArray(antiNuke.THRESHOLDS?.emergency)
      ? antiNuke.THRESHOLDS.emergency
        .map((t) => `• ${t.count} bans in ${formatWindow(t.time)}`)
        .join('\n')
      : 'No emergency thresholds configured.';
    const embedColor = status.isEmergency ? 0x992D22 : 0x0000FF;
    const emergencyUntil = status.emergencyLockdownUntil
      ? `<t:${Math.floor(status.emergencyLockdownUntil / 1000)}:R>`
      : 'N/A';

    const embed = new EmbedBuilder()
      .setColor(embedColor)
      .setTitle('🛡️ Anti-Nuke Protection Status')
      .setThumbnail(interaction.guild.iconURL())
      .addFields(
        { 
          name: '📊 Statistics', 
          value: `• Tracked Users: ${status.totalTrackedUsers}\n• Whitelisted Users: ${status.totalWhitelistedUsers}\n• Pending Whitelist: ${status.pendingWhitelist}\n• Bans (1h): ${status.bansLastHour}\n• Bans (24h): ${status.bansLastDay}\n• Total Actions: ${status.totalActions}\n• Log History: ${status.logHistoryCount}`, 
          inline: true 
        },
        { 
          name: '⚙️ Configuration', 
          value: `• Emergency Mode: ${status.isEmergency ? '🔴 ACTIVE' : '🟢 Normal'}\n• Emergency Lockdown Until: ${emergencyUntil}\n• Log Channel: ${status.logChannel ? `<#${status.logChannel}>` : '❌ Not Set'}\n• Backup Available: ${status.hasBackup ? '✅ Yes' : '❌ No'}\n• Backup ID: ${status.backupId || 'N/A'}\n• Backup Encrypted: ${status.backupEncrypted ? '✅ Yes' : '❌ No'}\n• Beast Mode Window: 24h`, 
          inline: true 
        }
      )
      .addFields(
        {
          name: '🚨 Protection Features',
          value: '✅ Ban Protection\n✅ Kick Protection\n✅ Channel/Role Deletion Protection\n✅ Member Prune Protection\n✅ Bot Addition Protection\n✅ Webhook Spam Protection\n✅ Emergency Mode\n✅ Beast Mode (24h rolling)\n✅ Whitelist Approvals\n✅ Backup & Recovery',
          inline: false
        },
        {
          name: '🛡️ Strict/Quarantine',
          value: `• Strict Mode: ${status.strictMode ? 'ON' : 'OFF'}${status.strictActive && !status.strictMode ? ' (Auto)' : ''}\n• Aggressive Ban: ${status.aggressiveBan ? 'ON' : 'OFF'}\n• Quarantine Mode: ${status.quarantineMode}\n• Preserve View: ${status.quarantinePreserveView ? 'ON' : 'OFF'}\n• Quarantine Duration: ${Math.round((status.quarantineDuration || 0) / 3600000)}h\n• Auto Threshold: ${Math.round((status.autoActionThreshold || 0) * 100)}%`,
          inline: false
        },
        {
          name: '📈 Emergency Thresholds',
          value: emergencyThresholds,
          inline: false
        }
      )
      .setFooter({ text: `Server: ${interaction.guild.name}` })
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};

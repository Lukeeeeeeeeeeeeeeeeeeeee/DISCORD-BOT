const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');
const { buildErrorEmbed } = require('../lib/embeds');
const { createResponder } = require('../lib/respond');
const runtime = require('../lib/runtime');

module.exports = {
  data: {
    name: 'view_backups',
    description: 'View backup information (Admin only)'
  },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Administrator permission required.')], flags: 64 });
    }

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }

    const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
    await defer();

    try {
      const status = antiNuke.getStatus(interaction.guild.id);
      const backups = typeof antiNuke.listBackups === 'function'
        ? antiNuke.listBackups(interaction.guild.id)
        : [];

      if (!status.hasBackup) {
        const embed = new EmbedBuilder()
          .setColor('#FFFF00')
          .setTitle('Backup Information')
          .setDescription('No backup available for this server.')
          .addFields(
            { name: 'Server', value: interaction.guild.name, inline: true },
            { name: 'Backup Status', value: 'None available', inline: true }
          )
          .addFields(
            {
              name: 'How to Create Backup',
              value: 'Use `/force_backup` to create a manual backup\nAutomatic full backups run every 6 hours\nIncremental backups run every 1 hour',
              inline: false
            }
          )
          .setTimestamp();
        return respond({ embeds: [embed] });
      }

      const backupAge = status.backupTimestamp
        ? `<t:${Math.floor(status.backupTimestamp / 1000)}:R>`
        : 'Unknown';
      const backupSize = status.backupRoles || status.backupChannels
        ? `${status.backupRoles || 0} roles, ${status.backupChannels || 0} channels`
        : 'Unknown';
      const recentList = backups.slice(0, 5).map(entry => {
        const size = entry.counts
          ? `${entry.counts.roles || 0} roles, ${entry.counts.channels || 0} channels`
          : 'Unknown size';
        const age = entry.timestamp ? `<t:${Math.floor(entry.timestamp / 1000)}:R>` : 'Unknown';
        const encrypted = entry.encrypted ? 'encrypted' : 'plain';
        return `- ${entry.id} - ${entry.type || 'full'} (${encrypted}) - ${age} - ${size}`;
      });

      const embed = new EmbedBuilder()
        .setColor('#0000FF')
        .setTitle('Backup Information')
        .setDescription('Server backup information and status.')
        .addFields(
          { name: 'Server', value: interaction.guild.name, inline: true },
          { name: 'Backup Status', value: 'Available', inline: true },
          { name: 'Backup Age', value: backupAge, inline: true }
        )
        .addFields(
          { name: 'Backup Details', value: `- Size: ${backupSize}\n- Latest ID: ${status.backupId || 'Unknown'}\n- Type: ${backups[0]?.type || 'full'}\n- Encrypted: ${status.backupEncrypted ? 'Yes' : 'No'}\n- Format: JSON (persisted)`, inline: false }
        )
        .addFields(
          {
            name: "What's Included",
            value: 'All roles and permissions\nAll channels and overwrites\nServer settings\nRole positions and hierarchy\nChannel categories',
            inline: false
          },
          {
            name: 'Recovery Options',
            value: 'Use `/emergency_recover` to restore\nOnly works in emergency mode\nRestores exact previous state\nDisables emergency mode after recovery',
            inline: false
          }
        )
        .addFields(
          {
            name: 'Recent Backups',
            value: recentList.length ? recentList.join('\n') : 'No recent backups available.',
            inline: false
          },
          {
            name: 'Retention',
            value: `- Full: ${antiNuke.BACKUP_RETENTION_FULL} backups\n- Incremental: ${antiNuke.BACKUP_RETENTION_INCREMENTAL} backups`,
            inline: false
          }
        )
        .setTimestamp();

      return respond({ embeds: [embed] });
    } catch (error) {
      console.error('View backups error:', error);
      const embed = buildErrorEmbed(`Error: ${error.message}`, 'Failed to View Backups');
      return respond({ embeds: [embed] });
    }
  }
};

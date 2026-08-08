const { EmbedBuilder } = require('discord.js');
const { ensureCommandAccess } = require('../lib/command-auth');
const { buildErrorEmbed } = require('../lib/embeds');
const runtime = require('../lib/runtime');
const { logUnexpectedError } = require('../lib/logger');

module.exports = {
  data: {
    name: 'view_backups',
    description: 'View backup information (Admin only)'
  },
  async execute(interaction) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.',
      flags: 64
    });
    if (!allowed) return null;

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }

    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: 64 });
    }

    const respond = (payload) => {
      if (interaction.deferred || interaction.replied) {
        if (typeof interaction.editReply === 'function') return interaction.editReply(payload);
        if (typeof interaction.followUp === 'function') return interaction.followUp(payload);
      }
      return interaction.reply(payload);
    };

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
            { name: 'Backup Status', value: 'None Available', inline: true }
          )
          .addFields({
            name: 'How to Create Backup',
            value: 'Use `/force_backup` to create a manual backup.\nAutomatic full backups run every 6 hours.\nIncremental backups run every 1 hour.',
            inline: false
          })
          .setTimestamp();
        return respond({ embeds: [embed] });
      }

      const backupAge = status.backupTimestamp
        ? `<t:${Math.floor(status.backupTimestamp / 1000)}:R>`
        : 'Unknown';
      const backupSize = `${status.backupRoles || 0} roles, ${status.backupChannels || 0} channels, ${status.backupThreads || 0} threads, ${status.backupEmojis || 0} emojis, ${status.backupStickers || 0} stickers, ${status.backupBans || 0} bans`;

      const recentList = backups.slice(0, 5).map((entry) => {
        const counts = entry && entry.counts ? entry.counts : {};
        const size = `${counts.roles || 0}r/${counts.channels || 0}c/${counts.threads || 0}t/${counts.emojis || 0}e/${counts.stickers || 0}s/${counts.bans || 0}b`;
        const age = entry && entry.timestamp ? `<t:${Math.floor(entry.timestamp / 1000)}:R>` : 'Unknown';
        const encrypted = entry && entry.encrypted ? 'encrypted' : 'plain';
        return `- ${entry.id} (${entry.type || 'full'}, ${encrypted}) ${age} - ${size}`;
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
        .addFields({
          name: 'Backup Details',
          value: `- Size: ${backupSize}\n- Latest ID: ${status.backupId || 'Unknown'}\n- Type: ${backups[0] && backups[0].type ? backups[0].type : 'full'}\n- Encrypted: ${status.backupEncrypted ? 'Yes' : 'No'}\n- Format: JSON (persisted)`,
          inline: false
        })
        .addFields(
          {
            name: 'Included Data',
            value: [
              '- Roles and permissions',
              '- Channels, forums, active thread metadata',
              '- Server metadata and settings',
              '- Emojis and stickers',
              '- Ban list and onboarding configuration'
            ].join('\n'),
            inline: false
          },
          {
            name: 'Recovery Options',
            value: '- Use `/emergency_recover` (owner-only) for restore\n- Use `/emergency_recover source_guild_id:<id>` to clone from another server backup',
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
      const dispatchResult = await logUnexpectedError('command.viewBackups.execute', error, {
        command: 'view_backups',
        guildId: interaction.guild ? interaction.guild.id : null,
        actorId: interaction.user ? interaction.user.id : null
      });
      const embed = buildErrorEmbed(
        `Error: ${error.message}${dispatchResult && dispatchResult.supportId ? ` (Support ID: ${dispatchResult.supportId})` : ''}`,
        'Failed to View Backups'
      );
      return respond({ embeds: [embed] });
    }
  }
};

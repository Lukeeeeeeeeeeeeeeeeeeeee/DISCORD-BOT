const { EmbedBuilder } = require('discord.js');
const { ensureCommandAccess } = require('../lib/command-auth');
const { replyError } = require('../lib/embeds');
const runtime = require('../lib/runtime');
const { logUnexpectedError } = require('../lib/logger');

module.exports = {
  data: {
    name: 'force_backup',
    description: 'Create manual backup of server (Admin only)'
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
      return replyError(interaction, 'Anti-nuke system not initialized.', { flags: 64 });
    }

    try {
      await interaction.deferReply({ flags: 64 });

      const backup = await antiNuke.createBackup(interaction.guild, {
        type: 'full',
        manual: true,
        executorId: interaction.user.id
      });

      const snapshotCounts = backup && backup.counts
        ? `${backup.counts.roles || 0} roles, ${backup.counts.channels || 0} channels, ${backup.counts.threads || 0} threads, ${backup.counts.emojis || 0} emojis, ${backup.counts.stickers || 0} stickers, ${backup.counts.bans || 0} bans`
        : 'Unknown';

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Manual Backup Created')
        .setDescription('Server backup has been successfully created.')
        .addFields(
          { name: 'Server', value: interaction.guild.name, inline: true },
          { name: 'Created By', value: interaction.user.tag, inline: true },
          { name: 'Backup Time', value: `<t:${Math.floor(Date.now() / 1000)}:F>`, inline: true },
          { name: 'Backup ID', value: backup ? backup.id : 'Unknown', inline: true },
          { name: 'Snapshot Counts', value: snapshotCounts, inline: false }
        )
        .addFields({
          name: 'What Was Backed Up',
          value: [
            '- Server metadata (name/settings/icon/banner)',
            '- Roles/channels/permission overwrites',
            '- Active threads and forum metadata',
            '- Emojis and stickers',
            '- Ban list and onboarding config'
          ].join('\n'),
          inline: false
        })
        .setFooter({ text: 'This backup can be used for emergency recovery' })
        .setTimestamp();

      antiNuke.logAction(interaction.guild.id, {
        type: 'manual_backup_created',
        executorId: interaction.user.id
      });

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      const dispatchResult = await logUnexpectedError('command.forceBackup.execute', error, {
        command: 'force_backup',
        guildId: interaction.guild ? interaction.guild.id : null,
        actorId: interaction.user ? interaction.user.id : null
      });

      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('Backup Creation Failed')
        .setDescription(`Failed to create backup: ${error.message}${dispatchResult && dispatchResult.supportId ? ` (Support ID: ${dispatchResult.supportId})` : ''}`)
        .setTimestamp();

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.reply({ embeds: [embed], flags: 64 });
      }
    }
  }
};

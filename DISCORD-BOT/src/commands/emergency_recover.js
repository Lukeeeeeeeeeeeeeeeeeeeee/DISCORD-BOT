const { EmbedBuilder } = require('discord.js');
const runtime = require('../lib/runtime');
const { replyError } = require('../lib/embeds');
const { logUnexpectedError } = require('../lib/logger');

module.exports = {
  data: {
    name: 'emergency_recover',
    description: 'Recover or clone server from backup (Owner only)',
    options: [
      {
        name: 'backup_id',
        description: 'Backup ID to restore (optional, defaults to latest)',
        type: 3,
        required: false
      },
      {
        name: 'source_guild_id',
        description: 'Optional source guild ID for cross-server restore (owner only)',
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
    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ content: 'Anti-nuke system not initialized.', flags: 64 });
    }

    try {
      const backupId = interaction.options.getString('backup_id');
      const sourceGuildIdRaw = interaction.options.getString('source_guild_id');
      const sourceGuildId = sourceGuildIdRaw ? String(sourceGuildIdRaw).trim() : null;
      const force = interaction.options.getBoolean('force') || false;
      const isOwner = antiNuke.isOwner && antiNuke.isOwner(interaction.user.id);

      if (!isOwner) {
        return replyError(interaction, 'This dangerous anti-nuke command is restricted to the bot owner.', { flags: 64 });
      }

      const status = antiNuke.getStatus(interaction.guild.id);
      const sourceStatus = sourceGuildId ? antiNuke.getStatus(sourceGuildId) : status;

      if (!sourceGuildId && !status.isEmergency && !force) {
        const embed = new EmbedBuilder()
          .setColor('#FFFF00')
          .setTitle('Not in Emergency Mode')
          .setDescription('This server is not currently in emergency mode.')
          .addFields(
            { name: 'Current Status', value: 'Normal operation', inline: true },
            { name: 'Backup Available', value: status.hasBackup ? 'Yes' : 'No', inline: true }
          )
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      if (!sourceStatus.hasBackup) {
        const embed = new EmbedBuilder()
          .setColor('#FF0000')
          .setTitle('No Backup Available')
          .setDescription(sourceGuildId
            ? `Cannot recover: no backup found for source guild ${sourceGuildId}.`
            : 'Cannot recover: no backup found for this server.')
          .setTimestamp();
        return interaction.reply({ embeds: [embed], flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });

      const result = await antiNuke.emergencyRecover(interaction.guild.id, backupId, {
        force,
        sourceGuildId,
        traceId: antiNuke.createTraceId(),
        executorId: interaction.user.id,
        recreateMissingChannels: true,
        recreateMissingRoles: true,
        restoreAssets: true,
        restoreBans: true,
        restoreOnboarding: true,
        restoreThreads: true,
        restoreGuildMeta: true,
        restoreGuildAssets: true
      });

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Emergency Recovery Successful')
        .setDescription(result.isCrossGuildRecover
          ? 'Server clone-style recovery completed from source backup.'
          : 'Server has been recovered from emergency lockdown.')
        .addFields(
          { name: 'Roles Restored', value: String(result.rolesRestored || 0), inline: true },
          { name: 'Roles Created', value: String(result.rolesCreated || 0), inline: true },
          { name: 'Channels Restored', value: String(result.channelsRestored || 0), inline: true },
          { name: 'Channels Recreated', value: String(result.channelsCreated || 0), inline: true },
          { name: 'Threads Recreated', value: String(result.threadsCreated || 0), inline: true },
          { name: 'Emojis Restored', value: String(result.emojisRestored || 0), inline: true },
          { name: 'Stickers Restored', value: String(result.stickersRestored || 0), inline: true },
          { name: 'Bans Restored', value: String(result.bansRestored || 0), inline: true },
          { name: 'Onboarding Restored', value: result.onboardingRestored ? 'Yes' : 'No', inline: true },
          { name: 'Guild Metadata Restored', value: result.guildMetaRestored ? 'Yes' : 'No', inline: true },
          { name: 'Recovered By', value: interaction.user.tag, inline: true },
          { name: 'Backup ID', value: backupId || sourceStatus.backupId || 'Latest', inline: true }
        )
        .addFields({
          name: 'Restore Source',
          value: result.sourceGuildId ? `Source guild: ${result.sourceGuildId}` : `Source guild: ${interaction.guild.id}`,
          inline: false
        })
        .setFooter({ text: 'Recovery finished. Review logs for any skipped items.' })
        .setTimestamp();

      await interaction.editReply({ embeds: [embed] });
    } catch (error) {
      const dispatchResult = await logUnexpectedError('command.emergencyRecover.execute', error, {
        command: 'emergency_recover',
        guildId: interaction.guild ? interaction.guild.id : null,
        actorId: interaction.user ? interaction.user.id : null
      });

      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('Emergency Recovery Failed')
        .setDescription(`Failed to recover: ${error.message}${dispatchResult && dispatchResult.supportId ? ` (Support ID: ${dispatchResult.supportId})` : ''}`)
        .setTimestamp();

      if (interaction.replied || interaction.deferred) {
        await interaction.editReply({ embeds: [embed] });
      } else {
        await interaction.reply({ embeds: [embed], flags: 64 });
      }
    }
  }
};

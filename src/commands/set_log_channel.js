const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { ensureCommandAccess } = require('../lib/command-auth');
const { buildErrorEmbed } = require('../lib/embeds');
const runtime = require('../lib/runtime');
const { logUnexpectedError, logRuntimeEvent } = require('../lib/logger');
const { AECS, provisionTelemetryWebhooks } = require('../lib/aecs');

function getTargetSelection(interaction) {
  const value = interaction && interaction.options && typeof interaction.options.getString === 'function'
    ? interaction.options.getString('target')
    : null;
  if (value === 'antinuke' || value === 'aecs' || value === 'both') return value;
  return 'both';
}

module.exports = {
  data: {
    name: 'set_log_channel',
    description: 'Configure anti-nuke and/or AECS log channel (Admin only)',
    options: [
      {
        name: 'channel',
        description: 'Channel to use for logs',
        type: 7, // CHANNEL
        required: true
      },
      {
        name: 'target',
        description: 'Which system this channel should be applied to',
        type: 3, // STRING
        required: false,
        choices: [
          { name: 'Both', value: 'both' },
          { name: 'Anti-nuke only', value: 'antinuke' },
          { name: 'AECS only', value: 'aecs' }
        ]
      }
    ]
  },
  async execute(interaction) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.',
      flags: 64
    });
    if (!allowed) return null;

    const channel = interaction.options.getChannel('channel');
    const target = getTargetSelection(interaction);
    const applyAntiNuke = target === 'both' || target === 'antinuke';
    const applyAecs = target === 'both' || target === 'aecs';

    const antiNuke = runtime.getAntiNuke();
    if (applyAntiNuke && !antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }

    // Verify it's a text channel
    if (!channel || channel.type !== 0) { // GUILD_TEXT
      return interaction.reply({ embeds: [buildErrorEmbed('Log channel must be a text channel.')], flags: 64 });
    }

    const me = interaction.guild && interaction.guild.members
      ? (interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null))
      : null;
    const perms = me ? channel.permissionsFor(me) : null;
    const missingPerms = [];
    if (!perms || !perms.has(PermissionsBitField.Flags.ViewChannel)) missingPerms.push('ViewChannel');
    if (!perms || !perms.has(PermissionsBitField.Flags.SendMessages)) missingPerms.push('SendMessages');
    if (!perms || !perms.has(PermissionsBitField.Flags.EmbedLinks)) missingPerms.push('EmbedLinks');
    if (missingPerms.length) {
      return interaction.reply({
        embeds: [buildErrorEmbed(`I cannot log there. Missing bot permissions in that channel: ${missingPerms.join(', ')}.`)],
        flags: 64
      });
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
      let antiNukeStatus = applyAntiNuke ? 'updated' : 'skipped';
      if (applyAntiNuke) {
        antiNuke.setLogChannel(interaction.guild.id, channel.id);
      }

      let telemetryStatus = applyAecs ? 'unchanged' : 'skipped';
      if (applyAecs) {
        try {
          process.env.AECS_TELEMETRY_CHANNEL_ID = String(channel.id);
          const telemetryProvision = await provisionTelemetryWebhooks(interaction.client);
          if (telemetryProvision && telemetryProvision.config) {
            AECS.setTelemetryRouting(telemetryProvision.config);
            telemetryStatus = telemetryProvision.skipped
              ? `skipped (${telemetryProvision.reason || 'unknown'})`
              : (telemetryProvision.changed ? 'updated' : 'verified');
          } else {
            AECS.setTelemetryRouting({ telemetryChannelId: String(channel.id) });
            telemetryStatus = 'updated (channel only)';
          }
          void logRuntimeEvent('info', 'command.set_log_channel.aecs', 'AECS telemetry channel refreshed', {
            details: {
              guildId: interaction.guild.id,
              channelId: channel.id,
              target,
              status: telemetryStatus
            }
          });
        } catch (telemetryError) {
          telemetryStatus = 'failed';
          void logUnexpectedError('command.setLogChannel.aecsTelemetry', telemetryError, {
            command: 'set_log_channel',
            guildId: interaction.guild ? interaction.guild.id : null,
            actorId: interaction.user ? interaction.user.id : null,
            channelId: channel ? channel.id : null,
            target
          });
        }
      }

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('Log Channel Configured')
        .setDescription(`Updated log routing for **${target}** to ${channel}.`)
        .addFields(
          { name: 'Target', value: target, inline: true },
          { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
          { name: 'Server', value: interaction.guild.name, inline: true },
          { name: 'Configured By', value: interaction.user.tag, inline: true }
        )
        .addFields(
          { name: 'Anti-nuke', value: antiNukeStatus, inline: true },
          { name: 'AECS Telemetry', value: telemetryStatus, inline: true }
        )
        .setTimestamp();

      if (applyAntiNuke) {
        antiNuke.logAction(interaction.guild.id, {
          type: 'log_channel_configured',
          executorId: interaction.user.id,
          channelId: channel.id,
          channelName: channel.name,
          target
        });
      }

      return respond({ embeds: [embed] });
    } catch (error) {
      const dispatchResult = await logUnexpectedError('command.setLogChannel.execute', error, {
        command: 'set_log_channel',
        guildId: interaction.guild ? interaction.guild.id : null,
        actorId: interaction.user ? interaction.user.id : null,
        channelId: channel ? channel.id : null,
        target
      });

      const embed = buildErrorEmbed(
        `Error: ${error.message}${dispatchResult && dispatchResult.supportId ? ` (Support ID: ${dispatchResult.supportId})` : ''}`,
        'Failed to Set Log Channel'
      );
      return respond({ embeds: [embed] });
    }
  }
};

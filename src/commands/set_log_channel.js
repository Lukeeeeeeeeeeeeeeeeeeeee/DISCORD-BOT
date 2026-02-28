const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const { ensureCommandAccess } = require('../lib/command-auth');
const { buildErrorEmbed } = require('../lib/embeds');
const runtime = require('../lib/runtime');
const { logUnexpectedError } = require('../lib/logger');

module.exports = {
  data: {
    name: 'set_log_channel',
    description: 'Configure anti-nuke log channel (Admin only)',
    options: [
      {
        name: 'channel',
        description: 'Channel to set as log channel',
        type: 7, // CHANNEL
        required: true
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

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }

    const channel = interaction.options.getChannel('channel');
    
    // Verify it's a text channel
    if (channel.type !== 0) { // GUILD_TEXT
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
      // Set the log channel
      antiNuke.setLogChannel(interaction.guild.id, channel.id);
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Log Channel Configured')
        .setDescription(`Anti-nuke logs will now be sent to ${channel}`)
        .addFields(
          { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
          { name: 'Server', value: interaction.guild.name, inline: true },
          { name: 'Configured By', value: interaction.user.tag, inline: true }
        )
        .addFields(
          {
            name: '📝 What Gets Logged',
            value: '• All bans and kicks\n• Channel/role deletions\n• Beast mode warnings\n• Emergency mode activation\n• Whitelist changes\n• Backup creation/recovery',
            inline: false
          }
        )
        .setTimestamp();

      // Log the configuration change
      antiNuke.logAction(interaction.guild.id, {
        type: 'log_channel_configured',
        executorId: interaction.user.id,
        channelId: channel.id,
        channelName: channel.name
      });

      return respond({ embeds: [embed] });

    } catch (error) {
      const dispatchResult = await logUnexpectedError('command.setLogChannel.execute', error, {
        command: 'set_log_channel',
        guildId: interaction.guild ? interaction.guild.id : null,
        actorId: interaction.user ? interaction.user.id : null,
        channelId: channel ? channel.id : null
      });

      const embed = buildErrorEmbed(
        `Error: ${error.message}${dispatchResult && dispatchResult.supportId ? ` (Support ID: ${dispatchResult.supportId})` : ''}`,
        'Failed to Set Log Channel'
      );
      return respond({ embeds: [embed] });
    }
  }
};

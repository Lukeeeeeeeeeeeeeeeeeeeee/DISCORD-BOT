const { EmbedBuilder } = require('discord.js');
const { buildErrorEmbed } = require('../lib/embeds');
const runtime = require('../lib/runtime');

module.exports = {
  data: {
    name: 'toggle_strict_mode',
    description: 'Enable or disable anti-nuke strict mode (Owner only)',
    options: [
      {
        name: 'enabled',
        description: 'Enable strict mode',
        type: 5,
        required: true
      },
      {
        name: 'duration_minutes',
        description: 'Optional auto-disable duration in minutes',
        type: 4,
        required: false
      }
    ]
  },
  async execute(interaction) {
    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }
    if (!antiNuke.isOwner || !antiNuke.isOwner(interaction.user.id)) {
      return interaction.reply({
        embeds: [buildErrorEmbed('This dangerous anti-nuke command is restricted to the bot owner.')],
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

    const enabled = interaction.options.getBoolean('enabled');
    const durationMinutes = interaction.options.getInteger('duration_minutes');
    const durationMs = enabled && durationMinutes ? durationMinutes * 60 * 1000 : null;

    const config = antiNuke.setStrictMode(interaction.guild.id, enabled, durationMs);

    antiNuke.logAction(interaction.guild.id, {
      type: enabled ? 'strict_mode_enabled' : 'strict_mode_disabled',
      executorId: interaction.user.id,
      durationMinutes: durationMinutes || null
    });

    const autoUntil = config.autoStrictUntil && config.autoStrictUntil > Date.now()
      ? `<t:${Math.floor(config.autoStrictUntil / 1000)}:R>`
      : 'N/A';

    const embed = new EmbedBuilder()
      .setColor(enabled ? '#FF0000' : '#00FF00')
      .setTitle(enabled ? '🛑 Strict Mode Enabled' : '✅ Strict Mode Disabled')
      .setDescription(enabled ? 'Strict mode is now active for this server.' : 'Strict mode has been turned off.')
      .addFields(
        { name: 'Enabled', value: enabled ? 'Yes' : 'No', inline: true },
        { name: 'Auto Disable', value: autoUntil, inline: true },
        { name: 'Aggressive Ban', value: config.aggressiveBan ? 'ON' : 'OFF', inline: true }
      )
      .setTimestamp();

    return respond({ embeds: [embed] });
  }
};

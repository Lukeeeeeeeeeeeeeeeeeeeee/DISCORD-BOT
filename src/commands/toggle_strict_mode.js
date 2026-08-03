const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');
const { buildErrorEmbed } = require('../lib/embeds');
const { createResponder } = require('../lib/respond');
const runtime = require('../lib/runtime');

module.exports = {
  data: {
    name: 'toggle_strict_mode',
    description: 'Enable or disable anti-nuke strict mode (Admin only)',
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
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Administrator permission required.')], flags: 64 });
    }

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }

    const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
    await defer();

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
      .setTitle(enabled ? 'Strict Mode Enabled' : 'Strict Mode Disabled')
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

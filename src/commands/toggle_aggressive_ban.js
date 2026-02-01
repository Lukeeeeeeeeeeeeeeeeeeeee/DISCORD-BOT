const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'toggle_aggressive_ban',
    description: 'Enable or disable aggressive anti-nuke bans (Admin only)',
    options: [
      {
        name: 'enabled',
        description: 'Enable aggressive bans (lower confidence threshold)',
        type: 5,
        required: true
      }
    ]
  },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ content: '❌ Administrator permission required.' });
    }

    const antiNuke = global.antiNuke;
    if (!antiNuke) {
      return interaction.reply({ content: '❌ Anti-nuke system not initialized.' });
    }

    const enabled = interaction.options.getBoolean('enabled');
    const config = antiNuke.setAggressiveBan(interaction.guild.id, enabled);

    antiNuke.logAction(interaction.guild.id, {
      type: enabled ? 'aggressive_ban_enabled' : 'aggressive_ban_disabled',
      executorId: interaction.user.id
    });

    const embed = new EmbedBuilder()
      .setColor(enabled ? '#FF0000' : '#00FF00')
      .setTitle(enabled ? '⚡ Aggressive Ban Enabled' : '✅ Aggressive Ban Disabled')
      .setDescription(enabled ? 'Aggressive bans are now active for this server.' : 'Aggressive bans have been turned off.')
      .addFields(
        { name: 'Enabled', value: enabled ? 'Yes' : 'No', inline: true },
        { name: 'Auto Threshold', value: `${Math.round((config.autoActionThreshold || 0) * 100)}%`, inline: true },
        { name: 'Strict Mode', value: config.strictActive ? 'ON' : 'OFF', inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};

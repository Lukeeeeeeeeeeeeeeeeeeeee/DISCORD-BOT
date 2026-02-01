const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'set_quarantine_options',
    description: 'Configure anti-nuke quarantine options (Admin only)',
    options: [
      {
        name: 'mode',
        description: 'Quarantine mode (quarantine, quarantine_ban, ban)',
        type: 3,
        required: true,
        choices: [
          { name: 'quarantine', value: 'quarantine' },
          { name: 'quarantine_ban', value: 'quarantine_ban' },
          { name: 'ban', value: 'ban' }
        ]
      },
      {
        name: 'preserve_view',
        description: 'Preserve view/read permissions during quarantine',
        type: 5,
        required: false
      },
      {
        name: 'duration_hours',
        description: 'Quarantine duration in hours',
        type: 4,
        required: false
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

    const mode = interaction.options.getString('mode');
    const preserveView = interaction.options.getBoolean('preserve_view');
    const durationHours = interaction.options.getInteger('duration_hours');

    const updates = { mode };
    if (typeof preserveView === 'boolean') updates.preserveView = preserveView;
    if (durationHours && durationHours > 0) updates.durationMs = durationHours * 60 * 60 * 1000;

    const config = antiNuke.setQuarantineOptions(interaction.guild.id, updates);

    antiNuke.logAction(interaction.guild.id, {
      type: 'quarantine_options_updated',
      executorId: interaction.user.id,
      mode: config.quarantine?.mode,
      preserveView: config.quarantine?.preserveView,
      durationMs: config.quarantine?.durationMs
    });

    const embed = new EmbedBuilder()
      .setColor('#00AAFF')
      .setTitle('🛡️ Quarantine Options Updated')
      .setDescription('Updated quarantine behavior for this server.')
      .addFields(
        { name: 'Mode', value: config.quarantine?.mode || 'quarantine', inline: true },
        { name: 'Preserve View', value: config.quarantine?.preserveView ? 'ON' : 'OFF', inline: true },
        { name: 'Duration', value: `${Math.round((config.quarantine?.durationMs || 0) / 3600000)}h`, inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};

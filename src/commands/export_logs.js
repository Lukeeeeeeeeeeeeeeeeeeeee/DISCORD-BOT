const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'export_logs',
    description: 'Export recent anti-nuke logs (Admin only)',
    options: [
      {
        name: 'limit',
        description: 'Number of log entries to export (max 200)',
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

    const limit = Math.min(200, Math.max(1, interaction.options.getInteger('limit') || 200));
    const logs = antiNuke.exportLogHistory(interaction.guild.id, limit);
    const payload = {
      guildId: interaction.guild.id,
      exportedAt: new Date().toISOString(),
      count: logs.length,
      logs
    };

    const buffer = Buffer.from(JSON.stringify(payload, null, 2), 'utf8');
    const attachment = new AttachmentBuilder(buffer, { name: `antinuke_logs_${interaction.guild.id}.json` });

    antiNuke.logAction(interaction.guild.id, {
      type: 'export_logs',
      executorId: interaction.user.id,
      count: logs.length
    });

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('📤 Anti-Nuke Logs Exported')
      .setDescription(`Exported ${logs.length} log entries.`)
      .addFields(
        { name: 'Guild', value: interaction.guild.name, inline: true },
        { name: 'Requested By', value: interaction.user.tag, inline: true }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], files: [attachment] });
  }
};

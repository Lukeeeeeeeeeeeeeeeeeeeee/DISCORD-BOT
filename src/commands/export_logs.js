const { AttachmentBuilder, EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');
const runtime = require('../lib/runtime');
const { formatUtcDate } = require('../lib/time');
const { replyError } = require('../lib/embeds');

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
      },
      {
        name: 'format',
        description: 'Export format (json, csv, txt)',
        type: 3,
        required: false,
        choices: [
          { name: 'json', value: 'json' },
          { name: 'csv', value: 'csv' },
          { name: 'txt', value: 'txt' }
        ]
      },
      {
        name: 'chunk_size',
        description: 'Split export into chunks (1-200)',
        type: 4,
        required: false
      }
    ]
  },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return replyError(interaction, 'Administrator permission required.', { flags: 64 });
    }

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return replyError(interaction, 'Anti-nuke system not initialized.', { flags: 64 });
    }

    await interaction.deferReply({ flags: 64 });

    const limit = Math.min(200, Math.max(1, interaction.options.getInteger('limit') || 200));
    const format = (interaction.options.getString('format') || 'json').toLowerCase();
    const chunkSize = Math.min(200, Math.max(1, interaction.options.getInteger('chunk_size') || limit));

    const logs = antiNuke.exportLogHistory(interaction.guild.id, limit);
    const exportedAt = formatUtcDate();

    const chunks = [];
    for (let i = 0; i < logs.length; i += chunkSize) {
      chunks.push(logs.slice(i, i + chunkSize));
    }

    const toCsv = (rows) => {
      const cols = ['timestamp', 'type', 'userId', 'executorId', 'actionTaken', 'result', 'reason', 'error', 'traceId'];
      const escape = (value) => {
        const raw = value == null ? '' : String(value);
        if (raw.includes('"') || raw.includes(',') || raw.includes('\n')) {
          return `"${raw.replace(/"/g, '""')}"`;
        }
        return raw;
      };
      const header = cols.join(',');
      const lines = rows.map(row => cols.map(col => escape(row[col])).join(','));
      return [header, ...lines].join('\n');
    };

    const toTxt = (rows) => rows.map(row => {
      const ts = row.timestamp ? formatUtcDate(row.timestamp) : 'unknown';
      const type = row.type || 'unknown';
      const who = row.userId || row.executorId || 'unknown';
      const result = row.result || '';
      return `[${ts}] ${type} user=${who} result=${result}`.trim();
    }).join('\n');

    const attachments = chunks.map((chunk, idx) => {
      let data;
      let name;
      if (format === 'csv') {
        data = toCsv(chunk);
        name = `antinuke_logs_${interaction.guild.id}_${idx + 1}.csv`;
      } else if (format === 'txt') {
        data = toTxt(chunk);
        name = `antinuke_logs_${interaction.guild.id}_${idx + 1}.txt`;
      } else {
        const payload = {
          guildId: interaction.guild.id,
          exportedAt,
          count: chunk.length,
          logs: chunk
        };
        data = JSON.stringify(payload, null, 2);
        name = `antinuke_logs_${interaction.guild.id}_${idx + 1}.json`;
      }
      return new AttachmentBuilder(Buffer.from(data, 'utf8'), { name });
    });

    antiNuke.logAction(interaction.guild.id, {
      type: 'export_logs',
      executorId: interaction.user.id,
      count: logs.length
    });

    const embed = new EmbedBuilder()
      .setColor('#00FF00')
      .setTitle('📤 Anti-Nuke Logs Exported')
      .setDescription(`Exported ${logs.length} log entries as ${format.toUpperCase()} (${attachments.length} file${attachments.length === 1 ? '' : 's'}).`)
      .addFields(
        { name: 'Guild', value: interaction.guild.name, inline: true },
        { name: 'Requested By', value: interaction.user.tag, inline: true }
      )
      .setTimestamp();

    return interaction.editReply({ embeds: [embed], files: attachments });
  }
};

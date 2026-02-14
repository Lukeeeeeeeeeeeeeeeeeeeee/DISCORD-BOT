const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../../lib/permissions');
const { buildErrorEmbed } = require('../../lib/embeds');
const { resolveGuildId } = require('../../lib/guild');
const { createResponder } = require('../../lib/respond');
const { getStatusData } = require('../../services/recruiting/status-service');
const defaultDb = require('../../db_async');

module.exports = {
  data: { name: 'status' },
  async execute(interaction, _client, db) {
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Administrator permission required.')], flags: 64 });
    }

    const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
    await defer();

    const dbHandle = db || defaultDb;
    const guildId = resolveGuildId(interaction.guild || interaction);
    const data = await getStatusData({ db: dbHandle, guildId });

    const embed = new EmbedBuilder()
      .setTitle('Bot Status')
      .addFields(
        { name: 'DB Size', value: data.dbSize, inline: true },
        { name: 'Uptime', value: data.uptime, inline: true },
        { name: 'Last Backup', value: data.lastBackup, inline: true },
        { name: 'Recruits', value: `${data.recruits}`, inline: true },
        { name: 'Recruiters', value: `${data.recruiters}`, inline: true }
      )
      .setTimestamp();

    return respond({ embeds: [embed] });
  }
};


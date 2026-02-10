const fs = require('fs/promises');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../../lib/permissions');
const { buildErrorEmbed } = require('../../lib/embeds');

module.exports = {
  data: { name: 'status' },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Administrator permission required.')], flags: 64 });
    }

    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: 64 });
    }

    const { DB_PATH } = require('../../db_async');
    let dbSize = 'N/A';
    try {
      const s = await fs.stat(DB_PATH);
      dbSize = `${Math.round(s.size / 1024)} KB`;
    } catch (e) { void e; }

    const backupsDir = path.join(path.dirname(DB_PATH), 'backups');
    let lastBackup = 'None';
    try {
      const dbExt = path.extname(DB_PATH) || '.db';
      const files = await fs.readdir(backupsDir);
      const candidates = files.filter(f => f.endsWith(dbExt));
      if (candidates.length) {
        const stats = await Promise.all(
          candidates.map(async f => ({ f, t: (await fs.stat(path.join(backupsDir, f))).mtime.getTime() }))
        );
        stats.sort((a, b) => b.t - a.t);
        lastBackup = stats[0].f;
      }
    } catch (e) { void e; }

    const uptime = `${Math.round(process.uptime())}s`;

    // gather DB counts
    const db = require('../../db_async');
    const recruitsRow = await db.get('SELECT COUNT(*) as c FROM recruits');
    const recruitersRow = await db.get('SELECT COUNT(*) as c FROM recruiters');
    const recruits = recruitsRow ? recruitsRow.c : 0;
    const recruiters = recruitersRow ? recruitersRow.c : 0;

    const embed = new EmbedBuilder()
      .setTitle('Bot Status')
      .addFields(
        { name: 'DB Size', value: dbSize, inline: true },
        { name: 'Uptime', value: uptime, inline: true },
        { name: 'Last Backup', value: lastBackup, inline: true },
        { name: 'Recruits', value: `${recruits}`, inline: true },
        { name: 'Recruiters', value: `${recruiters}`, inline: true }
      )
      .setTimestamp();

    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.editReply === 'function') {
        return interaction.editReply({ embeds: [embed] });
      }
    }
    return interaction.reply({ embeds: [embed], flags: 64 });
  }
};

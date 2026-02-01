const fs = require('fs');
const path = require('path');
const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: { name: 'status' },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) return interaction.reply({ content: 'Administrator permission required.' });

    const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'recruiter.db');
    let dbSize = 'N/A';
    try {
      const s = fs.statSync(DB_PATH);
      dbSize = `${Math.round(s.size / 1024)} KB`;
    } catch (e) { void e; }

    const backupsDir = path.join(path.dirname(DB_PATH), 'backups');
    let lastBackup = 'None';
    try {
      const files = fs.readdirSync(backupsDir).filter(f => f.endsWith('.db')).map(f => ({ f, t: fs.statSync(path.join(backupsDir, f)).mtime.getTime() }));
      if (files.length) {
        files.sort((a, b) => b.t - a.t);
        lastBackup = files[0].f;
      }
    } catch (e) { void e; }

    const uptime = `${Math.round(process.uptime())}s`;

    // gather DB counts
    const db = require('../db_async');
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

    return interaction.reply({ embeds: [embed] });
  }
};

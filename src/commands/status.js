const fs = require('fs');
const path = require('path');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');

module.exports = {
  data: { name: 'status' },
  async execute(interaction) {
    if (!interaction.member.permissions.has(PermissionsBitField.Flags.Administrator)) return interaction.reply({ content: 'Administrator permission required.', ephemeral: true });

    const DB_PATH = process.env.DATABASE_PATH || path.join(__dirname, '..', 'data', 'recruiter.db');
    let dbSize = 'N/A';
    try {
      const s = fs.statSync(DB_PATH);
      dbSize = `${Math.round(s.size/1024)} KB`;
    } catch (e) { }

    const backupsDir = path.join(path.dirname(DB_PATH), 'backups');
    let lastBackup = 'None';
    try {
      const files = fs.readdirSync(backupsDir).filter(f => f.endsWith('.db')).map(f=>({f, t: fs.statSync(path.join(backupsDir,f)).mtime.getTime()}));
      if (files.length) {
        files.sort((a,b)=>b.t-a.t);
        lastBackup = files[0].f;
      }
    } catch (e) { }

    const uptime = `${Math.round(process.uptime())}s`;

    // gather DB counts
    const db = require('../db');
    const recruits = db.prepare('SELECT COUNT(*) as c FROM recruits').get().c;
    const recruiters = db.prepare('SELECT COUNT(*) as c FROM recruiters').get().c;

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

    return interaction.reply({ embeds: [embed], ephemeral: true });
  }
};

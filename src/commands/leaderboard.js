const db = require('../db');
const { EmbedBuilder } = require('discord.js');
const { REGIONS } = require('../constants');

module.exports = {
  data: { name: 'leaderboard' },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'show') {
      const scheduler = require('../scheduler');
      const region = interaction.options.getString('region');
      const since = Date.now() - (7 * 24 * 60 * 60 * 1000);
      if (region) {
        if (!REGIONS.includes(region) && region !== 'GLOBAL') return interaction.reply({ content: 'Invalid region.', ephemeral: true });
        const rows = await db.all('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ? GROUP BY recruiter_id ORDER BY cnt DESC', region, since);
        const { makeLeaderboardEmbed } = require('../lib/messages');
        const lang = interaction.locale || 'en';
        const embed = makeLeaderboardEmbed(rows, region, lang);
        return interaction.reply({ embeds: [embed], ephemeral: false });
      }

      // Global: combine regions into one list but still use weekly window
      const rows = await db.all('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE valid = 1 AND created_at >= ? GROUP BY recruiter_id ORDER BY cnt DESC', since);
      const text = scheduler.formatLeaderboardMessage(rows, 'GLOBAL');
      const embed = new EmbedBuilder().setTitle('Leaderboard (GLOBAL)').setDescription(text).setColor(0x00AAFF);
      return interaction.reply({ embeds: [embed], ephemeral: false });
    }

    if (sub === 'init') {
      // admin only
      if (!interaction.member.permissions.has('Administrator')) return interaction.reply({ content: 'Admin only.', ephemeral: true });
      try {
        const scheduler = require('../scheduler');
        await scheduler.recomputeLeaderboards(db, interaction.guild);
        return interaction.reply({ content: 'Leaderboards initialized/updated.', ephemeral: true });
      } catch (e) {
        console.error(e);
        return interaction.reply({ content: 'Failed to initialize leaderboards.', ephemeral: true });
      }
    }
  }
};
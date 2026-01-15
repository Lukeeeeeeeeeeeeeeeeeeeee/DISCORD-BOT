const db = require('../db');

module.exports = {
  data: { name: 'leaderboard' },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'show') {
      const scheduler = require('../scheduler');
      const region = interaction.options.getString('region');
      if (region) {
        const since = Date.now() - (7*24*60*60*1000);
        const rows = db.prepare('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ? GROUP BY recruiter_id ORDER BY cnt DESC').all(region, since);
        const text = scheduler.formatLeaderboardMessage(rows, region);
        return interaction.reply({ content: text, ephemeral: false });
      }
      // Global: combine regions into one list but still use weekly window
      const since = Date.now() - (7*24*60*60*1000);
      const rows = db.prepare('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE valid = 1 AND created_at >= ? GROUP BY recruiter_id ORDER BY cnt DESC').all(since);
      const text = scheduler.formatLeaderboardMessage(rows, 'GLOBAL');
      return interaction.reply({ content: text, ephemeral: false });
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
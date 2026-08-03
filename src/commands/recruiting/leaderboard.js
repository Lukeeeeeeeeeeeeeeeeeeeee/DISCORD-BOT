const { hasAdministrator } = require('../../lib/permissions');
const { replyError } = require('../../lib/embeds');
const { createResponder } = require('../../lib/respond');
const { resolveGuildId } = require('../../lib/guild');
const { showLeaderboard } = require('../../services/recruiting/leaderboard-service');
const scheduler = require('../../scheduler');
const defaultDb = require('../../db_async');

module.exports = {
  data: { name: 'leaderboard' },
  async execute(interaction, _client, db) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'show') {
      const dbHandle = db || defaultDb;
      const guildId = resolveGuildId(interaction.guild || interaction);
      const result = await showLeaderboard({ interaction, db: dbHandle, guildId });
      if (result && result.error) return replyError(interaction, result.error);
      return result;
    }

    if (sub === 'recompute') {
      if (!hasAdministrator(interaction.member)) return replyError(interaction, 'Admin/Staff only.');
      const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
      await defer();
      try {
        const dbHandle = db || defaultDb;
        await scheduler.recomputeLeaderboards(dbHandle, interaction.guild);
        return respond({ content: 'Leaderboards recomputed.' });
      } catch (e) {
        console.error('Failed to recompute leaderboards', e);
        return replyError(interaction, 'Failed to recompute leaderboards.');
      }
    }
  }
};

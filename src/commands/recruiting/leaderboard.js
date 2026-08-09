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

    if (sub === 'init') {
      if (!hasAdministrator(interaction.member)) return replyError(interaction, 'Admin/Staff only.');
      const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
      await defer();
      try {
        const dbHandle = db || defaultDb;
        const guildId = resolveGuildId(interaction.guild || interaction);
        
        // Recompute all leaderboards
        await scheduler.recomputeLeaderboards(dbHandle, interaction.guild);
        
        // Try to recompute warnings leaderboard if the function exists
        if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
          try {
            await scheduler.recomputeWarningsLeaderboard(dbHandle, interaction.guild);
          } catch (warnErr) {
            console.log('Warning leaderboard recompute skipped or failed:', warnErr.message);
          }
        }

        // Get stats about tracked leaderboards
        const rows = await dbHandle.all(
          `SELECT channel_id, region, COUNT(*) AS cnt
           FROM leaderboard_messages
           WHERE guild_id = ?
           GROUP BY channel_id, region
           ORDER BY channel_id, region`,
          guildId
        );
        
        const duplicateRows = (rows || []).filter(r => Number(r.cnt || 0) > 1);
        const uniqueChannels = new Set((rows || []).map(r => r.channel_id)).size;
        const summary = [
          '✅ Leaderboards initialized/updated.',
          `📊 Tracked rows: ${(rows || []).length}`,
          `📢 Tracked channels: ${uniqueChannels}`,
          `⚠️ Duplicate row groups: ${duplicateRows.length}`
        ];
        
        if (duplicateRows.length) {
          const sample = duplicateRows.slice(0, 5).map((r) => `- <#${r.channel_id}> [${r.region || 'null'}]: ${r.cnt}`);
          summary.push('\n**Duplicate details (first 5):**');
          summary.push(...sample);
        }
        
        return respond({ content: summary.join('\n') });
      } catch (e) {
        console.error('Failed to initialize leaderboards:', e);
        return replyError(interaction, `Failed to initialize leaderboards: ${e.message}`);
      }
    }
  }
};

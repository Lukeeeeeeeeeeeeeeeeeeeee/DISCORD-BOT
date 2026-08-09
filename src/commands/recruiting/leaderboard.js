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
    
    if (sub === 'emergency-fix') {
      if (!hasAdministrator(interaction.member)) return replyError(interaction, 'Administrator only.');
      const { respond, defer } = createResponder(interaction, { defaultFlags: 64 });
      await defer();
      
      try {
        const guildId = resolveGuildId(interaction.guild || interaction);
        const dbHandle = db || defaultDb;
        const now = Date.now();
        const baseTimestamp = Date.now() - (3 * 24 * 60 * 60 * 1000);
        
        const fixes = [
          { recruiterId: '1504846628656250951', name: 'dekieats', points: 2, region: 'AS' },
          { recruiterId: '1238882108097953864', name: 'str1k3', points: 4, region: 'EU' },
          { recruiterId: '1050044494736150579', name: 'AvoidMyRevol', points: 11, region: 'EU' },
          { recruiterId: '1141653573959299102', name: 'Hikaru', points: 10, region: 'AS' }
        ];
        
        let report = '🚨 **EMERGENCY FIX REPORT**\n\n';
        let fixed = 0;
        
        for (const fix of fixes) {
          const recruiterData = await dbHandle.get(
            'SELECT points FROM recruiters WHERE guild_id = ? AND id = ?',
            guildId, fix.recruiterId
          );
          
          const recruitCount = await dbHandle.get(
            'SELECT COUNT(*) as cnt FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1',
            guildId, fix.recruiterId
          );
          
          const currentPoints = recruiterData ? recruiterData.points : 0;
          const currentRecruits = recruitCount ? recruitCount.cnt : 0;
          
          if (currentPoints === fix.points && currentRecruits < fix.points) {
            report += `⚠️ **${fix.name}**: ${currentPoints}pts but only ${currentRecruits} recruits\n`;
            
            if (!recruiterData) {
              await dbHandle.run(
                'INSERT INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, ?, 0, 0, 4)',
                guildId, fix.recruiterId, fix.points
              );
            }
            
            const missing = fix.points - currentRecruits;
            for (let i = 0; i < missing; i++) {
              const timestamp = baseTimestamp + (i * 60 * 60 * 1000);
              const recruitedId = `EMERGENCY_FIX_${fix.recruiterId}_${i}_${now}_${Math.random()}`;
              
              await dbHandle.run(
                'INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, points, created_at, valid) VALUES (?, ?, ?, ?, 1, ?, 1)',
                guildId, fix.recruiterId, recruitedId, fix.region, timestamp
              );
            }
            
            fixed++;
            report += `✅ **Fixed**: Added ${missing} recruit records\n\n`;
          } else {
            report += `✅ **${fix.name}**: Already correct (${currentRecruits}/${fix.points})\n\n`;
          }
        }
        
        if (fixed > 0) {
          report += `\n🎉 **SUCCESS!** Fixed ${fixed} recruiter(s)\n\n`;
          report += '⚠️ **Next step**: Run `/leaderboard recompute` to update the leaderboards';
        } else {
          report += '\n✅ All data is already correct!';
        }
        
        return respond({ content: report });
      } catch (error) {
        console.error('Emergency fix failed:', error);
        return replyError(interaction, `Emergency fix failed: ${error.message}`);
      }
    }
    
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

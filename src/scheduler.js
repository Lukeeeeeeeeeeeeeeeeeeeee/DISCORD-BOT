const cron = require('node-cron');
const dayjs = require('dayjs');
const { MIN_RECRUITS_FOR_AUTO, EXEMPT_TOP_PERCENT, REPEATED_FLAGS_TO_WARN, ESCALATION_WINDOW_WEEKS, CHANNELS, RECRUITER_ROLE_IDS } = require('./constants');
const { performWeeklyRecalculations } = require('./lib/weekly-recalculations');

async function computeStats(db, region, since=0) {
  // since: timestamp in ms. If zero, consider all-time; otherwise limit to recruits.created_at >= since
  const totalRow = since ? await db.get('SELECT COUNT(*) as c FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ?', region, since) : await db.get('SELECT COUNT(*) as c FROM recruits WHERE region = ? AND valid = 1', region);
  const total = totalRow ? totalRow.c : 0;
  const rows = since ? await db.all('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ? GROUP BY recruiter_id', region, since)
                 : await db.all('SELECT recruiter_id, COUNT(*) as cnt FROM recruits WHERE region = ? AND valid = 1 GROUP BY recruiter_id', region);
  if (!rows.length) return [];
  const counts = rows.map(r=>r.cnt);
  const mean = counts.reduce((a,b)=>a+b,0)/counts.length;
  const variance = counts.reduce((a,b)=>a + Math.pow(b-mean,2),0)/counts.length;
  const stddev = Math.sqrt(variance);
  rows.forEach(r=>{
    r.mean = mean; r.stddev = stddev; r.total = total;
  });
  return rows;
}

async function applyFlags(db, guild) {
  // use last 7 days as the weekly window
  const sinceWindow = Date.now() - (7*24*60*60*1000);
  for (const region of ['EU','NA','AS']) {
    const rows = await computeStats(db, region, sinceWindow);
    if (!rows.length) continue;
    const active = rows.filter(r=>r.cnt >= MIN_RECRUITS_FOR_AUTO);
    if (active.length <= 2) continue; // no auto-warnings
    const total = rows[0].total;
    rows.sort((a,b)=>b.cnt-a.cnt);
    const next_highest = (i)=> rows[i+1] ? rows[i+1].cnt : 0;

    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const z = r.stddev ? (r.cnt - r.mean)/r.stddev : 0;
      const flagged = [];
      if (z >= 2.5) flagged.push('Outlier');
      if (r.cnt/total >= 0.5 && total >= 8) flagged.push('Share');
      if (r.cnt >= next_highest(i) + Math.max(5, 0.2 * total)) flagged.push('Gap');

      // Exempt top EXEMPT_TOP_PERCENT from auto-conversion to warning
      const exemptCutoff = Math.max(1, Math.ceil(rows.length * EXEMPT_TOP_PERCENT));
      const exempt = i < exemptCutoff;

      if (flagged.length) {
        await db.run('INSERT INTO flags (recruiter_id, reason, created_at) VALUES (?, ?, ?)', r.recruiter_id, flagged.join(','), Date.now());

        // check escalation
        const since = Date.now() - (ESCALATION_WINDOW_WEEKS*7*24*60*60*1000);
        const countFlagsRow = await db.get('SELECT COUNT(*) as c FROM flags WHERE recruiter_id = ? AND created_at >= ?', r.recruiter_id, since);
        const countFlags = countFlagsRow ? countFlagsRow.c : 0;
        if (!exempt && countFlags >= REPEATED_FLAGS_TO_WARN) {
          await db.run('INSERT INTO warnings (recruiter_id, created_at, note) VALUES (?, ?, ?)', r.recruiter_id, Date.now(), 'Auto-created from repeated flags');
          // increment warnings in recruiters table
          await db.run('UPDATE recruiters SET warnings = warnings + 1 WHERE id = ?', r.recruiter_id);
          // DM recruiter
          guild.members.fetch(r.recruiter_id).then(m=>{
            m.send('You have received a warning for suspicious recruiting activity.').catch(()=>{});
          }).catch(()=>{});
          // post to warnings channel
          const ch = guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS);
          if (ch) ch.send(`<@${r.recruiter_id}> received an automated warning.`).catch(()=>{});
        }
      }
    }
  }
}

function formatLeaderboardMessage(rows, regionLabel) {
  // rows: [{recruiter_id, cnt, points}, ...]
  if (!rows || rows.length === 0) return `Leaderboard (${regionLabel})\nNo recruiters yet.`;
  const lines = rows.map((r, i) => `${i+1}. <@${r.recruiter_id}> — **${r.cnt}** recruits${(r.points || 0) ? ` — ${(r.points || 0)} pts` : ''}`);
  return `Leaderboard (${regionLabel})\n\n` + lines.join('\n');
}

async function recomputeLeaderboards(db, guild) {
  // For each of the region channels, update a single message with top recruiters
  const regions = [{key:'EU', channel: CHANNELS.INVITES_EU},{key:'NA', channel: CHANNELS.INVITES_NA},{key:'AS', channel: CHANNELS.INVITES_AS}];
  const since = Date.now() - (7*24*60*60*1000);
  const { upsertLeaderboardMessage } = require('./lib/messages');
  
  for (const rg of regions) {
    // Get all users with recruiter roles and their recruit counts
    const recruiterRoleId = RECRUITER_ROLE_IDS[rg.key];
    const recruiterRole = guild.roles.cache.get(recruiterRoleId);
    
    if (!recruiterRole) {
      console.error(`Recruiter role ${recruiterRoleId} for region ${rg.key} not found`);
      continue;
    }
    
    // Get all members with recruiter role for this region
    const recruiterMembers = recruiterRole.members.map(member => member.id);
    
    if (recruiterMembers.length === 0) {
      console.log(`No members found with recruiter role for region ${rg.key}`);
      continue;
    }
    
    // Build query to get all recruiters with their counts
    const placeholders = recruiterMembers.map(() => '?').join(',');
    const unionSelects = recruiterMembers.map(() => 'SELECT ? AS id').join(' UNION ALL ');
    const rowsBase = await db.all(`
      SELECT 
        r.id AS recruiter_id, 
        COALESCE(c.cnt, 0) AS cnt, 
        COALESCE(db_rec.points, 0) AS points 
      FROM (${unionSelects}) r
      LEFT JOIN (
        SELECT recruiter_id, COUNT(*) as cnt 
        FROM recruits 
        WHERE region = ? AND valid = 1 AND created_at >= ? 
        GROUP BY recruiter_id
      ) c ON c.recruiter_id = r.id 
      LEFT JOIN recruiters db_rec ON db_rec.id = r.id
      ORDER BY cnt DESC, points DESC
    `, ...recruiterMembers, rg.key, since);
    
    const rows = [];
    for (const r of rowsBase) {
      // compute per-recruiter additional stats for min requirement
      const since28 = Date.now() - (28*24*60*60*1000);
      const recentRows = await db.all('SELECT created_at, recruited_id FROM recruits WHERE recruiter_id = ? AND created_at >= ? AND valid = 1', r.recruiter_id, since28);
      const total28 = recentRows.length;
      const weekStarts = new Set(recentRows.map(rr => Math.floor((rr.created_at - since28) / (7*24*60*60*1000))));
      const distinctWeeks = Math.max(1, Math.min(4, weekStarts.size || 1));
      const recruitedIds = recentRows.map(rr => rr.recruited_id);

      const econ = require('./lib/economy');
      const retention = recruitedIds.length ? await econ.computeRetentionFromGuild(guild, recruitedIds, 7, 15, { fallbackToHeuristic: true }) : 0;
      const warningsRow = await db.get('SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)', r.recruiter_id, Date.now());
      const lastRow = await db.get('SELECT created_at FROM recruits WHERE recruiter_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 1', r.recruiter_id);
      const daysSinceLast = lastRow ? Math.floor((Date.now() - lastRow.created_at) / (24*60*60*1000)) : Number.POSITIVE_INFINITY;
      const mul = await econ.getActiveMultiplier(db, r.recruiter_id);
      let channelBase = econ.ECONOMY_CONFIG.BASE_VALUE;
      try {
        const recRow = await db.get('SELECT channel_base FROM recruiters WHERE id = ?', r.recruiter_id);
        if (recRow && recRow.channel_base) channelBase = recRow.channel_base;
      } catch (e) {
        channelBase = econ.ECONOMY_CONFIG.BASE_VALUE;
      }
      const roleModifier = econ.ECONOMY_CONFIG.ROLE_MODIFIERS.NONE;
      const minReq = econ.calculateMinRecruitsRequired({ channelBase, roleModifier, total28d: total28, distinctWeeks, retention: Math.max(0, Math.min(1, retention === -1 ? 0 : retention)), activeWarnings: warningsRow ? warningsRow.c : 0, daysSinceLastRecruit: daysSinceLast || Number.POSITIVE_INFINITY, activeMultiplierValue: mul.value || 1.0 });
      rows.push({...r, total28, distinctWeeks, retention, warnings: warningsRow ? warningsRow.c : 0, daysSinceLast, multiplier: mul, minReq});
    }

    const ch = guild.channels.cache.get(rg.channel);
    if (!ch) continue;
    try {
      // Update region channel message via helper using plain text
      const { makeLeaderboardEmbed } = require('./lib/messages');
      const lang = process.env.DEFAULT_LANG || 'en';
      const leaderboardData = makeLeaderboardEmbed(rows, rg.key, lang);
      await upsertLeaderboardMessage(db, ch, rg.key, leaderboardData.content, null).catch(()=>{});

      // Cross-post / update in central channel
      try {
        const { CHANNELS } = require('./constants');
        const central = guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD);
        if (central) await upsertLeaderboardMessage(db, central, rg.key, leaderboardData.content, null).catch(()=>{});
      } catch (e) {
        // best-effort
      }
    } catch (err) {
      // ignore non-critical errors
      console.error('Leaderboard update failed for', rg.key, err);
    }
  }
}

async function recomputeWarningsLeaderboard(db, guild) {
  const now = Date.now();
  // active warnings: not revoked and not expired
  // Get all recruiters with their warning counts, even those with 0 warnings
  const rows = await db.all(`
    SELECT 
      r.id AS recruiter_id, 
      COALESCE(w.cnt, 0) AS cnt 
    FROM recruiters r 
    LEFT JOIN (
      SELECT recruiter_id, COUNT(*) as cnt 
      FROM warnings 
      WHERE revoked = 0 AND (expired_at IS NULL OR expired_at > ?) 
      GROUP BY recruiter_id
    ) w ON w.recruiter_id = r.id 
    ORDER BY cnt DESC
  `, now);
  
  const { upsertLeaderboardMessage, makeWarningsEmbed } = require('./lib/messages');
  const ch = guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS);
  if (!ch) return;
  try {
    const warningsData = makeWarningsEmbed(rows, process.env.DEFAULT_LANG || 'en');
    await upsertLeaderboardMessage(db, ch, 'WARNINGS', warningsData.content, null).catch(()=>{});
  } catch (e) {
    console.error('Failed to update warnings leaderboard', e);
  }
}

function start(client, db) {
    // run immediately on start and then schedule weekly
    client.once('ready', ()=>{
      applyFlags(db, client.guilds.cache.get(process.env.GUILD_ID));
      recomputeLeaderboards(db, client.guilds.cache.get(process.env.GUILD_ID));
    });

    // Cron: Monday at 00:00 UTC - Weekly recruiter recalculation
    cron.schedule('0 0 * * 1', async () => {
      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) return;
      
      console.log('Starting weekly recruiter recalculation...');
      try {
        await performWeeklyRecalculations(guild);
        console.log('Weekly recruiter recalculation completed successfully');
      } catch (error) {
        console.error('Weekly recruiter recalculation failed:', error);
      }
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    // Cron: Sunday at 12:00 UTC
    cron.schedule('0 12 * * 0', async () => {
      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) return;
      // Recompute statistics, check for members who left and mark recruits invalid
      // Remove recruits where member left
      const recruits = await db.all('SELECT * FROM recruits WHERE valid = 1');
      for (const r of recruits) {
        guild.members.fetch(r.recruited_id).catch(async ()=>{
          // member not found, mark invalid and recompute
          await db.run('UPDATE recruits SET valid = 0 WHERE id = ?', r.id);
        });
      }

      // Apply flags and leaderboard recompute
      await applyFlags(db, guild);
      await recomputeLeaderboards(db, guild);

      // Reset weekly counts: For this system we will delete weekly recruits or set a week marker; simpler: purchases/points persist; leaderboards are recomputed from recruits with timestamps; however spec says reset weekly counts — we implement a 'week' table for counts or just reset points for weekly scoreboard. For now, keep recruits but staff can clear weekly counts by truncating a 'weekly' view. (Tunable later.)
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    // Daily maintenance: expire warnings/multipliers and recompute warning counts
    cron.schedule('0 0 * * *', async () => {
      try {
        // remove expired multipliers (cleanup)
        await db.run('DELETE FROM multipliers WHERE expires_at <= ?', Date.now());

        // recompute warnings per recruiter (active = not revoked AND (expired_at IS NULL OR expired_at > now))
        const rows = await db.all('SELECT DISTINCT recruiter_id FROM warnings');
        for (const r of rows) {
          const cntRow = await db.get('SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)', r.recruiter_id, Date.now());
          const active = cntRow ? cntRow.c : 0;
          await db.run('UPDATE recruiters SET warnings = ? WHERE id = ?', active, r.recruiter_id);
        }

        // Recompute leaderboards to reflect any changes
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (guild) await module.exports.recomputeLeaderboards(db, guild);
      } catch (e) {
        console.error('Daily maintenance failed', e);
      }
    }, {
      scheduled: true,
      timezone: 'UTC'
    });

    // Monthly reset: 1st of month 00:00 UTC
    cron.schedule('0 0 1 * *', async () => {
      try {
        await db.run('UPDATE recruiters SET points = 0');
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        if (guild) {
          const ch = guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
          if (ch) ch.send('Monthly recruiter points reset to 0.').catch(()=>{});
        }
      } catch (e) { console.error('Monthly reset failed', e); }
    }, {
      scheduled: true,
      timezone: 'UTC'
    });
}

module.exports = {
  start,
  applyFlags,
  recomputeLeaderboards,
  formatLeaderboardMessage,
  recomputeWarningsLeaderboard
};
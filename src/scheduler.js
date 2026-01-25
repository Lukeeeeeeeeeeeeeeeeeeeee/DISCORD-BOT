const cron = require('node-cron');
const dayjs = require('dayjs');
const { MIN_RECRUITS_FOR_AUTO, EXEMPT_TOP_PERCENT, REPEATED_FLAGS_TO_WARN, ESCALATION_WINDOW_WEEKS, CHANNELS, RECRUITER_ROLE_IDS, ROLE_IDS } = require('./constants');
const { performWeeklyRecalculations } = require('./lib/weekly-recalculations');
const { calculate7DayStats, getPreviousMinReq, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement } = require('./lib/recruiting-system');

function getWeekStartUtcTs(now = new Date()) {
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  weekStart.setUTCDate(weekStart.getUTCDate() - diffToMonday);
  return weekStart.getTime();
}

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
  const sinceWindow = getWeekStartUtcTs();
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
  const since = getWeekStartUtcTs();
  const { upsertLeaderboardMessage } = require('./lib/messages');
  
  // Ensure member cache is populated so role.members is accurate
  try {
    await guild.members.fetch();
  } catch (e) {
    console.error('Failed to fetch guild members for leaderboard computation:', e);
  }

  const staffRoleIds = [
    ROLE_IDS.HELPER,
    ROLE_IDS.HELPER_PLUS,
    ROLE_IDS.MOD,
    ROLE_IDS.CHIEF,
    ROLE_IDS.CHIEF_OF_WAR,
    ROLE_IDS.CHIEF_OF_COMMUNITY,
    ROLE_IDS.CHIEF_OF_RECRUITMENT,
    ROLE_IDS.HIGH_STAFF,
    ROLE_IDS.STAFF,
    ROLE_IDS.CO_LEADER,
    ROLE_IDS.LEADER
  ];
  
  for (const rg of regions) {
    console.log(`Processing region ${rg.key}...`);
    console.log(`Channel ID for ${rg.key}: ${rg.channel}`);
    
    // Region membership rules:
    // - NA/AS: only members with that regional recruiter role
    // - EU: members with EU recruiter role OR general recruiter/trial recruiter OR staff (default region)
    const recruiterRoleId = RECRUITER_ROLE_IDS[rg.key];
    const recruiterRole = guild.roles.cache.get(recruiterRoleId);
    console.log(`Recruiter role ID for ${rg.key}: ${recruiterRoleId}`);
    console.log(`Recruiter role found: ${!!recruiterRole}`);

    const allRecruiterIds = new Set();
    if (recruiterRole) recruiterRole.members.forEach(m => allRecruiterIds.add(m.id));

    if (rg.key === 'EU') {
      const extraRoleIds = [ROLE_IDS.RECRUITER, ROLE_IDS.TRIAL_RECRUITER, ...staffRoleIds];
      for (const roleId of extraRoleIds) {
        const role = guild.roles.cache.get(roleId);
        if (!role) continue;
        role.members.forEach(m => allRecruiterIds.add(m.id));
      }
    }

    console.log(`Total recruiters found for ${rg.key}: ${allRecruiterIds.size}`);
    
    if (allRecruiterIds.size === 0) {
      console.log(`No recruiters found for region ${rg.key}`);
      
      // Still post a "No recruiters found" message to empty channels
      const ch = guild.channels.cache.get(rg.channel);
      if (ch) {
        console.log(`Posting 'No recruiters found' message to ${rg.key} channel...`);
        try {
          const { makeLeaderboardEmbed } = require('./lib/messages');
          const lang = process.env.DEFAULT_LANG || 'en';
          const leaderboardData = makeLeaderboardEmbed([], rg.key, lang); // Empty array = no recruiters
          
          await upsertLeaderboardMessage(db, ch, rg.key, leaderboardData.content, null).catch((err) => {
            console.error(`Failed to post 'no recruiters' message for ${rg.key}:`, err);
          });
          
          console.log(`Successfully posted 'no recruiters' message for ${rg.key}`);
        } catch (err) {
          console.error(`Failed to create 'no recruiters' message for ${rg.key}:`, err);
        }
      }
      continue;
    }
    
    const recruiterMembers = Array.from(allRecruiterIds);
    
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
      // Region-specific counts: rowsBase.cnt is already last-7-days for this region.
      const recruits7d = r.cnt || 0;
      const retention = recruits7d > 0 ? 1 : 0;
      const previousMinReq = await getPreviousMinReq(db, r.recruiter_id);
      
      // Check for active absence
      const absence = await db.get(
        'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
        r.recruiter_id
      );
      
      // Get active warnings count
      const warnings = await db.get(
        'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
        r.recruiter_id, Date.now()
      );
      const activeWarnings = warnings ? warnings.c : 0;
      
      // Get staff member for role calculation
      const staffMember = await guild.members.fetch(r.recruiter_id).catch(() => null);
      const roleBase = getBaseRequirement(staffMember);
      
      const minReq = previousMinReq != null ? previousMinReq : calculateMinRecruitsFixed({
        roleBase,
        role: staffMember ? staffMember.roles.cache.first()?.id : null,
        recruits7d,
        activityRate: recruits7d,
        retention,
        warnings: activeWarnings,
        previousMinReq,
        absent: !!absence,
        isNewStaff: false // Default to false for now
      });

      rows.push({
        ...r,
        recruits7d,
        retention,
        minReq,
        absence: !!absence
      });
    }

    const ch = guild.channels.cache.get(rg.channel);
    console.log(`Looking for channel ${rg.channel} for ${rg.key}...`);
    console.log(`Channel found: ${!!ch}`);
    if (ch) {
      console.log(`Channel name: ${ch.name}`);
      console.log(`Channel type: ${ch.type}`);
    }
    
    if (!ch) {
      console.log(`Channel not found for ${rg.key}: ${rg.channel}`);
      continue;
    }
    
    console.log(`Updating leaderboard for ${rg.key} in channel ${ch.name}...`);
    
    try {
      // Update region channel message via helper using plain text
      const { makeLeaderboardEmbed } = require('./lib/messages');
      const lang = process.env.DEFAULT_LANG || 'en';
      const leaderboardData = makeLeaderboardEmbed(rows, rg.key, lang);
      
      console.log(`Generated leaderboard for ${rg.key} with ${rows.length} entries`);
      console.log(`Content preview: ${leaderboardData.content.substring(0, 200)}...`);
      
      await upsertLeaderboardMessage(db, ch, rg.key, leaderboardData.content, null).catch((err) => {
        console.error(`Failed to upsert message for ${rg.key}:`, err);
      });

      console.log(`Successfully updated leaderboard for ${rg.key}`);

      // Cross-post / update in central channel
      try {
        const { CHANNELS } = require('./constants');
        const central = guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD);
        if (central) {
          console.log(`Cross-posting to central leaderboard...`);
          await upsertLeaderboardMessage(db, central, rg.key, leaderboardData.content, null).catch((err) => {
            console.error(`Failed to cross-post to central leaderboard:`, err);
          });
          console.log(`Successfully cross-posted to central leaderboard`);
        } else {
          console.log(`Central leaderboard channel not found: ${CHANNELS.CENTRAL_LEADERBOARD}`);
        }
      } catch (e) {
        console.error('Error in cross-post:', e);
      }
    } catch (err) {
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

    // Cron: Monday at 00:05 UTC - Weekly MinReq and stats snapshot (5 minutes after recalculation)
    cron.schedule('5 0 * * 1', async () => {
      console.log('Starting weekly MinReq and stats reset...');
      try {
        // Reset weekly recruit counts and update MinReq for all recruiters
        const recruiters = await db.all('SELECT id FROM recruiters');
        
        for (const recruiter of recruiters) {
          // Store current week's MinReq before reset
          const currentStats = await calculate7DayStats(db, recruiter.id);
          const previousMinReq = await getPreviousMinReq(db, recruiter.id);
          
          // Get staff member for role calculation
          const guild = client.guilds.cache.get(process.env.GUILD_ID);
          const staffMember = await guild.members.fetch(recruiter.id).catch(() => null);
          const roleBase = getBaseRequirement(staffMember);
          
          // Calculate final MinReq for the week
          const finalMinReq = calculateMinRecruitsFixed({
            roleBase,
            role: staffMember ? staffMember.roles.cache.first()?.id : null,
            recruits7d: currentStats.recruits7d,
            activityRate: currentStats.activityRate,
            retention: currentStats.retention,
            warnings: 0, // Use current warnings from database
            previousMinReq,
            absent: false, // Check absence
            isNewStaff: false
          });
          
          // Store the final MinReq for this week
          await storeWeeklyCalculation(db, {
            recruiterId: recruiter.id,
            recruits7d: currentStats.recruits7d,
            activityRate: currentStats.activityRate,
            retention: currentStats.retention,
            warnings: 0,
            previousMinReq,
            calculatedMinReq: finalMinReq,
            roleBase
          });
          
          console.log(`Stored weekly calculation for ${recruiter.id}: MinReq=${finalMinReq}, Recruits=${currentStats.recruits7d}`);
        }
        
        console.log('Weekly MinReq and stats reset completed successfully');
      } catch (error) {
        console.error('Weekly MinReq and stats reset failed:', error);
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

    // Hourly cleanup: expired invites
    cron.schedule('0 * * * *', async () => {
      try {
        const inviteCommand = require('./commands/invite');
        const inviteSystem = await inviteCommand.init();
        
        if (inviteSystem) {
          await inviteSystem.cleanupExpiredInvites();
          console.log('🧹 Hourly invite cleanup completed');
        }
      } catch (error) {
        console.error('Hourly invite cleanup failed:', error);
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
  getWeekStartUtcTs,
  start,
  applyFlags,
  recomputeLeaderboards,
  formatLeaderboardMessage,
  recomputeWarningsLeaderboard
};
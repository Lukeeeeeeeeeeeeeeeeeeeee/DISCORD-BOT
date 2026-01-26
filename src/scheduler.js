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
  const { upsertLeaderboardMessage, makeLeaderboardText } = require('./lib/messages');
  
  // Ensure member cache is populated so role.members is accurate
  try {
    if (guild.members && typeof guild.members.fetch === 'function') {
      await guild.members.fetch();
    }
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
    ROLE_IDS.CO_LEADER,
    ROLE_IDS.LEADER
  ];
  
  for (const rg of regions) {
    console.log(`Processing region ${rg.key}...`);
    console.log(`Channel ID for ${rg.key}: ${rg.channel}`);
    
    // Resolve central leaderboard channel once per region loop iteration
    const central = guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD);

    const allRecruiterIds = new Set();

    // Prefer role-based membership when guild roles are available.
    if (guild.roles && guild.roles.cache && typeof guild.roles.cache.get === 'function') {
      // Region membership rules:
      // - NA/AS: only members with that regional recruiter role
      // - EU: members with EU recruiter role OR general recruiter/trial recruiter OR staff (default region)
      const recruiterRoleId = RECRUITER_ROLE_IDS[rg.key];
      const recruiterRole = guild.roles.cache.get(recruiterRoleId);
      console.log(`Recruiter role ID for ${rg.key}: ${recruiterRoleId}`);
      console.log(`Recruiter role found: ${!!recruiterRole}`);

      if (recruiterRole) recruiterRole.members.forEach(m => allRecruiterIds.add(m.id));

      if (rg.key === 'EU') {
        const extraRoleIds = [ROLE_IDS.RECRUITER, ROLE_IDS.TRIAL_RECRUITER, ...staffRoleIds];
        for (const roleId of extraRoleIds) {
          const role = guild.roles.cache.get(roleId);
          if (!role) continue;
          role.members.forEach(m => allRecruiterIds.add(m.id));
        }
      }
    } else {
      // Test-mode / minimal guild mock: fall back to anyone who has recruited in this region in-window.
      const ids = await db.all(
        'SELECT DISTINCT recruiter_id FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ?',
        rg.key,
        since
      );
      ids.forEach(r => allRecruiterIds.add(r.recruiter_id));
    }


    console.log(`Total recruiters found for ${rg.key}: ${allRecruiterIds.size}`);

    const lang = process.env.DEFAULT_LANG || 'en';
    let leaderboardText;

    if (allRecruiterIds.size === 0) {
      console.log(`No recruiters found for region ${rg.key}`);
      leaderboardText = makeLeaderboardText([], rg.key, lang);
    }
    
    let rows = [];
    if (!leaderboardText) {
      const recruiterMembers = Array.from(allRecruiterIds);
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

      for (const r of rowsBase) {
        const recruits7d = r.cnt || 0;
        let member = null;
        try {
          if (guild && guild.members && typeof guild.members.fetch === 'function') {
            member = await guild.members.fetch(r.recruiter_id).catch(() => null);
          }
        } catch (e) {
          member = null;
        }

        const roleBase = getBaseRequirement(member);

        let previousMinReq = null;
        try {
          previousMinReq = await getPreviousMinReq(db, r.recruiter_id);
        } catch (e) {
          previousMinReq = null;
        }

        let absence = null;
        try {
          absence = await db.get(
            'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
            r.recruiter_id
          );
        } catch (e) {
          absence = null;
        }

        let activeWarnings = 0;
        try {
          const warningsRow = await db.get(
            'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
            r.recruiter_id,
            Date.now()
          );
          activeWarnings = warningsRow ? warningsRow.c : 0;
        } catch (e) {
          activeWarnings = 0;
        }

        let stats7d = { recruits7d, activityRate: recruits7d, retention: 0 };
        try {
          stats7d = await calculate7DayStats(db, r.recruiter_id, guild || null);
        } catch (e) {
          stats7d = { recruits7d, activityRate: recruits7d, retention: 0 };
        }

        const retention = stats7d.retention || 0;
        const minReq = calculateMinRecruitsFixed({
          roleBase,
          member,
          recruits7d: stats7d.recruits7d,
          activityRate: stats7d.activityRate,
          retention,
          warnings: activeWarnings,
          previousMinReq,
          absent: !!absence,
          isNewStaff: false
        });

        rows.push({
          ...r,
          recruits7d: stats7d.recruits7d,
          retention,
          minReq,
          absence: !!absence
        });
      }

      leaderboardText = makeLeaderboardText(rows, rg.key, lang);
      console.log(`Generated leaderboard for ${rg.key} with ${rows.length} entries`);
    }

    const ch = guild.channels.cache.get(rg.channel);
    console.log(`Looking for channel ${rg.channel} for ${rg.key}...`);
    console.log(`Channel found: ${!!ch}`);

    if (ch) {
      console.log(`Updating leaderboard for ${rg.key} in channel ${ch.name}...`);
      await upsertLeaderboardMessage(db, ch, rg.key, leaderboardText, null).catch((err) => {
        console.error(`Failed to upsert message for ${rg.key}:`, err);
      });
    } else {
      console.log(`Channel not found for ${rg.key}: ${rg.channel} (skipping regional post)`);
    }

    if (central) {
      console.log(`Cross-posting to central leaderboard for ${rg.key}...`);
      await upsertLeaderboardMessage(db, central, rg.key, leaderboardText, null).catch((err) => {
        console.error(`Failed to cross-post to central leaderboard for ${rg.key}:`, err);
      });
    } else {
      console.log(`Central leaderboard channel not found: ${CHANNELS.CENTRAL_LEADERBOARD}`);
    }
  }
}

async function recomputeWarningsLeaderboard(db, guild) {
  const now = Date.now();
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
  const ch = guild && guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
    ? guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS)
    : null;
  if (!ch) return;

  try {
    const warningsEmbed = makeWarningsEmbed(rows, process.env.DEFAULT_LANG || 'en');
    await upsertLeaderboardMessage(db, ch, 'WARNINGS', null, warningsEmbed).catch(() => {});
  } catch (e) {
    console.error('Failed to update warnings leaderboard', e);
  }
}

async function runWeeklySnapshotAndReset(db, client) {
  console.log('Starting weekly MinReq and stats reset...');
  try {
    const weekStart = getWeekStartUtcTs();

    // One-time announcement per week in the overall invites channel
    try {
      const announceKey = `weekly_reset_announce_${weekStart}`;
      const existing = await db.get('SELECT key FROM system_events WHERE key = ?', announceKey);
      if (!existing) {
        await db.run('INSERT OR REPLACE INTO system_events (key, timestamp) VALUES (?, ?)', announceKey, Date.now());
        const guild = client.guilds.cache.get(process.env.GUILD_ID);
        const ch = guild ? guild.channels.cache.get(CHANNELS.INVITES_OVERALL) : null;
        if (ch) {
          await ch.send('@everyone Weekly invite/recruit tables have been reset for the new week.').catch(() => {});
        }
      }
    } catch (e) {
      console.error('Weekly reset announcement failed:', e);
    }

    const recruiters = await db.all('SELECT id FROM recruiters');
    const guild = client.guilds.cache.get(process.env.GUILD_ID);

    for (const recruiter of recruiters) {
      const currentStats = await calculate7DayStats(db, recruiter.id, guild || null);
      const previousMinReq = await getPreviousMinReq(db, recruiter.id);

      const warnings = await db.get(
        'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
        recruiter.id, Date.now()
      );
      const activeWarnings = warnings ? warnings.c : 0;

      const absence = await db.get(
        'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
        recruiter.id
      );

      const staffMember = guild ? await guild.members.fetch(recruiter.id).catch(() => null) : null;
      const roleBase = getBaseRequirement(staffMember);

      const isTrialRecruiter = !!staffMember && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

      const finalMinReq = isTrialRecruiter ? 3 : calculateMinRecruitsFixed({
        roleBase,
        member: staffMember,
        recruits7d: currentStats.recruits7d,
        activityRate: currentStats.activityRate,
        retention: currentStats.retention,
        warnings: activeWarnings,
        previousMinReq,
        absent: !!absence,
        isNewStaff: false
      });

      await storeWeeklyCalculation(db, {
        recruiterId: recruiter.id,
        weekStart,
        recruits7d: currentStats.recruits7d,
        activityRate: currentStats.activityRate,
        retention: currentStats.retention,
        warnings: activeWarnings,
        absent: !!absence,
        previousMinReq,
        calculatedMinReq: finalMinReq,
        roleBase
      });

      console.log(`Stored weekly calculation for ${recruiter.id}: MinReq=${finalMinReq}, Recruits=${currentStats.recruits7d}`);
    }

    // Auto-warning: missed quota in >=2 of last 3 weekly snapshots (absence weeks ignored)
    try {
      const noteToken = `Auto-warning: missed quota (2/3) week_start=${weekStart}`;
      let createdAny = false;

      for (const recruiter of recruiters) {
        const recent = await db.all(
          'SELECT week_start, recruits7d, calculated_min_req, absent FROM weekly_calculations WHERE recruiter_id = ? AND absent = 0 AND week_start IS NOT NULL ORDER BY week_start DESC LIMIT 3',
          recruiter.id
        );

        if (!recent || recent.length < 3) continue;
        const misses = recent.filter(r => (r.recruits7d || 0) < (r.calculated_min_req || 0)).length;
        if (misses < 2) continue;

        // Deduplicate: only one auto-warning per recruiter per week_start
        const existing = await db.get(
          'SELECT id FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND note = ?',
          recruiter.id,
          noteToken
        );
        if (existing) continue;

        await db.run(
          'INSERT INTO warnings (recruiter_id, created_at, note, expired_at, revoked) VALUES (?, ?, ?, NULL, 0)',
          recruiter.id,
          Date.now(),
          noteToken
        );
        await db.run('INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES (?, 0, 0, 0, 4)', recruiter.id);
        await db.run('UPDATE recruiters SET warnings = warnings + 1 WHERE id = ?', recruiter.id);
        createdAny = true;

        // Optional notifications (best-effort)
        try {
          if (guild) {
            const member = await guild.members.fetch(recruiter.id).catch(() => null);
            if (member && typeof member.send === 'function') {
              await member.send('You have received an automated warning for missing your recruiting quota in 2 of the last 3 weeks.').catch(() => {});
            }
          }
        } catch (e) {
          void e;
        }
      }

      if (createdAny && guild) {
        try {
          await recomputeWarningsLeaderboard(db, guild);
        } catch (e) {
          void e;
        }
      }
    } catch (e) {
      console.error('Auto-warning generation failed:', e);
    }

    // Mark weekly snapshot complete so we can catch up if the bot was down
    try {
      const snapKey = `weekly_snapshot_${weekStart}`;
      await db.run('INSERT OR REPLACE INTO system_events (key, timestamp) VALUES (?, ?)', snapKey, Date.now());
    } catch (e) {
      console.error('Failed to persist weekly snapshot marker:', e);
    }

    // Ensure leaderboards reflect the new week window immediately
    try {
      if (guild) await recomputeLeaderboards(db, guild);
    } catch (e) {
      console.error('Failed to recompute leaderboards after weekly snapshot:', e);
    }

    console.log('Weekly MinReq and stats reset completed successfully');
  } catch (error) {
    console.error('Weekly MinReq and stats reset failed:', error);
  }
}

async function reconcileTrialRecruiters(db, client) {
  try {
    const guild = client.guilds.cache.get(process.env.GUILD_ID);
    if (!guild) return;
    const trialRole = guild.roles.cache.get(ROLE_IDS.TRIAL_RECRUITER);
    if (!trialRole) return;

    const now = Date.now();
    const windowStart = now - (9 * 24 * 60 * 60 * 1000);
    const members = Array.from(trialRole.members.values());
    for (const recruiterMember of members) {
      if (recruiterMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE)) continue;

      const recent = await db.all(
        'SELECT recruited_id FROM recruits WHERE recruiter_id = ? AND valid = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT 3',
        recruiterMember.id, windowStart
      );
      if (!recent || recent.length < 3) continue;

      let allStillInGuild = true;
      for (const r of recent) {
        try {
          const m = await guild.members.fetch(r.recruited_id);
          if (!m) { allStillInGuild = false; break; }
        } catch (e) {
          if (e && (e.code === 10007 || (e.message || '').toLowerCase().includes('unknown member'))) {
            allStillInGuild = false;
            break;
          }
          // If we can't verify due to transient errors, do not promote
          allStillInGuild = false;
          break;
        }
      }
      if (!allStillInGuild) continue;

      await recruiterMember.roles.remove(ROLE_IDS.TRIAL_RECRUITER).catch(() => {});
      await recruiterMember.roles.add(ROLE_IDS.AUTO_PROMOTE_ROLE).catch(() => {});
      await recruiterMember.roles.add(ROLE_IDS.RECRUITER).catch(() => {});

      // After promotion, store a fresh weekly calculation so minReq transitions off trial=3
      try {
        const currentStats = await calculate7DayStats(db, recruiterMember.id);
        const warnings = await db.get(
          'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
          recruiterMember.id, Date.now()
        );
        const activeWarnings = warnings ? warnings.c : 0;
        const absence = await db.get(
          'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
          recruiterMember.id
        );
        const roleBase = getBaseRequirement(recruiterMember);
        const calculatedMinReq = calculateMinRecruitsFixed({
          roleBase,
          role: recruiterMember.roles.cache.first()?.id,
          recruits7d: currentStats.recruits7d,
          activityRate: currentStats.activityRate,
          retention: currentStats.retention,
          warnings: activeWarnings,
          previousMinReq: null,
          absent: !!absence,
          isNewStaff: false
        });
        await storeWeeklyCalculation(db, {
          recruiterId: recruiterMember.id,
          recruits7d: currentStats.recruits7d,
          activityRate: currentStats.activityRate,
          retention: currentStats.retention,
          warnings: activeWarnings,
          previousMinReq: null,
          calculatedMinReq,
          roleBase
        });
      } catch (e) {
        console.error('Failed to store weekly calc after trial promotion:', e);
      }

      await db.run('DELETE FROM trial_fast_track WHERE recruiter_id = ?', recruiterMember.id).catch(() => {});
      console.log('Auto-promoted trial recruiter (reconciled):', recruiterMember.id);
    }
  } catch (e) {
    console.error('Trial recruiter reconcile failed:', e);
  }
}

function start(client, db) {
    // scheduler.start() is called from index.js after the client is ready,
    // so don't wait for a second ready event here.
    (async () => {
      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) return;
      await applyFlags(db, guild).catch(() => {});
      await reconcileTrialRecruiters(db, client).catch(() => {});
      await recomputeLeaderboards(db, guild).catch(() => {});

      // Catch-up: if weekly snapshot was missed (bot offline at 00:05 UTC), run it once.
      try {
        const weekStart = getWeekStartUtcTs();
        const snapKey = `weekly_snapshot_${weekStart}`;
        const existing = await db.get('SELECT key FROM system_events WHERE key = ?', snapKey);
        const scheduledTs = weekStart + (5 * 60 * 1000);
        if (!existing && Date.now() >= scheduledTs) {
          await runWeeklySnapshotAndReset(db, client);
        }
      } catch (e) {
        console.error('Weekly snapshot catch-up check failed:', e);
      }
    })();

    // Cron: Monday at 00:00 UTC - Weekly recruiter recalculation
    cron.schedule('0 0 * * 1', async () => {
      const guild = client.guilds.cache.get(process.env.GUILD_ID);
      if (!guild) return;
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
      await runWeeklySnapshotAndReset(db, client);
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
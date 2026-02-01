const cron = require('node-cron');
const { GUILD_ID, CHANNELS, RECRUITER_ROLE_IDS, ROLE_IDS, REGION_INFO } = require('./constants');
const { performWeeklyRecalculations } = require('./lib/weekly-recalculations');
const { calculate7DayStats, getPreviousMinReq, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('./lib/recruiting-system');

const DEBUG_SCHEDULER = process.env.DEBUG_SCHEDULER === '1';

function debugLog(...args) {
  if (DEBUG_SCHEDULER) console.log(...args);
}

function resolveGuildId() {
  return process.env.GUILD_ID || GUILD_ID;
}

async function resolveGuild(client) {
  const guildId = resolveGuildId();
  if (!client || !client.guilds) return null;
  const cached = client.guilds.cache ? client.guilds.cache.get(guildId) : null;
  if (cached) return cached;
  if (typeof client.guilds.fetch === 'function') {
    return client.guilds.fetch(guildId).catch(() => null);
  }
  return null;
}

function getWeekStartUtcTs(now = new Date()) {
  const day = now.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const weekStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0));
  weekStart.setUTCDate(weekStart.getUTCDate() - diffToMonday);
  return weekStart.getTime();
}

async function enforceQuotaWarnings(db, guild, weekStart, recruiters) {
  if (!db || !guild || !weekStart || !recruiters) return;
  for (const recruiter of recruiters) {
    const recruiterId = recruiter.id;
    const snapshots = await db.all(
      'SELECT week_start, recruits7d, calculated_min_req, absent FROM weekly_calculations WHERE recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT 3',
      recruiterId
    );

    if (!snapshots || snapshots.length < 3) {
      continue;
    }

    const eligible = snapshots.filter(row => !row.absent);
    const misses = eligible.filter(row => {
      const minReq = Number(row.calculated_min_req || 0);
      const recruits7d = Number(row.recruits7d || 0);
      return minReq > 0 && recruits7d < minReq;
    });

    if (misses.length < 2) {
      continue;
    }

    const latest = eligible[0] || snapshots[0];
    const recruits7d = Number(latest && latest.recruits7d ? latest.recruits7d : 0);
    const minReq = Number(latest && latest.calculated_min_req ? latest.calculated_min_req : 0);
    const effectiveWeekStart = latest && latest.week_start ? latest.week_start : weekStart;
    const tier = minReq <= 3 ? 1 : (minReq <= 5 ? 2 : 3);
    const note = `Quota warning T${tier} week_start=${effectiveWeekStart} recruits=${recruits7d} minReq=${minReq}`;

    const existing = await db.get(
      'SELECT id FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND note = ? LIMIT 1',
      recruiterId,
      note
    );
    if (existing) continue;

    await db.run(
      'INSERT INTO warnings (recruiter_id, created_at, note, expired_at, revoked) VALUES (?, ?, ?, NULL, 0)',
      recruiterId,
      Date.now(),
      note
    );
    await db.run('INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES (?, 0, 0, 0, 4)', recruiterId);
    await db.run('UPDATE recruiters SET warnings = warnings + 1 WHERE id = ?', recruiterId);

    const warningCountRow = await db.get(
      'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
      recruiterId,
      Date.now()
    );
    const activeWarnings = warningCountRow ? warningCountRow.c : 0;
    const demotionTag = activeWarnings >= 2 ? ' They are now on demotion watch.' : '';

    const ch = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
      ? guild.channels.cache.get(CHANNELS.INVITES_OVERALL)
      : null;
    if (ch && typeof ch.send === 'function') {
      await ch.send(`⚠️ <@${recruiterId}> missed quota in ${misses.length} of the last 3 weeks (${recruits7d}/${minReq}). Warning issued.${demotionTag}`).catch(() => { });
    }

    try {
      const member = await guild.members.fetch(recruiterId).catch(() => null);
      if (member) {
        const watchMsg = activeWarnings >= 2 ? ' You are now on demotion watch.' : '';
        await member.send(
          `⚠️ Recruiter warning: you missed your quota in ${misses.length} of the last 3 weeks. `
          + `Current week: ${recruits7d}/${minReq}.${watchMsg} If you need help, DM a staffer.`
        ).catch(() => { });
      }
    } catch (e) {
      console.error('Failed to DM auto-warning recruiter', { recruiterId, error: e });
    }
  }
}

function formatLeaderboardMessage(rows, regionLabel) {
  // Map region codes to team names
  const teamMap = { 'EU': '🔥 Fire', 'NA': '💧 Water', 'AS': '🌬️ Air', 'GLOBAL': '🌍 Global' };
  const teamName = teamMap[regionLabel] || regionLabel;

  if (!rows || rows.length === 0) return `# ${teamName} Leaderboard\nNo recruiters yet.`;
  const lines = rows.map((r, i) => {
    const name = r.recruiter_id ? `<@${r.recruiter_id}>` : (r.displayName || 'Unknown');
    return `${i + 1}. ${name} — **${r.cnt}** recruits${(r.points || 0) ? ` — ${(r.points || 0)} pts` : ''}${r.systemWarning ? ' ⚠️**!**' : ''}`;
  });

  return `# ${teamName} Leaderboard\n\n` + lines.join('\n');
}

async function recomputeLeaderboards(db, guild) {
  const regions = [
    { key: 'EU', channel: CHANNELS.INVITES_EU },
    { key: 'NA', channel: CHANNELS.INVITES_NA },
    { key: 'AS', channel: CHANNELS.INVITES_AS }
  ];
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

  for (const rg of regions) {
    debugLog(`Processing region ${rg.key}...`);
    debugLog(`Channel ID for ${rg.key}: ${rg.channel}`);

    const central = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
      ? guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD)
      : null;

    const allRecruiterIds = new Set();

    // Prefer role-based membership when guild roles are available.
    if (guild.roles && guild.roles.cache && typeof guild.roles.cache.get === 'function') {
      // Region membership rules:
      // - NA/AS: only members with that regional recruiter role
      // - EU: members with EU recruiter role
      const recruiterRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[rg.key] ? RECRUITER_ROLE_IDS[rg.key] : null;
      const recruiterRole = recruiterRoleId ? guild.roles.cache.get(recruiterRoleId) : null;
      debugLog(`Recruiter role ID for ${rg.key}: ${recruiterRoleId}`);
      debugLog(`Recruiter role found: ${!!recruiterRole}`);

      if (recruiterRole && recruiterRole.members) recruiterRole.members.forEach(m => allRecruiterIds.add(m.id));
    } else {
      // Test-mode / minimal guild mock: fall back to anyone who has recruited in this region in-window.
      const ids = await db.all(
        'SELECT DISTINCT recruiter_id FROM recruits WHERE region = ? AND valid = 1 AND created_at >= ?',
        rg.key,
        since
      );
      (ids || []).forEach(r => allRecruiterIds.add(r.recruiter_id));
    }

    debugLog(`Total recruiters found for ${rg.key}: ${allRecruiterIds.size}`);
    const lang = process.env.DEFAULT_LANG || 'en';
    let leaderboardText;

    if (allRecruiterIds.size === 0) {
      debugLog(`No recruiters found for region ${rg.key}`);
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
      const enriched = [];
      for (const r of (rowsBase || [])) {
        const stats7d = await calculate7DayStats(db, r.recruiter_id, guild).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
        const previousMinReq = await getPreviousMinReq(db, r.recruiter_id).catch(() => null);
        const newStaffCheck = await isNewStaff(db, r.recruiter_id).catch(() => false);

        const absence = await db.get(
          'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
          r.recruiter_id
        ).catch(() => null);

        const warnings = await db.get(
          'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
          r.recruiter_id,
          Date.now()
        ).catch(() => null);
        const activeWarnings = warnings ? warnings.c : 0;

        const staffMember = guild && guild.members && typeof guild.members.fetch === 'function'
          ? await guild.members.fetch(r.recruiter_id).catch(() => null)
          : null;
        const roleBase = getBaseRequirement(staffMember);

        const isTrialRecruiter = !!staffMember
          && staffMember.roles
          && staffMember.roles.cache
          && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)
          && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

        const minReq = isTrialRecruiter ? 3 : calculateMinRecruitsFixed({
          roleBase,
          member: staffMember,
          recruits7d: stats7d.recruits7d,
          activityRate: stats7d.activityRate,
          verifyRate: stats7d.verifyRate,
          retention: stats7d.retention,
          warnings: activeWarnings,
          previousMinReq,
          absent: !!absence,
          isNewStaff: newStaffCheck
        });

        const systemWarningRow = await db.get(
          'SELECT 1 FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?) AND note LIKE ? LIMIT 1',
          r.recruiter_id,
          Date.now(),
          'Quota warning%'
        ).catch(() => null);

        enriched.push({
          ...r,
          recruits7d: stats7d.recruits7d,
          retention: stats7d.retention,
          minReq,
          absence: !!absence,
          systemWarning: !!systemWarningRow,
          activeWarnings,
          displayName: staffMember && staffMember.user
            ? `${staffMember.user.tag || staffMember.user.username} | ${REGION_INFO && REGION_INFO[rg.key] ? REGION_INFO[rg.key].name : rg.key}`
            : `<@${r.recruiter_id}>`
        });
      }

      rows = enriched;
      leaderboardText = makeLeaderboardText(rows, rg.key, lang);
    }

    const channel = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
      ? guild.channels.cache.get(rg.channel)
      : null;
    debugLog(`Looking for channel ${rg.channel} for ${rg.key}...`);
    debugLog(`Channel found: ${!!channel}`);

    if (channel) {
      debugLog(`Updating leaderboard for ${rg.key} in channel ${channel.name || channel.id}...`);
      await upsertLeaderboardMessage(db, channel, rg.key, leaderboardText);
    }
    if (central) {
      debugLog(`Cross-posting to central leaderboard for ${rg.key}...`);
      await upsertLeaderboardMessage(db, central, rg.key, leaderboardText);
    }
  }
}

async function recomputeWarningsLeaderboard(db, guild) {
  if (!db || !guild) return;
  const { upsertLeaderboardMessage, makeDemotionWatchText } = require('./lib/messages');
  const channel = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
    ? guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS)
    : null;
  if (!channel) return;

  const warningRows = await db.all(
    'SELECT recruiter_id, COUNT(*) as cnt FROM warnings WHERE revoked = 0 AND (expired_at IS NULL OR expired_at > ?) GROUP BY recruiter_id HAVING cnt >= 2 ORDER BY cnt DESC',
    Date.now()
  );
  const warningCountMap = new Map((warningRows || []).map(row => [row.recruiter_id, row.cnt]));

  const recruiterIds = (warningRows || []).map(r => r.recruiter_id);
  if (!recruiterIds.length) {
    const text = makeDemotionWatchText([]);
    await upsertLeaderboardMessage(db, channel, 'WARNINGS', text);
    return;
  }

  const since = getWeekStartUtcTs();
  const unionSelects = recruiterIds.map(() => 'SELECT ? AS id').join(' UNION ALL ');
  const rowsBase = await db.all(`
    SELECT
      r.id AS recruiter_id,
      COALESCE(c.cnt, 0) AS cnt,
      COALESCE(db_rec.points, 0) AS points
    FROM (${unionSelects}) r
    LEFT JOIN (
      SELECT recruiter_id, COUNT(*) as cnt
      FROM recruits
      WHERE valid = 1 AND created_at >= ?
      GROUP BY recruiter_id
    ) c ON c.recruiter_id = r.id
    LEFT JOIN recruiters db_rec ON db_rec.id = r.id
    ORDER BY cnt DESC, points DESC
  `, ...recruiterIds, since);

  const rows = [];
  for (const r of rowsBase || []) {
    const stats7d = await calculate7DayStats(db, r.recruiter_id, guild).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
    const previousMinReq = await getPreviousMinReq(db, r.recruiter_id).catch(() => null);
    const newStaffCheck = await isNewStaff(db, r.recruiter_id).catch(() => false);

    const absence = await db.get(
      'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
      r.recruiter_id
    ).catch(() => null);

    const warnings = await db.get(
      'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
      r.recruiter_id,
      Date.now()
    ).catch(() => null);
    const activeWarnings = warnings ? warnings.c : 0;
    if (activeWarnings < 2) continue;

    const staffMember = guild && guild.members && typeof guild.members.fetch === 'function'
      ? await guild.members.fetch(r.recruiter_id).catch(() => null)
      : null;
    const roleBase = getBaseRequirement(staffMember);

    const systemWarningRow = await db.get(
      'SELECT 1 FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?) AND note LIKE ? LIMIT 1',
      r.recruiter_id,
      Date.now(),
      'Quota warning%'
    ).catch(() => null);

    const isTrialRecruiter = !!staffMember && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

    const minReq = isTrialRecruiter ? 3 : calculateMinRecruitsFixed({
      roleBase,
      member: staffMember,
      recruits7d: stats7d.recruits7d,
      activityRate: stats7d.activityRate,
      verifyRate: stats7d.verifyRate,
      retention: stats7d.retention,
      warnings: activeWarnings,
      previousMinReq,
      absent: !!absence,
      isNewStaff: newStaffCheck
    });

    const warningCount = warningCountMap.get(r.recruiter_id) || activeWarnings;

    rows.push({
      ...r,
      recruits7d: stats7d.recruits7d,
      minReq,
      absence: !!absence,
      systemWarning: !!systemWarningRow,
      activeWarnings,
      warningCount
    });
  }

  const text = makeDemotionWatchText(rows);
  await upsertLeaderboardMessage(db, channel, 'WARNINGS', text);
}

async function reconcileTrialRecruiters(_db, _client) {
  // Intentionally disabled/handled elsewhere.
}

async function runWeeklySnapshotAndReset(db, client) {
  debugLog('Starting weekly MinReq and stats reset...');
  try {
    const weekStart = getWeekStartUtcTs();

    // One-time announcement per week in the overall invites channel
    try {
      const announceKey = `weekly_reset_announce_${weekStart}`;
      const existing = await db.get('SELECT key FROM system_events WHERE key = ?', announceKey);
      if (!existing) {
        await db.run('INSERT OR REPLACE INTO system_events (key, timestamp) VALUES (?, ?)', announceKey, Date.now());
        const guild = await resolveGuild(client);
        const ch = guild ? guild.channels.cache.get(CHANNELS.INVITES_OVERALL) : null;
        if (ch) {
          await ch.send('@everyone Weekly invite/recruit tables have been reset for the new week.').catch(() => { });
        }
      }
    } catch (e) {
      console.error('Weekly reset announcement failed:', e);
    }

    const recruiters = await db.all('SELECT id FROM recruiters');
    const guild = await resolveGuild(client);

    for (const recruiter of recruiters) {
      const currentStats = await calculate7DayStats(db, recruiter.id, guild || null);
      const previousMinReq = await getPreviousMinReq(db, recruiter.id);

      let newStaffCheck = false;
      try {
        newStaffCheck = await isNewStaff(db, recruiter.id);
      } catch (e) {
        newStaffCheck = false;
      }

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
        verifyRate: currentStats.verifyRate,
        retention: currentStats.retention,
        warnings: activeWarnings,
        previousMinReq,
        absent: !!absence,
        isNewStaff: newStaffCheck
      });

      await storeWeeklyCalculation(db, {
        recruiterId: recruiter.id,
        weekStart,
        recruits7d: currentStats.recruits7d,
        activityRate: currentStats.activityRate,
        verifyRate: currentStats.verifyRate,
        retention: currentStats.retention,
        warnings: activeWarnings,
        absent: !!absence,
        previousMinReq,
        calculatedMinReq: finalMinReq,
        roleBase
      });

      debugLog(`Stored weekly calculation for ${recruiter.id}: MinReq=${finalMinReq}, Recruits=${currentStats.recruits7d}`);
    }

    try {
      if (guild) {
        await enforceQuotaWarnings(db, guild, weekStart, recruiters);
        await recomputeWarningsLeaderboard(db, guild).catch(() => { });
      }
    } catch (e) {
      console.error('Quota warning enforcement failed:', e);
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

    debugLog('Weekly MinReq and stats reset completed successfully');
  } catch (error) {
    console.error('Weekly MinReq and stats reset failed:', error);
  }
}

function start(client, db) {
  // scheduler.start() is called from index.js after the client is ready,
  // so don't wait for a second ready event here.
  (async () => {
    const guild = await resolveGuild(client);
    if (!guild) return;
    await reconcileTrialRecruiters(db, client).catch((e) => console.error('reconcileTrialRecruiters failed:', e));
    await recomputeLeaderboards(db, guild).catch((e) => console.error('recomputeLeaderboards failed:', e));

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
    const guild = await resolveGuild(client);
    if (!guild) return;
    try {
      await performWeeklyRecalculations(guild);
      debugLog('Weekly recruiter recalculation completed successfully');
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
    const guild = await resolveGuild(client);
    if (!guild) return;

    // Recompute statistics, check for members who left and mark recruits invalid
    // Remove recruits where member left
    const recruits = await db.all('SELECT * FROM recruits WHERE valid = 1');
    for (const r of recruits) {
      const m = await guild.members.fetch(r.recruited_id).catch(() => null);
      if (!m) {
        await db.run('UPDATE recruits SET valid = 0 WHERE id = ?', r.id).catch(() => { });
      }
    }

    await recomputeLeaderboards(db, guild).catch(() => { });
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
      const guild = await resolveGuild(client);
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
        debugLog('Hourly invite cleanup completed');
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
      // await db.run('UPDATE recruiters SET points = 0');
      const guild = await resolveGuild(client);
      if (guild) {
        const ch = guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
        // if (ch) ch.send('Monthly recruiter points reset to 0.').catch(() => { });
        if (ch) ch.send('Monthly stats maintenance complete. Points have been preserved.').catch(() => { });
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
  recomputeLeaderboards,
  formatLeaderboardMessage,
  recomputeWarningsLeaderboard
};
const cron = require('node-cron');
const { GUILD_ID, CHANNELS, RECRUITER_ROLE_IDS, ROLE_IDS, REGION_INFO } = require('./constants');
const { formatPointsValue } = require('./lib/economy');
const { getWeekStartUtcTs } = require('./lib/week');

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

async function resolveAllRecruiterIds(guild) {
  if (!guild) return [];
  const staffRoleIds = [
    ROLE_IDS.HELPER,
    ROLE_IDS.HELPER_PLUS,
    ROLE_IDS.MOD,
    ROLE_IDS.CHIEF,
    ROLE_IDS.CHIEF_OF_WAR,
    ROLE_IDS.CHIEF_OF_COMMUNITY,
    ROLE_IDS.CHIEF_OF_RECRUITMENT,
    ROLE_IDS.CO_LEADER,
    ROLE_IDS.LEADER,
    ROLE_IDS.HIGH_STAFF
  ].filter(Boolean);

  const recruiterRoleIds = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
  ].filter(Boolean);

  const ids = new Set();
  const allRoleIds = [...staffRoleIds, ...recruiterRoleIds];

  for (const roleId of allRoleIds) {
    try {
      if (guild.members && typeof guild.members.fetch === 'function') {
        await guild.members.fetch({ role: roleId }).catch(() => null);
      }
    } catch (e) {
      void e;
    }
    const role = guild.roles && guild.roles.cache ? guild.roles.cache.get(roleId) : null;
    if (role && role.members) {
      role.members.forEach(m => ids.add(m.id));
    }
  }

  return Array.from(ids);
}

async function enforceQuotaWarnings(db, guild, weekStart, recruiters) {
  if (!db || !guild || !weekStart || !recruiters) return;
  for (const recruiter of recruiters) {
    const recruiterId = recruiter.id;
    const snapshots = await db.all(
      'SELECT week_start, recruits7d, calculated_min_req, previous_min_req, absent FROM weekly_calculations WHERE recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT 3',
      recruiterId
    );

    if (!snapshots || snapshots.length < 3) {
      continue;
    }

    const eligible = snapshots.filter(row => !row.absent);
    const misses = eligible.filter(row => {
      const minReq = Number(
        row && row.previous_min_req !== null && row.previous_min_req !== undefined
          ? row.previous_min_req
          : (row.calculated_min_req || 0)
      );
      const recruits7d = Number(row.recruits7d || 0);
      return minReq > 0 && recruits7d < minReq;
    });

    if (misses.length < 2) {
      continue;
    }

    const latest = eligible[0] || snapshots[0];
    const recruits7d = Number(latest && latest.recruits7d ? latest.recruits7d : 0);
    const minReq = Number(
      latest && latest.previous_min_req !== null && latest.previous_min_req !== undefined
        ? latest.previous_min_req
        : (latest && latest.calculated_min_req ? latest.calculated_min_req : 0)
    );
    const effectiveWeekStart = latest && latest.week_start ? latest.week_start : weekStart;
    const note = `Quota warning week_start=${effectiveWeekStart}`;

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
          + `Last week: ${recruits7d}/${minReq}.${watchMsg} If you need help, DM a staffer.`
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
    const points = r.points || 0;
    const pointsText = points ? ` — ${formatPointsValue(points)} pts` : '';
    return `${i + 1}. ${name} — **${r.cnt}** recruits${pointsText}${r.systemWarning ? ' ⚠️**!**' : ''}`;
  });

  return `# ${teamName} Leaderboard\n\n` + lines.join('\n');
}

let leaderboardsInFlight = null;
let warningsInFlight = null;

async function recomputeLeaderboardsInternal(db, guild) {
  const regions = [
    { key: 'EU', channel: CHANNELS.INVITES_EU },
    { key: 'NA', channel: CHANNELS.INVITES_NA },
    { key: 'AS', channel: CHANNELS.INVITES_AS }
  ];
  const weekStart = getWeekStartUtcTs();
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
        weekStart
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
          COALESCE(db_rec.points, 0) AS points,
          wc.calculated_min_req AS min_req
        FROM (${unionSelects}) r
        LEFT JOIN (
          SELECT recruiter_id, COUNT(*) as cnt
          FROM recruits
          WHERE region = ? AND valid = 1 AND created_at >= ?
          GROUP BY recruiter_id
        ) c ON c.recruiter_id = r.id
        LEFT JOIN recruiters db_rec ON db_rec.id = r.id
        LEFT JOIN weekly_calculations wc ON wc.recruiter_id = r.id AND wc.week_start = ?
        ORDER BY cnt DESC, points DESC
      `, ...recruiterMembers, rg.key, weekStart, weekStart);

      const enriched = [];
      const statsWindow = { sinceTs: weekStart, untilTs: Date.now() };

      for (const r of (rowsBase || [])) {
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
        const newStaffCheck = await isNewStaff(db, r.recruiter_id).catch(() => false);

        const isTrialRecruiter = !!staffMember
          && staffMember.roles
          && staffMember.roles.cache
          && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)
          && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

        let minReq = Number.isFinite(r.min_req) ? Number(r.min_req) : null;
        let previousMinReq = null;
        if (minReq == null) {
          previousMinReq = await getPreviousMinReq(db, r.recruiter_id).catch(() => null);
          minReq = previousMinReq;
        }
        if (minReq == null) {
          const stats7d = await calculate7DayStats(db, r.recruiter_id, guild, statsWindow).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
          minReq = calculateMinRecruitsFixed({
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
        }

        if (isTrialRecruiter) minReq = 3;
        if (absence) minReq = 0;
        if (!Number.isFinite(minReq)) minReq = 2;

        const systemWarningRow = await db.get(
          'SELECT 1 FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?) AND note LIKE ? LIMIT 1',
          r.recruiter_id,
          Date.now(),
          'Quota warning%'
        ).catch(() => null);

        enriched.push({
          ...r,
          recruits7d: Number(r.cnt || 0),
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

async function recomputeLeaderboards(db, guild) {
  if (leaderboardsInFlight) return leaderboardsInFlight;
  leaderboardsInFlight = recomputeLeaderboardsInternal(db, guild);
  try {
    return await leaderboardsInFlight;
  } finally {
    leaderboardsInFlight = null;
  }
}

async function recomputeWarningsLeaderboardInternal(db, guild) {
  if (!db || !guild) return;
  const { upsertLeaderboardMessage, makeDemotionWatchText } = require('./lib/messages');
  const channel = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
    ? guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS)
    : null;
  if (!channel) return;

  try {
    const existing = await db.get(
      'SELECT id FROM leaderboard_messages WHERE channel_id = ? AND region = ?',
      channel.id,
      'WARNINGS'
    );
    if (!existing) {
      const legacy = await db.get(
        'SELECT id FROM leaderboard_messages WHERE channel_id = ? AND (region IS NULL OR region = "") ORDER BY id DESC LIMIT 1',
        channel.id
      );
      if (legacy && legacy.id) {
        await db.run('UPDATE leaderboard_messages SET region = ? WHERE id = ?', 'WARNINGS', legacy.id);
      }
    }
  } catch (e) {
    console.error('Failed to reconcile warnings leaderboard record:', e);
  }

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

  const weekStart = getWeekStartUtcTs();
  const unionSelects = recruiterIds.map(() => 'SELECT ? AS id').join(' UNION ALL ');
  const rowsBase = await db.all(`
    SELECT
      r.id AS recruiter_id,
      COALESCE(c.cnt, 0) AS cnt,
      COALESCE(db_rec.points, 0) AS points,
      wc.calculated_min_req AS min_req
    FROM (${unionSelects}) r
    LEFT JOIN (
      SELECT recruiter_id, COUNT(*) as cnt
      FROM recruits
      WHERE valid = 1 AND created_at >= ?
      GROUP BY recruiter_id
    ) c ON c.recruiter_id = r.id
    LEFT JOIN recruiters db_rec ON db_rec.id = r.id
    LEFT JOIN weekly_calculations wc ON wc.recruiter_id = r.id AND wc.week_start = ?
    ORDER BY cnt DESC, points DESC
  `, ...recruiterIds, weekStart, weekStart);

  const rows = [];
  const statsWindow = { sinceTs: weekStart, untilTs: Date.now() };
  for (const r of rowsBase || []) {
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
    const newStaffCheck = await isNewStaff(db, r.recruiter_id).catch(() => false);

    const systemWarningRow = await db.get(
      'SELECT 1 FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?) AND note LIKE ? LIMIT 1',
      r.recruiter_id,
      Date.now(),
      'Quota warning%'
    ).catch(() => null);

    const isTrialRecruiter = !!staffMember && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

    let minReq = Number.isFinite(r.min_req) ? Number(r.min_req) : null;
    let previousMinReq = null;
    if (minReq == null) {
      previousMinReq = await getPreviousMinReq(db, r.recruiter_id).catch(() => null);
      minReq = previousMinReq;
    }
    if (minReq == null) {
      const stats7d = await calculate7DayStats(db, r.recruiter_id, guild, statsWindow).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
      minReq = calculateMinRecruitsFixed({
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
    }

    if (isTrialRecruiter) minReq = 3;
    if (absence) minReq = 0;
    if (!Number.isFinite(minReq)) minReq = 2;

    const warningCount = warningCountMap.get(r.recruiter_id) || activeWarnings;

    rows.push({
      ...r,
      recruits7d: Number(r.cnt || 0),
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

async function recomputeWarningsLeaderboard(db, guild) {
  if (warningsInFlight) return warningsInFlight;
  warningsInFlight = recomputeWarningsLeaderboardInternal(db, guild);
  try {
    return await warningsInFlight;
  } finally {
    warningsInFlight = null;
  }
}

async function reconcileTrialRecruiters(_db, _client) {
  // Intentionally disabled/handled elsewhere.
}

async function runWeeklySnapshotAndReset(db, client, options = {}) {
  const { announce = true } = options || {};
  debugLog('Starting weekly MinReq and stats reset...');
  try {
    const weekStart = getWeekStartUtcTs();
    const weekStartIso = new Date(weekStart).toISOString().slice(0, 10);

    // One-time announcement per week in the overall invites channel (scheduled runs only)
    if (announce) {
      try {
        const announceKey = `weekly_reset_announce_${weekStart}`;
        const existing = await db.get('SELECT key FROM system_events WHERE key = ?', announceKey);
        if (!existing) {
          await db.run('INSERT OR REPLACE INTO system_events (key, timestamp) VALUES (?, ?)', announceKey, Date.now());
          const guild = await resolveGuild(client);
          const ch = guild ? guild.channels.cache.get(CHANNELS.INVITES_OVERALL) : null;
          if (ch) {
            await ch.send(`@everyone Weekly invite/recruit snapshot captured (week start ${weekStartIso} UTC).`).catch(() => { });
          }
        }
      } catch (e) {
        console.error('Weekly reset announcement failed:', e);
      }
    }

    const guild = await resolveGuild(client);
    let recruiterIds = guild ? await resolveAllRecruiterIds(guild) : [];
    if (!recruiterIds.length) {
      const rows = await db.all('SELECT id FROM recruiters');
      recruiterIds = (rows || []).map(r => r.id);
    }
    const recruiters = Array.from(new Set(recruiterIds)).map(id => ({ id }));
    const lastWeekStart = weekStart - (7 * 24 * 60 * 60 * 1000);
    const statsWindow = { sinceTs: lastWeekStart, untilTs: weekStart };

    for (const recruiter of recruiters) {
      await db.run('INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES (?, 0, 0, 0, 4)', recruiter.id);
      const currentStats = await calculate7DayStats(db, recruiter.id, guild || null, statsWindow);
      const prevMinRow = await db.get(
        'SELECT calculated_min_req FROM weekly_calculations WHERE recruiter_id = ? AND week_start < ? ORDER BY week_start DESC LIMIT 1',
        recruiter.id,
        weekStart
      );
      const previousMinReq = prevMinRow ? prevMinRow.calculated_min_req : null;

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
    // Sanity Window: Only catch up if we are within 24 hours of the scheduled time.
    // This prevents a Monday reset from triggering on a Sunday.
    try {
      const weekStart = getWeekStartUtcTs();
      const snapKey = `weekly_snapshot_${weekStart}`;
      const existing = await db.get('SELECT key FROM system_events WHERE key = ?', snapKey);

      const now = Date.now();
      const sanityWindow = 24 * 60 * 60 * 1000; // 24 hours

      if (!existing && now >= weekStart && now < weekStart + sanityWindow) {
        debugLog(`Catch-up: Running missed weekly snapshot for ${new Date(weekStart).toUTCString()}`);
        await runWeeklySnapshotAndReset(db, client, { announce: false });
      } else if (!existing && now >= weekStart + sanityWindow) {
        debugLog(`Catch-up skipped: Outside 24h sanity window for ${new Date(weekStart).toUTCString()}`);
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

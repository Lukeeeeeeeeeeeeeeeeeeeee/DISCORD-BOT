const cron = require('node-cron');
const { ShardClientUtil } = require('discord.js');
const { GUILD_ID, CHANNELS, RECRUITER_ROLE_IDS, ROLE_IDS } = require('./constants');
const { getRegionInfo, getTeamLabel } = require('./lib/regions');
const { formatPointsValue } = require('./lib/economy');
const { getWeekStartUtcTs } = require('./lib/week');
const { formatUtcDateOnly, formatUtcDate } = require('./lib/time');
const { fetchMembersByIds } = require('./lib/member-fetch');
const { fetchLeaderboardRows, loadRecruiterMeta, loadPreviousMinReqs } = require('./lib/leaderboard-utils');
const { logUnexpectedError } = require('./lib/logger');
const { 
  upsertLeaderboardMessage, 
  makeLeaderboardText, 
  makeDemotionWatchText 
} = require('./lib/messages');

const { performWeeklyRecalculations } = require('./lib/weekly-recalculations');

const { calculate7DayStats, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('./lib/recruiting-system');
const { acquireJobLock } = require('./lib/job-locks');
const { withTransaction } = require('./lib/transactions');

const DEBUG_SCHEDULER = process.env.DEBUG_SCHEDULER === '1';
const ALLOW_FULL_MEMBER_FETCH = (process.env.SCHEDULER_ALLOW_FULL_FETCH || process.env.ALLOW_FULL_MEMBER_FETCH || '').toLowerCase() === 'true';
const FORCE_FULL_FETCH_ON_EMPTY = (process.env.SCHEDULER_FORCE_FULL_FETCH_ON_EMPTY || 'true').toLowerCase() === 'true';
const FULL_FETCH_MAX = Number.parseInt(process.env.SCHEDULER_FULL_FETCH_MAX || '5000', 10);
const MEMBER_CACHE_WARM_COOLDOWN_MS = Number.parseInt(process.env.MEMBER_CACHE_WARM_COOLDOWN_MS || '600000', 10);
let lastMemberCacheWarmAt = 0;

function debugLog(...args) {
  if (DEBUG_SCHEDULER) console.log(...args);
}

// M-02: Extract the repeated staff-role fallback into a single utility rather than
// duplicating the Array.isArray / filter(Boolean) pattern across 4+ files.
function resolveStaffRoles() {
  return Array.isArray(ROLE_IDS.STAFF) && ROLE_IDS.STAFF.length
    ? ROLE_IDS.STAFF.filter(Boolean)
    : [
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
}

const { batchCalculate7DayStats, batchIsNewStaff } = require('./lib/recruiter-stats');

const SNAPSHOT_CONCURRENCY = Number.parseInt(process.env.SNAPSHOT_CONCURRENCY || '3', 10);

const { runWithConcurrency } = require('./lib/concurrency');

const ONE_HOUR_MS = 60 * 60 * 1000;
const ONE_DAY_MS = 24 * ONE_HOUR_MS;

function getUtcMonthBucket(ts = Date.now()) {
  const d = new Date(ts);
  const yyyy = d.getUTCFullYear();
  const mm = String(d.getUTCMonth() + 1).padStart(2, '0');
  return `${yyyy}-${mm}`;
}

async function acquireSchedulerLock(db, { guildId, key, ttlMs, scope }) {
  try {
    const locked = await acquireJobLock(db, { guildId, key, ttlMs, failOpen: false });
    if (!locked) debugLog(`Skipped scheduler job due to active lock: ${key}`);
    return locked;
  } catch (error) {
    logUnexpectedError(scope || 'scheduler.lock', error, { guildId, key, ttlMs });
    return false;
  }
}

async function seedRecruiters(db, ids, contextLabel, guildId = resolveGuildId()) {
  if (!db || !ids || !ids.length) return;
  try {
    for (const id of ids) {
      await db.run(
        'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
        guildId,
        id
      );
    }
  } catch (e) {
    console.error('Failed to seed recruiters', { context: contextLabel, error: e });
  }
}

function resolveGuildId() {
  return process.env.GUILD_ID || GUILD_ID;
}

function ownsGuild(client, guildId) {
  if (!client || !guildId) return true;
  const shard = client.shard;
  if (!shard || !Array.isArray(shard.ids) || typeof shard.count !== 'number') return true;
  try {
    const shardId = ShardClientUtil.shardIdForGuildId(guildId, shard.count);
    return shard.ids.includes(shardId);
  } catch (e) {
    return true;
  }
}

async function primeMemberCache(guild, contextLabel, options = {}) {
  if (!guild || !guild.members || typeof guild.members.fetch !== 'function') return false;
  const force = options && options.force === true;
  if (force && !FORCE_FULL_FETCH_ON_EMPTY) return false;
  const memberCount = Number(guild.memberCount || 0);
  const allowAuto = Number.isFinite(memberCount) && memberCount > 0 && memberCount <= FULL_FETCH_MAX;
  if (!force && !ALLOW_FULL_MEMBER_FETCH && !allowAuto) return false;
  const now = Date.now();
  if (now - lastMemberCacheWarmAt < MEMBER_CACHE_WARM_COOLDOWN_MS) return false;
  lastMemberCacheWarmAt = now;
  try {
    await guild.members.fetch();
    return true;
  } catch (e) {
    const hint = e && (e.code === 50001 || e.code === 50013)
      ? ' Check Server Members intent and bot permissions.'
      : '';
    console.error(`Failed to prime member cache${contextLabel ? ` (${contextLabel})` : ''}:${hint}`, e);
    return false;
  }
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

async function resolveAllRecruiterIds(guild, db) {
  if (!guild) return [];
  const guildId = guild.id || resolveGuildId();
  const staffRoleIds = resolveStaffRoles();

  const recruiterRoleIds = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
  ].filter(Boolean);

  const ids = new Set();
  const allRoleIds = [...staffRoleIds, ...recruiterRoleIds];
  let roleMemberCount = 0;
  let dbRecruiterRows = [];
  if (db) {
    try {
      dbRecruiterRows = await db.all('SELECT id FROM recruiters WHERE guild_id = ?', guildId);
    } catch (e) {
      console.error('Failed to load recruiter IDs from DB', e);
    }
  }
  const hasDbRecruiters = dbRecruiterRows.length > 0;

  const collectRoleMembers = () => {
    for (const roleId of allRoleIds) {
      const role = guild.roles && guild.roles.cache ? guild.roles.cache.get(roleId) : null;
      if (role && role.members) {
        roleMemberCount += role.members.size;
        role.members.forEach(m => ids.add(m.id));
      }
    }
  };

  collectRoleMembers();
  if (roleMemberCount === 0 && allRoleIds.length) {
    const warmed = await primeMemberCache(guild, 'resolveAllRecruiterIds', {
      force: FORCE_FULL_FETCH_ON_EMPTY && !hasDbRecruiters
    });
    if (warmed) {
      roleMemberCount = 0;
      ids.clear();
      collectRoleMembers();
    }
  }

  (dbRecruiterRows || []).forEach(r => {
    if (r && r.id) ids.add(r.id);
  });
  if (ids.size === 0 && db) {
    try {
      const recRows = await db.all('SELECT DISTINCT recruiter_id FROM recruits WHERE guild_id = ?', guildId);
      (recRows || []).forEach(r => {
        if (r && r.recruiter_id) ids.add(r.recruiter_id);
      });
    } catch (e) {
      console.error('Failed to load recruiter IDs from recruits', e);
    }
  }

  return Array.from(ids);
}

let leaderboardsInFlight = null;
let warningsInFlight = null;
let quotaWarningsInFlight = null;
let scheduledJobs = [];

async function enforceQuotaWarnings(db, guild, weekStart, recruiters) {
  if (!db || !guild || !weekStart || !recruiters) return;
  if (quotaWarningsInFlight) return quotaWarningsInFlight;
  
  quotaWarningsInFlight = (async () => {
    const guildId = guild.id || resolveGuildId();
    for (const recruiter of recruiters) {
      const recruiterId = recruiter.id;
      const snapshots = await db.all(
        'SELECT week_start, recruits7d, calculated_min_req, previous_min_req, absent FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT 3',
        guildId,
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

      await withTransaction(db, async (tx) => {
        const existing = await tx.get(
          'SELECT id FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND note = ? LIMIT 1',
          guildId,
          recruiterId,
          note
        );
        if (existing) return;

        await tx.run(
          'INSERT INTO warnings (guild_id, recruiter_id, created_at, note, expired_at, revoked) VALUES (?, ?, ?, ?, NULL, 0)',
          guildId,
          recruiterId,
          Date.now(),
          note
        );
        await tx.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', guildId, recruiterId);
        await tx.run('UPDATE recruiters SET warnings = warnings + 1 WHERE guild_id = ? AND id = ?', guildId, recruiterId);
      });

      const warningCountRow = await db.get(
        'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
        guildId,
        recruiterId,
        Date.now()
      );
      const activeWarnings = warningCountRow ? warningCountRow.c : 0;
      const demotionTag = activeWarnings >= 2 ? ' They are now on demotion watch.' : '';

      const ch = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
        ? guild.channels.cache.get(CHANNELS.INVITES_OVERALL)
        : null;
      if (ch && typeof ch.send === 'function') {
        await ch.send(`⚠️ <@${recruiterId}> missed quota in ${misses.length} of the last 3 weeks (${recruits7d}/${minReq}). Warning issued.${demotionTag}`).catch(err => {
          void logUnexpectedError('scheduler.enforceQuotaWarnings.post', err, { recruiterId });
        });
      }

      try {
        const member = (guild.members && guild.members.cache) 
          ? guild.members.cache.get(recruiterId) 
          : await guild.members.fetch(recruiterId).catch(() => null);
          
        if (member) {
          const watchMsg = activeWarnings >= 2 ? ' You are now on demotion watch.' : '';
          await member.send(
            `⚠️ Recruiter warning: you missed your quota in ${misses.length} of the last 3 weeks. `
            + `Last week: ${recruits7d}/${minReq}.${watchMsg} If you need help, DM a staffer.`
          ).catch(err => {
            void logUnexpectedError('scheduler.enforceQuotaWarnings.dm', err, { recruiterId });
          });
        }
      } catch (e) {
        void logUnexpectedError('scheduler.enforceQuotaWarnings.memberSend', e, { recruiterId });
      }
    }
  })();

  try {
    await quotaWarningsInFlight;
  } finally {
    quotaWarningsInFlight = null;
  }
}

function formatLeaderboardMessage(rows, regionLabel) {
  const teamName = regionLabel === 'GLOBAL' ? '🌍 Global' : getTeamLabel(regionLabel);

  if (!rows || rows.length === 0) return `# ${teamName} Leaderboard\nNo recruiters yet.`;
  const lines = rows.map((r, i) => {
    const name = r.recruiter_id ? `<@${r.recruiter_id}>` : (r.displayName || 'Unknown');
    const points = r.points || 0;
    const pointsText = points ? ` — ${formatPointsValue(points)} pts` : '';
    return `${i + 1}. ${name} — **${r.cnt}** recruits${pointsText}${r.systemWarning ? ' ⚠️**!**' : ''}`;
  });

  return `# ${teamName} Leaderboard\n\n` + lines.join('\n');
}

function trackScheduledJob(job) {
  if (job && typeof job.stop === 'function') {
    scheduledJobs.push(job);
  }
  return job;
}

function stop() {
  for (const job of scheduledJobs) {
    try {
      if (typeof job.stop === 'function') job.stop();
      if (typeof job.destroy === 'function') job.destroy();
    } catch (e) {
      console.error('Failed to stop scheduled job:', e);
    }
  }
  scheduledJobs = [];
}

async function recomputeLeaderboardsInternal(db, guild) {
  const regions = [
    { key: 'EU', channel: CHANNELS.INVITES_EU },
    { key: 'NA', channel: CHANNELS.INVITES_NA },
    { key: 'AS', channel: CHANNELS.INVITES_AS }
  ];
  const weekStart = getWeekStartUtcTs();
  const guildId = guild && guild.id ? guild.id : resolveGuildId();
  const { upsertLeaderboardMessage, makeLeaderboardText } = require('./lib/messages');
  let memberMap = new Map();
  let dbRecruiterIds = [];
  let hasDbRecruiters = false;
  try {
    const dbRecruiterRows = await db.all('SELECT id FROM recruiters WHERE guild_id = ?', guildId);
    dbRecruiterIds = (dbRecruiterRows || []).map(r => r.id).filter(Boolean);
    hasDbRecruiters = dbRecruiterIds.length > 0;
  } catch (e) {
    console.error('Failed to hydrate recruiter members for leaderboards', e);
  }

  const recruiterRolesForCache = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
  ].filter(Boolean);
  let cachedRecruiterCount = 0;
  if (guild && guild.roles && guild.roles.cache) {
    for (const roleId of recruiterRolesForCache) {
      const role = guild.roles.cache.get(roleId);
      if (role && role.members) cachedRecruiterCount += role.members.size;
    }
  }
  if (cachedRecruiterCount === 0 && recruiterRolesForCache.length) {
    await primeMemberCache(guild, 'recomputeLeaderboards', {
      force: FORCE_FULL_FETCH_ON_EMPTY && !hasDbRecruiters
    });
  }

  if (dbRecruiterIds.length) {
    try {
      memberMap = await fetchMembersByIds(guild, dbRecruiterIds);
    } catch (e) {
      console.error('Failed to hydrate recruiter members for leaderboards', e);
    }
  }

  for (const rg of regions) {
    debugLog(`Processing region ${rg.key}...`);
    debugLog(`Channel ID for ${rg.key}: ${rg.channel}`);

    const central = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
      ? guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD)
      : null;

    const allRecruiterIds = new Set();

    // Prefer role-based membership when guild roles are available.
    let recruiterRoleId = null;
    if (guild.roles && guild.roles.cache && typeof guild.roles.cache.get === 'function') {
      // Region membership rules:
      // - NA/AS: only members with that regional recruiter role
      // - EU: members with EU recruiter role
      recruiterRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[rg.key] ? RECRUITER_ROLE_IDS[rg.key] : null;
      const recruiterRole = recruiterRoleId ? guild.roles.cache.get(recruiterRoleId) : null;
      debugLog(`Recruiter role ID for ${rg.key}: ${recruiterRoleId}`);
      debugLog(`Recruiter role found: ${!!recruiterRole}`);

      if (recruiterRole && recruiterRole.members) recruiterRole.members.forEach(m => allRecruiterIds.add(m.id));
    }

    if (recruiterRoleId && memberMap && memberMap.size) {
      for (const member of memberMap.values()) {
        if (member.roles && member.roles.cache && member.roles.cache.has(recruiterRoleId)) {
          allRecruiterIds.add(member.id);
        }
      }
    }

    if (allRecruiterIds.size === 0) {
      // Test-mode / minimal guild mock: fall back to anyone who has recruited in this region in-window.
      const ids = await db.all(
        'SELECT DISTINCT recruiter_id FROM recruits WHERE guild_id = ? AND region = ? AND valid = 1 AND created_at >= ?',
        guildId,
        rg.key,
        weekStart
      );
      (ids || []).forEach(r => allRecruiterIds.add(r.recruiter_id));
    }

    debugLog(`Total recruiters found for ${rg.key}: ${allRecruiterIds.size}`);
    const lang = process.env.DEFAULT_LANG || 'en';
    let leaderboardText;

    const recruiterMembers = Array.from(allRecruiterIds);
    await seedRecruiters(db, recruiterMembers, `leaderboard:${rg.key}`, guildId);

    if (recruiterMembers.length === 0) {
      debugLog(`No recruiters found for region ${rg.key}`);
      leaderboardText = makeLeaderboardText([], rg.key, lang);
    }

    let rows = [];
    if (!leaderboardText) {
      const meta = await loadRecruiterMeta(db, recruiterMembers);
      const rowsBase = await fetchLeaderboardRows(db, recruiterMembers, { region: rg.key, weekStart, sinceTs: weekStart });
      const missingMinReqIds = rowsBase.filter(r => r.min_req == null).map(r => r.recruiter_id);
      const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart);

      const enriched = [];
      const statsWindow = { sinceTs: weekStart - (7 * 24 * 60 * 60 * 1000), untilTs: weekStart };

      // P-01: Batch isNewStaff AND 7-day stats lookups — replaces N sequential DB queries with bulk queries.
      const isNewStaffMap = await batchIsNewStaff(db, Array.from(allRecruiterIds), guildId).catch(() => new Map());
      const allStats7dMap = await batchCalculate7DayStats(db, Array.from(allRecruiterIds), guild, { ...statsWindow, guildId, region: rg.key }).catch(() => new Map());

      for (const r of (rowsBase || [])) {
        const absence = meta.absences.has(r.recruiter_id);
        const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;

        const staffMember = (memberMap && memberMap.get(r.recruiter_id))
          || (guild && guild.members && guild.members.cache ? guild.members.cache.get(r.recruiter_id) : null);
        const roleBase = getBaseRequirement(staffMember);
        // P-01: Look up from pre-fetched maps instead of awaiting per-recruiter DB queries.
        const newStaffCheck = isNewStaffMap.get(r.recruiter_id) ?? false;
        const stats7d = allStats7dMap.get(r.recruiter_id) || { recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 };

        const isTrialRecruiter = !!staffMember
          && staffMember.roles
          && staffMember.roles.cache
          && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)
          && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

        let minReq = Number.isFinite(r.min_req) ? Number(r.min_req) : null;
        let previousMinReq = null;
        if (minReq == null) {
          previousMinReq = prevMinReqMap.get(r.recruiter_id) ?? null;
          minReq = previousMinReq;
        }
        if (minReq == null) {
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

        const systemWarningRow = meta.systemWarnings.has(r.recruiter_id);

        enriched.push({
          ...r,
          recruits7d: Number(r.cnt || 0),
          minReq,
          absence: !!absence,
          systemWarning: !!systemWarningRow,
          activeWarnings,
          displayName: staffMember && staffMember.user
            ? `${staffMember.user.tag || staffMember.user.username} | ${getRegionInfo(rg.key).name || rg.key}`
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
      await upsertLeaderboardMessage(db, channel, rg.key, leaderboardText, null, guild.id);
    }
    if (central) {
      debugLog(`Cross-posting to central leaderboard for ${rg.key}...`);
      await upsertLeaderboardMessage(db, central, rg.key, leaderboardText, null, guild.id);
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
  const guildId = guild.id || resolveGuildId();
  const { upsertLeaderboardMessage, makeDemotionWatchText } = require('./lib/messages');
  const channel = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
    ? guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS)
    : null;
  if (!channel) return;

  try {
    const existing = await db.get(
      'SELECT id FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND region = ?',
      guildId,
      channel.id,
      'WARNINGS'
    );
    if (!existing) {
      const legacy = await db.get(
        'SELECT id FROM leaderboard_messages WHERE guild_id = ? AND channel_id = ? AND (region IS NULL OR region = "") ORDER BY id DESC LIMIT 1',
        guildId,
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
    'SELECT recruiter_id, COUNT(*) as cnt FROM warnings WHERE guild_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?) GROUP BY recruiter_id ORDER BY cnt DESC',
    guildId,
    Date.now()
  );
  const warningCountMap = new Map((warningRows || []).map(row => [row.recruiter_id, row.cnt]));

  const recruiterIdSet = new Set((warningRows || []).map((row) => row.recruiter_id).filter(Boolean));
  try {
    const recruiterRows = await db.all(
      'SELECT id FROM recruiters WHERE guild_id = ?',
      guildId
    );
    for (const row of recruiterRows || []) {
      if (row && row.id) recruiterIdSet.add(row.id);
    }
  } catch (e) {
    console.error('Failed to load recruiter profiles for warnings leaderboard:', e);
  }

  try {
    const recruitRows = await db.all(
      'SELECT DISTINCT recruiter_id FROM recruits WHERE guild_id = ?',
      guildId
    );
    for (const row of recruitRows || []) {
      if (row && row.recruiter_id) recruiterIdSet.add(row.recruiter_id);
    }
  } catch (e) {
    console.error('Failed to load recruit-derived recruiter IDs for warnings leaderboard:', e);
  }

  const recruiterRoleIds = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
  ].filter(Boolean);
  for (const roleId of recruiterRoleIds) {
    const role = guild.roles && guild.roles.cache ? guild.roles.cache.get(roleId) : null;
    if (!role || !role.members) continue;
    for (const member of role.members.values()) {
      recruiterIdSet.add(member.id);
    }
  }

  const recruiterIds = Array.from(recruiterIdSet);
  if (!recruiterIds.length) {
    const text = makeDemotionWatchText([]);
    await upsertLeaderboardMessage(db, channel, 'WARNINGS', text, null, guild.id);
    return;
  }

  const weekStart = getWeekStartUtcTs();
  const meta = await loadRecruiterMeta(db, recruiterIds, { guildId });
  const rowsBase = await fetchLeaderboardRows(db, recruiterIds, { guildId, weekStart, sinceTs: weekStart });
  const missingMinReqIds = rowsBase.filter(r => r.min_req == null).map(r => r.recruiter_id);
  const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart, { guildId });
  const memberMap = await fetchMembersByIds(guild, recruiterIds);

  const rows = [];
  const statsWindow = { sinceTs: weekStart, untilTs: Date.now() };

  // P-01: Batch isNewStaff AND 7-day stats lookups — replaces N sequential DB queries with bulk queries.
  const isNewStaffMap2 = await batchIsNewStaff(db, recruiterIds, guildId).catch(() => new Map());
  const allStats7dMap2 = await batchCalculate7DayStats(db, recruiterIds, guild, { ...statsWindow, guildId }).catch(() => new Map());

  for (const r of rowsBase || []) {
    const absence = meta.absences.has(r.recruiter_id);
    const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;

    const staffMember = (memberMap && memberMap.get(r.recruiter_id))
      || (guild && guild.members && guild.members.cache ? guild.members.cache.get(r.recruiter_id) : null);
    const roleBase = getBaseRequirement(staffMember);
    // P-01: Look up from pre-fetched map instead of awaiting a per-recruiter DB query.
    const newStaffCheck = isNewStaffMap2.get(r.recruiter_id) ?? false;
    const stats7d = allStats7dMap2.get(r.recruiter_id) || { recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 };

    const systemWarningRow = meta.systemWarnings.has(r.recruiter_id);

    const isTrialRecruiter = !!staffMember
      && staffMember.roles
      && staffMember.roles.cache
      && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)
      && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

    let minReq = Number.isFinite(r.min_req) ? Number(r.min_req) : null;
    let previousMinReq = null;
    if (minReq == null) {
      previousMinReq = prevMinReqMap.get(r.recruiter_id) ?? null;
      minReq = previousMinReq;
    }
    if (minReq == null) {
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
  await upsertLeaderboardMessage(db, channel, 'WARNINGS', text, null, guild.id);
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

// Trial recruiter auto-promotion is now handled in recruit-service.js.
// No extra reconciliation needed here.

async function runWeeklyMondayReset(db, client) {
  const guildId = resolveGuildId();
  const weekStart = getWeekStartUtcTs();
  const lockKey = `job_lock:weekly_monday_reset:${weekStart}`;
  const locked = await acquireSchedulerLock(db, {
    guildId,
    key: lockKey,
    ttlMs: 14 * ONE_DAY_MS,
    scope: 'scheduler.weeklyReset.lock'
  });
  if (!locked) return;

  const guild = await resolveGuild(client);
  if (!guild) return;

  try {
    // 1. Unified Recalculation (Stats -> History -> Recalcs -> DMs -> Point Reset)
    const results = await performWeeklyRecalculations(guild);
    
    // 2. Quota Warning Enforcement (Based on the newly persisted history)
    const recruiterIds = results.map(r => r.staffMember.id);
    const recruiters = recruiterIds.map(id => ({ id }));
    await enforceQuotaWarnings(db, guild, weekStart, recruiters);

    // 3. Leaderboard Refresh
    await recomputeLeaderboards(db, guild);
    await recomputeWarningsLeaderboard(db, guild);

    // 4. Persistence Marker (Catch-up prevention)
    const snapKey = `weekly_snapshot_${weekStart}`;
    await db.run(
      'INSERT OR REPLACE INTO system_events (guild_id, key, timestamp) VALUES (?, ?, ?)',
      guildId,
      snapKey,
      Date.now()
    );

    debugLog('Unified Monday Reset completed successfully');
  } catch (error) {
    logUnexpectedError('scheduler.runWeeklyMondayReset', error);
  }
}

function start(client, db) {
  stop();
  const guildId = resolveGuildId();
  if (guildId && !ownsGuild(client, guildId)) {
    console.log(`Scheduler disabled on this shard (guild ${guildId} not owned).`);
    return;
  }
  // scheduler.start() is called from index.js after the client is ready,
  // so don't wait for a second ready event here.
  (async () => {
    const guild = await resolveGuild(client);
    if (!guild) return;
    await reconcileTrialRecruiters(db, client).catch((e) => console.error('reconcileTrialRecruiters failed:', e));
    await recomputeLeaderboards(db, guild).catch((e) => console.error('recomputeLeaderboards failed:', e));
    await recomputeWarningsLeaderboard(db, guild).catch((e) => console.error('recomputeWarningsLeaderboard failed:', e));

    // Catch-up: if weekly snapshot was missed (bot offline at 00:05 UTC), run it once.
    // Sanity Window: Only catch up if we are within 24 hours of the scheduled time.
    // This prevents a Monday reset from triggering on a Sunday.
    try {
      const weekStart = getWeekStartUtcTs();
      const snapKey = `weekly_snapshot_${weekStart}`;
      const existing = await db.get('SELECT key FROM system_events WHERE guild_id = ? AND key = ?', guildId, snapKey);

      const now = Date.now();
      const sanityWindow = 24 * 60 * 60 * 1000; // 24 hours

      if (!existing && now >= weekStart && now < weekStart + sanityWindow) {
        debugLog(`Catch-up: Running missed weekly snapshot for ${formatUtcDate(weekStart)}`);
        await runWeeklyMondayReset(db, client);
      } else if (!existing && now >= weekStart + sanityWindow) {
        debugLog(`Catch-up skipped: Outside 24h sanity window for ${formatUtcDate(weekStart)}`);
      }
    } catch (e) {
      logUnexpectedError('scheduler.weeklySnapshotCatchup', e);
    }
  })();

  // Cron: Monday at 00:00 UTC - Unified Weekly Reset
  trackScheduledJob(cron.schedule('0 0 * * 1', async () => {
    await runWeeklyMondayReset(db, client);
  }, {
    scheduled: true,
    timezone: 'UTC'
  }));

  // Cron: Sunday at 12:00 UTC
  trackScheduledJob(cron.schedule('0 12 * * 0', async () => {
    const weekStart = getWeekStartUtcTs();
    const lockKey = `job_lock:weekly_membership_check:${weekStart}`;
    const locked = await acquireSchedulerLock(db, {
      guildId,
      key: lockKey,
      ttlMs: 14 * ONE_DAY_MS,
      scope: 'scheduler.weeklyMembershipCheck.lock'
    });
    if (!locked) return;

    const guild = await resolveGuild(client);
    if (!guild) return;

    // Recompute statistics, check for members who left and mark recruits invalid
    // Remove recruits where member left
    const recruits = await db.all('SELECT id, recruited_id FROM recruits WHERE guild_id = ? AND valid = 1', guild.id);
    const cached = guild.members && guild.members.cache ? guild.members.cache : null;
    const missingIds = [];
    const presentIds = new Set();
    for (const r of recruits) {
      if (cached && cached.get(r.recruited_id)) {
        presentIds.add(r.recruited_id);
      } else {
        missingIds.push(r.recruited_id);
      }
    }

    const fetchedMap = await fetchMembersByIds(guild, missingIds);
    for (const r of recruits) {
      if (presentIds.has(r.recruited_id)) continue;
      if (fetchedMap && fetchedMap.has(r.recruited_id)) continue;
      await db.run('UPDATE recruits SET valid = 0 WHERE guild_id = ? AND id = ?', guild.id, r.id).catch(err => {
        console.error('Failed to mark recruit invalid during weekly check:', err);
      });
    }

    await recomputeLeaderboards(db, guild).catch(err => {
      console.error('Failed to recompute leaderboards after weekly check:', err);
    });
  }, {
    scheduled: true,
    timezone: 'UTC'
  }));

  // Daily maintenance: expire warnings/multipliers and recompute warning counts
  trackScheduledJob(cron.schedule('0 0 * * *', async () => {
    const dayBucket = Math.floor(Date.now() / ONE_DAY_MS);
    const lockKey = `job_lock:daily_maintenance:${dayBucket}`;
    const locked = await acquireSchedulerLock(db, {
      guildId,
      key: lockKey,
      ttlMs: 2 * ONE_DAY_MS,
      scope: 'scheduler.dailyMaintenance.lock'
    });
    if (!locked) return;

    try {
      const schedulerGuildId = resolveGuildId();
      // remove expired multipliers (cleanup)
      await db.run('DELETE FROM multipliers WHERE guild_id = ? AND expires_at <= ?', schedulerGuildId, Date.now());

      // recompute warnings per recruiter (active = not revoked AND (expired_at IS NULL OR expired_at > now))
      // Audit Fix: Replaced N+1 loop with a single set-based UPDATE query.
      await db.run(`
        UPDATE recruiters 
        SET warnings = (
          SELECT COUNT(*) 
          FROM warnings w 
          WHERE w.guild_id = recruiters.guild_id 
          AND w.recruiter_id = recruiters.id 
          AND w.revoked = 0 
          AND (w.expired_at IS NULL OR w.expired_at > ?)
        )
        WHERE guild_id = ?
      `, Date.now(), schedulerGuildId);

      // Recompute leaderboards to reflect any changes
      const guild = await resolveGuild(client);
      if (guild) {
        await module.exports.recomputeLeaderboards(db, guild);
        await module.exports.recomputeWarningsLeaderboard(db, guild);
      }
    } catch (e) {
      logUnexpectedError('scheduler.dailyMaintenance', e);
    }
  }, {
    scheduled: true,
    timezone: 'UTC'
  }));

  // Hourly cleanup: expired invites
  trackScheduledJob(cron.schedule('0 * * * *', async () => {
    const hourBucket = Math.floor(Date.now() / ONE_HOUR_MS);
    const lockKey = `job_lock:hourly_invite_cleanup:${hourBucket}`;
    const locked = await acquireSchedulerLock(db, {
      guildId,
      key: lockKey,
      ttlMs: 2 * ONE_HOUR_MS,
      scope: 'scheduler.hourlyInviteCleanup.lock'
    });
    if (!locked) return;

    try {
      const inviteCommand = require('./commands/recruiting/invite');
      const inviteSystem = await inviteCommand.init();

      if (inviteSystem) {
        await inviteSystem.cleanupExpiredInvites();
        debugLog('Hourly invite cleanup completed');
      }
    } catch (error) {
      logUnexpectedError('scheduler.hourlyInviteCleanup', error);
    }
  }, {
    scheduled: true,
    timezone: 'UTC'
  }));

  // Monthly reset: 1st of month 00:00 UTC
  trackScheduledJob(cron.schedule('0 0 1 * *', async () => {
    const monthBucket = getUtcMonthBucket();
    const lockKey = `job_lock:monthly_maintenance:${monthBucket}`;
    const locked = await acquireSchedulerLock(db, {
      guildId,
      key: lockKey,
      ttlMs: 62 * ONE_DAY_MS,
      scope: 'scheduler.monthlyMaintenance.lock'
    });
    if (!locked) return;

    try {

      const guild = await resolveGuild(client);
      if (guild) {
        const ch = guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
        // if (ch) ch.send('Monthly recruiter points reset to 0.').catch(() => { });
        if (ch) {
          ch.send('Monthly stats maintenance complete. Points have been preserved.').catch(err => {
            console.error('Failed to post monthly maintenance message:', err);
          });
        }
      }
      const lockCutoff = Date.now() - (90 * ONE_DAY_MS);
      await db.run(
        'DELETE FROM system_events WHERE guild_id = ? AND key LIKE ? AND timestamp < ?',
        resolveGuildId(),
        'job_lock:%',
        lockCutoff
      ).catch(err => {
        console.error('Failed to prune old scheduler lock rows:', err);
      });
    } catch (e) { console.error('Monthly reset failed', e); }
  }, {
    scheduled: true,
    timezone: 'UTC'
  }));
}

module.exports = {
  getWeekStartUtcTs,
  start,
  stop,
  recomputeLeaderboards,
  recomputeWarningsLeaderboard
};

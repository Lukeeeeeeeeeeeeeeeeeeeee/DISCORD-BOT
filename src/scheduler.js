const cron = require('node-cron');
const { ShardClientUtil } = require('discord.js');
const { GUILD_ID, CHANNELS, RECRUITER_ROLE_IDS, ROLE_IDS } = require('./constants');
const { getRegionInfo, getTeamLabel } = require('./lib/regions');
const { formatPointsValue } = require('./lib/economy');
const { getWeekStartUtcTs, getRolling7DayStartTs } = require('./lib/week');
const { formatUtcDateOnly, formatUtcDate } = require('./lib/time');
const { fetchMembersByIds } = require('./lib/member-fetch');
const { fetchLeaderboardRows, loadRecruiterMeta, loadPreviousMinReqs, loadRecruiterIdsFromRecentRecruits } = require('./lib/leaderboard-utils');
const { upsertLeaderboardMessage, makeLeaderboardText, makeDemotionWatchText } = require('./lib/messages');
const { acquireJobLock } = require('./lib/job-locks');
const { withTransaction } = require('./lib/transactions');
const { changeRecruiterPoints } = require('./services/recruiting/ledger-service');

const { performWeeklyRecalculations } = require('./lib/weekly-recalculations');

const { calculate7DayStats, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('./lib/recruiting-system');

const DEBUG_SCHEDULER = process.env.DEBUG_SCHEDULER === '1';
const ALLOW_FULL_MEMBER_FETCH = (process.env.SCHEDULER_ALLOW_FULL_FETCH || process.env.ALLOW_FULL_MEMBER_FETCH || '').toLowerCase() === 'true';
const FORCE_FULL_FETCH_ON_EMPTY = (process.env.SCHEDULER_FORCE_FULL_FETCH_ON_EMPTY || 'false').toLowerCase() === 'true';
const MEMBER_CACHE_WARM_COOLDOWN_MS = Number.parseInt(process.env.MEMBER_CACHE_WARM_COOLDOWN_MS || '600000', 10);
const WARNING_ENFORCE_CONCURRENCY = Number.parseInt(process.env.WARNING_ENFORCE_CONCURRENCY || '3', 10);
const INVALID_RECRUIT_UPDATE_BATCH_SIZE = Number.parseInt(process.env.INVALID_RECRUIT_UPDATE_BATCH_SIZE || '150', 10);
const PENDING_RECRUIT_RECONCILE_AGE_MS = Number.parseInt(process.env.PENDING_RECRUIT_RECONCILE_AGE_MS || '300000', 10);
const PENDING_RECRUIT_RECONCILE_LIMIT = Number.parseInt(process.env.PENDING_RECRUIT_RECONCILE_LIMIT || '300', 10);
const PENDING_RECRUIT_RECONCILE_CONCURRENCY = Number.parseInt(process.env.PENDING_RECRUIT_RECONCILE_CONCURRENCY || '3', 10);
const LEADERBOARD_REGION_CONCURRENCY = Number.parseInt(process.env.LEADERBOARD_REGION_CONCURRENCY || '2', 10);
const WEEKLY_CALCULATIONS_RETENTION_DAYS = Number.parseInt(process.env.WEEKLY_CALCULATIONS_RETENTION_DAYS || '180', 10);
const LEDGER_RETENTION_DAYS = Number.parseInt(process.env.RECRUITER_LEDGER_RETENTION_DAYS || '365', 10);
const PURCHASE_RETENTION_DAYS = Number.parseInt(process.env.PURCHASE_RETENTION_DAYS || '365', 10);
let lastMemberCacheWarmAt = 0;

function debugLog(...args) {
  if (DEBUG_SCHEDULER) console.log(...args);
}

const SNAPSHOT_CONCURRENCY = Number.parseInt(process.env.SNAPSHOT_CONCURRENCY || '3', 10);

const { runWithConcurrency } = require('./lib/concurrency');
const { initWithDb: initInviteSystem } = require('./services/recruiting/invite-service');

async function ensureWeeklyCalculationsTable(_db) {
  // Schema creation is centralized in db_async.js.
}

async function ensureRecruitsTable(_db) {
  // Schema creation is centralized in db_async.js.
}

async function seedRecruiters(db, ids, contextLabel, guildIdOverride) {
  if (!db || !ids || !ids.length) return;
  try {
    const guildId = guildIdOverride || resolveGuildId();
    const uniqueIds = Array.from(new Set(ids.filter(Boolean)));
    const batchSize = 200;
    for (let i = 0; i < uniqueIds.length; i += batchSize) {
      const batch = uniqueIds.slice(i, i + batchSize);
      const values = batch.map(() => '(?, ?, 0, 0, 0, 4)').join(', ');
      const params = [];
      for (const id of batch) {
        params.push(guildId, id);
      }
      await db.run(
        `INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES ${values}`,
        ...params
      );
    }
  } catch (e) {
    console.error('Failed to seed recruiters', { context: contextLabel, error: e });
  }
}

function resolveGuildId(guild) {
  return process.env.GUILD_ID || GUILD_ID || (guild && guild.id) || 'GLOBAL';
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
  if (!force && !ALLOW_FULL_MEMBER_FETCH) return false;
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

async function cleanupLeaderboardGhostPointers(db, guild) {
  if (!db || !guild || !guild.id) return { removed: 0 };
  let removed = 0;
  try {
    const rows = await db.all(
      'SELECT id, channel_id, message_id FROM leaderboard_messages WHERE guild_id = ?',
      guild.id
    );
    for (const row of rows || []) {
      if (!row || !row.id || !row.channel_id || !row.message_id) continue;
      let channel = guild.channels.cache.get(row.channel_id) || null;
      if (!channel && guild.channels && typeof guild.channels.fetch === 'function') {
        channel = await guild.channels.fetch(row.channel_id).catch(() => null);
      }
      if (!channel || !channel.messages || typeof channel.messages.fetch !== 'function') {
        await db.run('DELETE FROM leaderboard_messages WHERE id = ?', row.id);
        removed++;
        continue;
      }
      const msg = await channel.messages.fetch(row.message_id).catch(() => null);
      if (!msg) {
        await db.run('DELETE FROM leaderboard_messages WHERE id = ?', row.id);
        removed++;
      }
    }
  } catch (e) {
    console.error('Failed to clean leaderboard ghost pointers:', e);
  }
  return { removed };
}

async function cleanupRetentionData(db, guildId) {
  if (!db || !guildId) return;
  const now = Date.now();
  const weeklyCutoff = now - (Math.max(1, WEEKLY_CALCULATIONS_RETENTION_DAYS) * 24 * 60 * 60 * 1000);
  const ledgerCutoff = now - (Math.max(1, LEDGER_RETENTION_DAYS) * 24 * 60 * 60 * 1000);
  const purchasesCutoff = now - (Math.max(1, PURCHASE_RETENTION_DAYS) * 24 * 60 * 60 * 1000);

  await db.run('DELETE FROM weekly_calculations WHERE guild_id = ? AND week_start < ?', guildId, weeklyCutoff).catch(() => {});
  await db.run('DELETE FROM recruiter_points_ledger WHERE guild_id = ? AND created_at < ?', guildId, ledgerCutoff).catch(() => {});
  await db.run('DELETE FROM purchases WHERE guild_id = ? AND created_at < ?', guildId, purchasesCutoff).catch(() => {});
}

async function resolveAllRecruiterIds(guild, db) {
  if (!guild) return [];
  const guildId = resolveGuildId(guild);
  const staffRoleIds = Array.isArray(ROLE_IDS.STAFF) && ROLE_IDS.STAFF.length
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

async function enforceQuotaWarnings(db, guild, weekStart, recruiters) {
  if (!db || !guild || !weekStart || !recruiters) return;
  const guildId = resolveGuildId(guild);
  const warningChannel = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
    ? guild.channels.cache.get(CHANNELS.INVITES_OVERALL)
    : null;
  const safeConcurrency = Number.isFinite(WARNING_ENFORCE_CONCURRENCY) && WARNING_ENFORCE_CONCURRENCY > 0
    ? WARNING_ENFORCE_CONCURRENCY
    : 3;

  const results = await runWithConcurrency(recruiters, safeConcurrency, async (recruiter) => {
    const recruiterId = recruiter.id;
    const snapshots = await db.all(
      'SELECT week_start, recruits7d, calculated_min_req, previous_min_req, absent FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT 3',
      guildId,
      recruiterId
    );

    if (!snapshots || snapshots.length < 3) {
      return { ok: true, skipped: true };
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
      return { ok: true, skipped: true };
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
      'SELECT id FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND note = ? LIMIT 1',
      guildId,
      recruiterId,
      note
    );
    if (existing) return { ok: true, skipped: true };

    await db.run(
      'INSERT INTO warnings (guild_id, recruiter_id, created_at, note, expired_at, revoked) VALUES (?, ?, ?, ?, NULL, 0)',
      guildId,
      recruiterId,
      Date.now(),
      note
    );
    await db.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', guildId, recruiterId);
    await db.run('UPDATE recruiters SET warnings = warnings + 1 WHERE guild_id = ? AND id = ?', guildId, recruiterId);

    const warningCountRow = await db.get(
      'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
      guildId,
      recruiterId,
      Date.now()
    );
    const activeWarnings = warningCountRow ? warningCountRow.c : 0;
    const demotionTag = activeWarnings >= 2 ? ' They are now on demotion watch.' : '';

    if (warningChannel && typeof warningChannel.send === 'function') {
      await warningChannel.send(`[WARN] <@${recruiterId}> missed quota in ${misses.length} of the last 3 weeks (${recruits7d}/${minReq}). Warning issued.${demotionTag}`).catch(err => {
        console.error('Failed to post quota warning:', err);
      });
    }

    try {
      const member = await guild.members.fetch(recruiterId).catch(() => null);
      if (member) {
        const watchMsg = activeWarnings >= 2 ? ' You are now on demotion watch.' : '';
        await member.send(
          `⚠️ Recruiter warning: you missed your quota in ${misses.length} of the last 3 weeks. `
          + `Last week: ${recruits7d}/${minReq}.${watchMsg} If you need help, DM a staffer.`
        ).catch(err => {
          console.error('Failed to DM recruiter warning:', err);
        });
      }
    } catch (e) {
      console.error('Failed to DM auto-warning recruiter', { recruiterId, error: e });
    }
    return { ok: true };
  });

  for (const entry of results) {
    if (entry && entry.ok === false && entry.error) {
      console.error('Quota warning enforcement failed for recruiter:', entry.error);
    }
  }
}

async function markRecruitsInvalidInBatches(db, guildId, recruitIds) {
  if (!db || !guildId || !Array.isArray(recruitIds) || recruitIds.length === 0) return;
  const chunkSize = Number.isFinite(INVALID_RECRUIT_UPDATE_BATCH_SIZE) && INVALID_RECRUIT_UPDATE_BATCH_SIZE > 0
    ? INVALID_RECRUIT_UPDATE_BATCH_SIZE
    : 150;
  for (let i = 0; i < recruitIds.length; i += chunkSize) {
    const chunk = recruitIds.slice(i, i + chunkSize);
    if (!chunk.length) continue;
    const placeholders = chunk.map(() => '?').join(', ');
    await db.run(
      `UPDATE recruits SET valid = 0 WHERE guild_id = ? AND id IN (${placeholders})`,
      guildId,
      ...chunk
    );
  }
}

async function reconcilePendingRecruits(db, guild, opts = {}) {
  if (!db || !guild) return { scanned: 0, finalized: 0, removed: 0 };

  const guildId = resolveGuildId(guild);
  const ageMsRaw = Number.isFinite(opts.ageMs) ? opts.ageMs : PENDING_RECRUIT_RECONCILE_AGE_MS;
  const ageMs = Math.max(0, ageMsRaw);
  const limitRaw = Number.isFinite(opts.limit) ? opts.limit : PENDING_RECRUIT_RECONCILE_LIMIT;
  const limit = Math.max(1, Math.floor(limitRaw));
  const concurrencyRaw = Number.isFinite(opts.concurrency) ? opts.concurrency : PENDING_RECRUIT_RECONCILE_CONCURRENCY;
  const concurrency = Math.max(1, Math.floor(concurrencyRaw));
  const cutoffTs = Date.now() - ageMs;
  const rookieRoleId = ROLE_IDS && ROLE_IDS.ROOKIE ? ROLE_IDS.ROOKIE : null;
  if (!rookieRoleId) {
    console.warn('Pending recruit reconciliation skipped: ROLE_IDS.ROOKIE is not configured.');
    return { scanned: 0, finalized: 0, removed: 0 };
  }

  let pendingRows = [];
  try {
    pendingRows = await db.all(
      `SELECT id, recruiter_id, recruited_id, points, created_at
       FROM recruits
       WHERE guild_id = ? AND valid = 0 AND created_at <= ?
       ORDER BY created_at ASC
       LIMIT ?`,
      guildId,
      cutoffTs,
      limit
    );
  } catch (e) {
    console.error('Failed to load pending recruits for reconciliation:', e);
    return { scanned: 0, finalized: 0, removed: 0 };
  }

  if (!pendingRows.length) return { scanned: 0, finalized: 0, removed: 0 };

  let memberMap = new Map();
  try {
    memberMap = await fetchMembersByIds(guild, pendingRows.map(r => r.recruited_id));
  } catch (e) {
    console.error('Failed to fetch pending recruit members during reconciliation:', e);
    memberMap = new Map();
  }

  let finalized = 0;
  let removed = 0;

  await runWithConcurrency(pendingRows, concurrency, async (row) => {
    const member = memberMap && typeof memberMap.get === 'function' ? memberMap.get(row.recruited_id) : null;
    const hasRookieRole = !!(
      rookieRoleId
      && member
      && member.roles
      && member.roles.cache
      && typeof member.roles.cache.has === 'function'
      && member.roles.cache.has(rookieRoleId)
    );

    if (!hasRookieRole) {
      await db.run(
        'DELETE FROM recruits WHERE guild_id = ? AND id = ? AND valid = 0',
        guildId,
        row.id
      );
      removed += 1;
      return { ok: true };
    }

    await withTransaction(db, async (tx) => {
      const current = await tx.get(
        'SELECT id, valid FROM recruits WHERE guild_id = ? AND id = ?',
        guildId,
        row.id
      );
      if (!current || Number(current.valid) !== 0) return;

      const existingLedger = await tx.get(
        `SELECT id FROM recruiter_points_ledger
         WHERE guild_id = ?
           AND recruiter_id = ?
           AND reason = ?
           AND ref_type = ?
           AND ref_id = ?
         LIMIT 1`,
        guildId,
        row.recruiter_id,
        'recruit_award',
        'recruit',
        String(row.id)
      );

      if (!existingLedger) {
        const pointsDelta = Number.isFinite(Number(row.points)) ? Number(row.points) : 0;
        await changeRecruiterPoints(tx, {
          guildId,
          recruiterId: row.recruiter_id,
          delta: pointsDelta,
          reason: 'recruit_award',
          refType: 'recruit',
          refId: String(row.id),
          minPoints: 0
        });
      }

      await tx.run(
        'UPDATE recruits SET valid = 1 WHERE guild_id = ? AND id = ?',
        guildId,
        row.id
      );
    });

    finalized += 1;
    return { ok: true };
  });

  if (finalized > 0 || removed > 0) {
    console.log('Pending recruit reconciliation complete', {
      guildId,
      scanned: pendingRows.length,
      finalized,
      removed
    });
  }

  return {
    scanned: pendingRows.length,
    finalized,
    removed
  };
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

let leaderboardsInFlight = null;
let warningsInFlight = null;

async function recomputeLeaderboardsInternal(db, guild) {
  await ensureWeeklyCalculationsTable(db).catch(err => {
    console.error('Failed to ensure weekly calculations table:', err);
  });
  await ensureRecruitsTable(db).catch(err => {
    console.error('Failed to ensure recruits table:', err);
  });
  const guildId = resolveGuildId(guild);
  const regions = [
    { key: 'EU', channel: CHANNELS.INVITES_EU },
    { key: 'NA', channel: CHANNELS.INVITES_NA },
    { key: 'AS', channel: CHANNELS.INVITES_AS }
  ];
  const weekStart = getWeekStartUtcTs();
  // Use weekStart for leaderboard time window so it resets every Monday
  // This shows recruits from Monday 00:00 UTC until now, not a rolling 7-day window
  const leaderboardWindowStart = weekStart;
  
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
    console.log('⚠️ No recruiters in cache, fetching all guild members...');
    await primeMemberCache(guild, 'recomputeLeaderboards', {
      force: FORCE_FULL_FETCH_ON_EMPTY || true  // Always fetch if no recruiters cached
    });
    
    // Re-check cached count after fetch
    cachedRecruiterCount = 0;
    if (guild && guild.roles && guild.roles.cache) {
      for (const roleId of recruiterRolesForCache) {
        const role = guild.roles.cache.get(roleId);
        if (role && role.members) cachedRecruiterCount += role.members.size;
      }
    }
    console.log(`✓ After fetch: ${cachedRecruiterCount} recruiters in cache`);
  }

  if (dbRecruiterIds.length) {
    try {
      memberMap = await fetchMembersByIds(guild, dbRecruiterIds);
    } catch (e) {
      console.error('Failed to hydrate recruiter members for leaderboards', e);
    }
  }

  const processRegion = async (rg) => {
    debugLog(`Processing region ${rg.key}...`);
    debugLog(`Channel ID for ${rg.key}: ${rg.channel}`);

    const central = guild.channels && guild.channels.cache && typeof guild.channels.cache.get === 'function'
      ? guild.channels.cache.get(CHANNELS.CENTRAL_LEADERBOARD)
      : null;

    const allRecruiterIds = new Set();

    // Prefer role-based membership when guild roles are available.
    let recruiterRoleId = null;
    let foundRoleMembers = false;
    
    if (guild.roles && guild.roles.cache && typeof guild.roles.cache.get === 'function') {
      // Region membership rules:
      // - NA/AS: only members with that regional recruiter role
      // - EU: members with EU recruiter role
      recruiterRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[rg.key] ? RECRUITER_ROLE_IDS[rg.key] : null;
      const recruiterRole = recruiterRoleId ? guild.roles.cache.get(recruiterRoleId) : null;
      debugLog(`Recruiter role ID for ${rg.key}: ${recruiterRoleId}`);
      debugLog(`Recruiter role found: ${!!recruiterRole}`);

      if (recruiterRole && recruiterRole.members) {
        recruiterRole.members.forEach(m => allRecruiterIds.add(m.id));
        foundRoleMembers = true;
      }
    }

    if (recruiterRoleId && memberMap && memberMap.size) {
      for (const member of memberMap.values()) {
        if (member.roles && member.roles.cache && member.roles.cache.has(recruiterRoleId)) {
          allRecruiterIds.add(member.id);
          foundRoleMembers = true;
        }
      }
    }

    // CRITICAL FIX: Do NOT add recruiters based on their recruit history!
    // Only use role membership to determine who belongs in each leaderboard.
    // This prevents:
    // 1. People from showing in wrong leaderboards just because they made recruits in a different region
    // 2. Users who left the server from still appearing in leaderboards
    //
    // The fallback ONLY applies if we genuinely have no role-based members (test/dev environments).
    // If we found ANY role members, we skip the fallback entirely.

    if (!foundRoleMembers && allRecruiterIds.size === 0) {
      // Test-mode / minimal guild mock: fall back to anyone who has recruited in this region in-window.
      // This should only happen in test/dev environments with no roles configured.
      debugLog(`WARNING: No role members found for ${rg.key}, falling back to recruit history`);
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
      const meta = await loadRecruiterMeta(db, recruiterMembers, { guildId });
      const rowsBase = await fetchLeaderboardRows(db, recruiterMembers, { region: rg.key, weekStart, sinceTs: leaderboardWindowStart, guildId });
      
      // rowsBase already filtered by region in the SQL query, no additional filtering needed
      const rowsFiltered = rowsBase;
      
      const missingMinReqIds = rowsFiltered.filter(r => r.min_req == null).map(r => r.recruiter_id);
      const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart, { guildId });

      const enriched = [];
      const statsWindow = { sinceTs: leaderboardWindowStart, untilTs: Date.now() };
      const enrichedResults = await runWithConcurrency(rowsFiltered || [], SNAPSHOT_CONCURRENCY, async (r) => {
        const absence = meta.absences.has(r.recruiter_id);
        const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;

        const staffMember = (memberMap && memberMap.get(r.recruiter_id))
          || (guild && guild.members && guild.members.cache ? guild.members.cache.get(r.recruiter_id) : null);
        const roleBase = getBaseRequirement(staffMember);
        const newStaffCheck = await isNewStaff(db, r.recruiter_id, { guildId }).catch(() => false);

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
          const stats7d = await calculate7DayStats(db, r.recruiter_id, guild, { ...statsWindow, guildId }).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
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
        return {
          ok: true,
          row: {
            ...r,
            recruits7d: Number(r.cnt || 0),
            minReq,
            absence: !!absence,
            systemWarning: !!systemWarningRow,
            activeWarnings,
            // FIXED: Always use proper Discord mentions instead of display names
            displayName: null
          }
        };
      });

      for (const entry of enrichedResults) {
        if (!entry) continue;
        if (entry.ok === false && entry.error) {
          console.error('Leaderboard enrichment failed:', entry.error);
          continue;
        }
        if (entry.row) enriched.push(entry.row);
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
    return { ok: true };
  };

  const regionResults = await runWithConcurrency(
    regions,
    Number.isFinite(LEADERBOARD_REGION_CONCURRENCY) && LEADERBOARD_REGION_CONCURRENCY > 0
      ? LEADERBOARD_REGION_CONCURRENCY
      : 2,
    processRegion
  );

  for (const entry of regionResults) {
    if (!entry) continue;
    if (entry.ok === false && entry.error) {
      console.error('Leaderboard region recompute failed:', entry.error);
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
  const guildId = resolveGuildId(guild);
  await ensureWeeklyCalculationsTable(db).catch(err => {
    console.error('Failed to ensure weekly calculations table:', err);
  });
  await ensureRecruitsTable(db).catch(err => {
    console.error('Failed to ensure recruits table:', err);
  });
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
    'SELECT recruiter_id, COUNT(*) as cnt FROM warnings WHERE guild_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?) GROUP BY recruiter_id HAVING cnt >= 2 ORDER BY cnt DESC',
    guildId,
    Date.now()
  );
  const warningCountMap = new Map((warningRows || []).map(row => [row.recruiter_id, row.cnt]));

  const recruiterIds = (warningRows || []).map(r => r.recruiter_id);
  if (!recruiterIds.length) {
    const text = makeDemotionWatchText([]);
    await upsertLeaderboardMessage(db, channel, 'WARNINGS', text, null, guild.id);
    return;
  }

  const weekStart = getWeekStartUtcTs();
  // Use weekStart for warnings leaderboard so it shows current week data
  const leaderboardWindowStart = weekStart;
  const meta = await loadRecruiterMeta(db, recruiterIds, { guildId });
  const rowsBase = await fetchLeaderboardRows(db, recruiterIds, { weekStart, sinceTs: leaderboardWindowStart, guildId });
  const missingMinReqIds = rowsBase.filter(r => r.min_req == null).map(r => r.recruiter_id);
  const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart, { guildId });
  const memberMap = await fetchMembersByIds(guild, recruiterIds);

  const rows = [];
  const statsWindow = { sinceTs: leaderboardWindowStart, untilTs: Date.now() };
  const warningRowsEnriched = await runWithConcurrency(rowsBase || [], SNAPSHOT_CONCURRENCY, async (r) => {
    const absence = meta.absences.has(r.recruiter_id);
    const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;
    if (activeWarnings < 2) return { ok: true, row: null };

    const staffMember = (memberMap && memberMap.get(r.recruiter_id))
      || (guild && guild.members && guild.members.cache ? guild.members.cache.get(r.recruiter_id) : null);
    const roleBase = getBaseRequirement(staffMember);
    const newStaffCheck = await isNewStaff(db, r.recruiter_id, { guildId }).catch(() => false);

    const systemWarningRow = meta.systemWarnings.has(r.recruiter_id);
    const isTrialRecruiter = !!staffMember && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

    let minReq = Number.isFinite(r.min_req) ? Number(r.min_req) : null;
    let previousMinReq = null;
    if (minReq == null) {
      previousMinReq = prevMinReqMap.get(r.recruiter_id) ?? null;
      minReq = previousMinReq;
    }
    if (minReq == null) {
      const stats7d = await calculate7DayStats(db, r.recruiter_id, guild, { ...statsWindow, guildId }).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
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
    return {
      ok: true,
      row: {
        ...r,
        recruits7d: Number(r.cnt || 0),
        minReq,
        absence: !!absence,
        systemWarning: !!systemWarningRow,
        activeWarnings,
        warningCount
      }
    };
  });

  for (const entry of warningRowsEnriched) {
    if (!entry) continue;
    if (entry.ok === false && entry.error) {
      console.error('Warnings leaderboard enrichment failed:', entry.error);
      continue;
    }
    if (entry.row) rows.push(entry.row);
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

async function reconcileTrialRecruiters(_db, _client) {
  // Intentionally disabled/handled elsewhere.
}

async function runWeeklySnapshotAndReset(db, client, options = {}) {
  const { announce = true } = options || {};
  debugLog('Starting weekly MinReq and stats reset...');
  try {
    const weekStart = getWeekStartUtcTs();
    const weekStartIso = formatUtcDateOnly(weekStart);
    const guild = await resolveGuild(client);
    const guildId = resolveGuildId(guild);

    const lockKey = `weekly_snapshot_lock_${weekStart}`;
    const lockOk = await acquireJobLock(db, {
      guildId,
      key: lockKey,
      ttlMs: 2 * 60 * 60 * 1000,
      failOpen: false
    });
    if (!lockOk) {
      debugLog('Weekly snapshot skipped; lock already held.');
      return;
    }

    // One-time announcement per week in the overall invites channel (scheduled runs only)
    if (announce) {
      try {
        const announceKey = `weekly_reset_announce_${weekStart}`;
        const existing = await db.get('SELECT key FROM system_events WHERE guild_id = ? AND key = ?', guildId, announceKey);
        if (!existing) {
          await db.run('INSERT OR REPLACE INTO system_events (guild_id, key, "timestamp") VALUES (?, ?, ?)', guildId, announceKey, Date.now());
          const ch = guild ? guild.channels.cache.get(CHANNELS.INVITES_OVERALL) : null;
          if (ch) {
            await ch.send(`@everyone Weekly invite/recruit snapshot captured (week start ${weekStartIso} UTC).`).catch(err => {
              console.error('Failed to post weekly snapshot announcement:', err);
            });
          }
        }
      } catch (e) {
        console.error('Weekly reset announcement failed:', e);
      }
    }

    const cacheReady = guild ? await primeMemberCache(guild, 'weekly_snapshot') : false;
    let recruiterIds = guild ? await resolveAllRecruiterIds(guild, db) : [];
    if (!recruiterIds.length) {
      const rows = await db.all('SELECT id FROM recruiters WHERE guild_id = ?', guildId);
      recruiterIds = (rows || []).map(r => r.id);
    }
    const recruiters = Array.from(new Set(recruiterIds)).map(id => ({ id }));
    const lastWeekStart = weekStart - (7 * 24 * 60 * 60 * 1000);
    const statsWindow = { sinceTs: lastWeekStart, untilTs: weekStart };
    await seedRecruiters(db, recruiters.map(r => r.id), 'weekly_snapshot', guildId);

    const calcResults = await runWithConcurrency(recruiters, SNAPSHOT_CONCURRENCY, async (recruiter) => {
      const currentStats = await calculate7DayStats(db, recruiter.id, guild || null, { ...statsWindow, guildId });
      const prevMinRow = await db.get(
        'SELECT calculated_min_req FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? AND week_start < ? ORDER BY week_start DESC LIMIT 1',
        guildId,
        recruiter.id,
        weekStart
      );
      const previousMinReq = prevMinRow ? prevMinRow.calculated_min_req : null;

      let newStaffCheck = false;
      try {
        newStaffCheck = await isNewStaff(db, recruiter.id, { guildId });
      } catch (e) {
        newStaffCheck = false;
      }

      const warnings = await db.get(
        'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
        guildId,
        recruiter.id,
        Date.now()
      );
      const activeWarnings = warnings ? warnings.c : 0;

      const absence = await db.get(
        'SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ? AND active = 1 AND end_date >= date("now")',
        guildId,
        recruiter.id
      );

      const staffMember = guild && cacheReady && guild.members && guild.members.cache
        ? guild.members.cache.get(recruiter.id)
        : (guild && guild.members && typeof guild.members.fetch === 'function' ? await guild.members.fetch(recruiter.id).catch(() => null) : null);
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
        guildId,
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
      return { ok: true };
    });

    for (const entry of calcResults) {
      if (entry && entry.ok === false && entry.error) {
        console.error('Weekly snapshot calculation failed:', entry.error);
      }
    }

    try {
      if (guild) {
        await enforceQuotaWarnings(db, guild, weekStart, recruiters);
        await recomputeWarningsLeaderboard(db, guild).catch(err => {
          console.error('Failed to recompute warnings leaderboard:', err);
        });
      }
    } catch (e) {
      console.error('Quota warning enforcement failed:', e);
    }

    // Mark weekly snapshot complete so we can catch up if the bot was down
    try {
      const snapKey = `weekly_snapshot_${weekStart}`;
      await db.run('INSERT OR REPLACE INTO system_events (guild_id, key, timestamp) VALUES (?, ?, ?)', guildId, snapKey, Date.now());
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
  const guildId = resolveGuildId();
  if (!guildId || guildId === 'GLOBAL') {
    console.warn('Scheduler disabled: GUILD_ID is not configured.');
    return;
  }
  if (guildId && !ownsGuild(client, guildId)) {
    console.log(`Scheduler disabled on this shard (guild ${guildId} not owned).`);
    return;
  }
  // scheduler.start() is called from index.js after the client is ready,
  // so don't wait for a second ready event here.
  (async () => {
    const guild = await resolveGuild(client);
    if (!guild) return;
    await reconcilePendingRecruits(db, guild).catch((e) => console.error('reconcilePendingRecruits failed:', e));
    await reconcileTrialRecruiters(db, client).catch((e) => console.error('reconcileTrialRecruiters failed:', e));
    // Temporarily disabled until 2026-08-09 to prevent leaderboard spam during fixes
    const now = new Date();
    // FIXED: Re-enable leaderboard recompute (was skipped until Aug 9)
    await recomputeLeaderboards(db, guild).catch((e) => console.error('recomputeLeaderboards failed:', e));

    // Catch-up: if weekly snapshot was missed (bot offline at 00:05 UTC), run it once.
    // Only catch up if we're within 6 hours of the scheduled time (00:05 Monday UTC)
    // This prevents Wednesday restarts from triggering Monday resets
    try {
      const weekStart = getWeekStartUtcTs();
      const snapKey = `weekly_snapshot_${weekStart}`;
      const guildId = resolveGuildId(guild);
      const existing = await db.get('SELECT key FROM system_events WHERE guild_id = ? AND key = ?', guildId, snapKey);

      const now = Date.now();
      const scheduledResetTime = weekStart + (5 * 60 * 1000); // Monday 00:05 UTC
      const timeSinceScheduled = now - scheduledResetTime;
      const catchupWindow = 6 * 60 * 60 * 1000; // 6 hours (not 24!)

      // Only catch up if:
      // 1. Reset hasn't run yet (!existing)
      // 2. We're past the scheduled time (timeSinceScheduled > 0)
      // 3. We're within 6 hours of scheduled time (timeSinceScheduled < catchupWindow)
      if (!existing && timeSinceScheduled > 0 && timeSinceScheduled < catchupWindow) {
        debugLog(`Catch-up: Running missed weekly snapshot for ${formatUtcDate(weekStart)} (${Math.round(timeSinceScheduled/60000)}m late)`);
        await runWeeklySnapshotAndReset(db, client, { announce: false });
      } else if (!existing && timeSinceScheduled >= catchupWindow) {
        debugLog(`Catch-up skipped: Too late (${Math.round(timeSinceScheduled/3600000)}h past scheduled time). Wait for next Monday.`);
      }
    } catch (e) {
      console.error('Weekly snapshot catch-up check failed:', e);
    }
  })();

  // Cron: Monday at 00:00 UTC - Weekly recruiter recalculation
  cron.schedule('0 0 * * 1', async () => {
    console.log(`[CRON] Weekly recalculation triggered at ${new Date().toISOString()}`);
    const guild = await resolveGuild(client);
    if (!guild) return;
    try {
      const weekStart = getWeekStartUtcTs();
      const lockKey = `weekly_recalc_lock_${weekStart}`;
      const lockOk = await acquireJobLock(db, {
        guildId: resolveGuildId(guild),
        key: lockKey,
        ttlMs: 2 * 60 * 60 * 1000,
        failOpen: false
      });
      if (!lockOk) {
        debugLog('Weekly recalculation skipped; lock already held.');
        return;
      }
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
    console.log(`[CRON] Weekly snapshot triggered at ${new Date().toISOString()}`);
    await runWeeklySnapshotAndReset(db, client);
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  // Cron: Sunday at 12:00 UTC
  cron.schedule('0 12 * * 0', async () => {
    const guild = await resolveGuild(client);
    if (!guild) return;
    const guildId = resolveGuildId(guild);

    // Recompute statistics, check for members who left and mark recruits invalid
    // Remove recruits where member left
    const recruits = await db.all('SELECT id, recruited_id FROM recruits WHERE guild_id = ? AND valid = 1', guildId);
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
    const invalidRecruitIds = [];
    for (const r of recruits) {
      if (presentIds.has(r.recruited_id)) continue;
      if (fetchedMap && fetchedMap.has(r.recruited_id)) continue;
      invalidRecruitIds.push(r.id);
    }

    if (invalidRecruitIds.length) {
      try {
        await markRecruitsInvalidInBatches(db, guildId, invalidRecruitIds);
      } catch (err) {
        console.error('Failed to mark recruits invalid during weekly check:', err);
      }
    }

    await recomputeLeaderboards(db, guild).catch(err => {
      console.error('Failed to recompute leaderboards after weekly check:', err);
    });
  }, {
    scheduled: true,
    timezone: 'UTC'
  });

  // Daily maintenance: expire warnings/multipliers and recompute warning counts
  cron.schedule('0 0 * * *', async () => {
    try {
      // remove expired multipliers (cleanup)
      await db.run('DELETE FROM multipliers WHERE expires_at <= ?', Date.now());

      const inviteSnapshotTtlMs = Number.parseInt(process.env.INVITE_SNAPSHOT_TTL_MS || '900000', 10);
      if (Number.isFinite(inviteSnapshotTtlMs) && inviteSnapshotTtlMs > 0) {
        const cutoff = Date.now() - inviteSnapshotTtlMs;
        await db.run('DELETE FROM invite_snapshots WHERE updated_at < ?', cutoff);
      }

      // recompute warnings per recruiter (active = not revoked AND (expired_at IS NULL OR expired_at > now))
      const guild = await resolveGuild(client);
      const guildId = resolveGuildId(guild);
      await cleanupRetentionData(db, guildId);
      await db.run(
        `UPDATE recruiters
         SET warnings = (
           SELECT COUNT(*)
           FROM warnings w
           WHERE w.guild_id = recruiters.guild_id
             AND w.recruiter_id = recruiters.id
             AND w.revoked = 0
             AND (w.expired_at IS NULL OR w.expired_at > ?)
         )
         WHERE guild_id = ?`,
        Date.now(),
        guildId
      );

      if (guild) {
        const pointerCleanup = await cleanupLeaderboardGhostPointers(db, guild);
        if (pointerCleanup.removed > 0) {
          console.log(`Removed ${pointerCleanup.removed} stale leaderboard pointers.`);
        }
      }

      // Recompute leaderboards to reflect any changes
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
      const guild = await resolveGuild(client);
      const guildId = resolveGuildId(guild);
      const inviteSystem = await initInviteSystem(guildId, db);

      if (inviteSystem) {
        await inviteSystem.cleanupExpiredInvites(guildId);
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
        if (ch) {
          ch.send('Monthly stats maintenance complete. Points have been preserved.').catch(err => {
            console.error('Failed to post monthly maintenance message:', err);
          });
        }
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

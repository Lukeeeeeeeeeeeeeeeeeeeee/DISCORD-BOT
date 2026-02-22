const { REGIONS, RECRUITER_ROLE_IDS, ROLE_IDS } = require('../../constants');
const { getRegionInfo } = require('../../lib/regions');
const { getWeekStartUtcTs } = require('../../lib/week');
const { fetchLeaderboardRows, loadRecruiterMeta, loadPreviousMinReqs } = require('../../lib/leaderboard-utils');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const recruitersRepo = require('../../repos/recruiters-repo');
const { runWithConcurrency } = require('../../lib/concurrency');
const { acquireJobLock } = require('../../lib/job-locks');
const { calculate7DayStats, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('../../lib/recruiting-system');
const { makeLeaderboardText } = require('../../lib/messages');
const { logUnexpectedError } = require('../../lib/logger');

const FULL_FETCH_COOLDOWN_MS = Number.parseInt(process.env.LEADERBOARD_FULL_FETCH_COOLDOWN_MS || '600000', 10);
const FORCE_FULL_FETCH_ON_EMPTY = (process.env.LEADERBOARD_FORCE_FULL_FETCH_ON_EMPTY || 'true').toLowerCase() === 'true';
const LEADERBOARD_ROW_CONCURRENCY = Number.parseInt(process.env.LEADERBOARD_ROW_CONCURRENCY || '4', 10);
let lastFullFetchAt = 0;

function reportLeaderboardServiceError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'leaderboard',
    ...meta
  });
}

async function warmMemberCacheIfNeeded(guild, totalRoleMembers, reason, options = {}) {
  if (!guild || !guild.members || typeof guild.members.fetch !== 'function') return false;
  const force = options && options.force === true;
  if (totalRoleMembers > 0 && !force) return false;
  const allowEnv = (process.env.LEADERBOARD_ALLOW_FULL_FETCH || process.env.ALLOW_FULL_MEMBER_FETCH || '').toLowerCase() === 'true';
  if (force && !FORCE_FULL_FETCH_ON_EMPTY) return false;
  if (!allowEnv) return false;
  const now = Date.now();
  if (now - lastFullFetchAt < FULL_FETCH_COOLDOWN_MS) return false;

  const guildId = options.guildId || guild.id || null;
  const db = options.db || null;
  if (db && guildId && Number.isFinite(FULL_FETCH_COOLDOWN_MS) && FULL_FETCH_COOLDOWN_MS > 0) {
    const bucket = Math.floor(now / FULL_FETCH_COOLDOWN_MS);
    const lockOk = await acquireJobLock(db, {
      guildId,
      key: `leaderboard_full_fetch_${bucket}`,
      ttlMs: FULL_FETCH_COOLDOWN_MS,
      failOpen: false
    }).catch(() => false);
    if (!lockOk) return false;
  }

  lastFullFetchAt = now;
  try {
    await guild.members.fetch();
    return true;
  } catch (e) {
    const hint = e && (e.code === 50001 || e.code === 50013)
      ? ' Check Server Members intent and bot permissions.'
      : '';
    reportLeaderboardServiceError('service.leaderboard.warmMemberCache', e, {
      reason,
      hint,
      guildId
    });
    return false;
  }
}

async function buildRows({ db, guild, guildId, recruiterMembers, region, weekStart, memberMap }) {
  const meta = await loadRecruiterMeta(db, recruiterMembers, { guildId });
  if (recruiterMembers.length === 0) {
    return { rows: [], meta };
  }

  const rowsBase = await fetchLeaderboardRows(db, recruiterMembers, { region, weekStart, sinceTs: weekStart, guildId });
  const missingMinReqIds = rowsBase.filter(r => r.min_req == null).map(r => r.recruiter_id);
  const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart, { guildId });

  const rows = [];
  const statsWindow = { sinceTs: weekStart - (7 * 24 * 60 * 60 * 1000), untilTs: weekStart };
  const safeConcurrency = Number.isFinite(LEADERBOARD_ROW_CONCURRENCY) && LEADERBOARD_ROW_CONCURRENCY > 0
    ? LEADERBOARD_ROW_CONCURRENCY
    : 4;
  const enrichedRows = await runWithConcurrency(rowsBase, safeConcurrency, async (r) => {
    const absence = meta.absences.has(r.recruiter_id);
    const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;
    const systemWarningRow = meta.systemWarnings.has(r.recruiter_id);

    const staffMember = (memberMap && memberMap.get(r.recruiter_id))
      || (guild.members && guild.members.cache ? guild.members.cache.get(r.recruiter_id) : null);
    const roleBase = getBaseRequirement(staffMember);
    const newStaffCheck = await isNewStaff(db, r.recruiter_id, { guildId }).catch(() => false);

    const isTrialRecruiter = !!staffMember && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

    let minReq = Number.isFinite(r.min_req) ? Number(r.min_req) : null;
    let previousMinReq = null;
    if (minReq == null) {
      previousMinReq = prevMinReqMap.get(r.recruiter_id) ?? null;
      minReq = previousMinReq;
    }
    if (minReq == null) {
      const stats7d = await calculate7DayStats(db, r.recruiter_id, guild, { ...statsWindow, guildId })
        .catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
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

    let displayName = `<@${r.recruiter_id}>`;
    if (region) {
      const teamName = getRegionInfo(region).name || region;
      displayName = staffMember && staffMember.user
        ? `${staffMember.user.tag || staffMember.user.username} | ${teamName}`
        : `<@${r.recruiter_id}>`;
    }
    return {
      ...r,
      recruits7d: Number(r.cnt || 0),
      minReq,
      absence: !!absence,
      displayName,
      systemWarning: !!systemWarningRow,
      activeWarnings
    };
  });

  for (const entry of enrichedRows) {
    if (!entry) continue;
    if (entry.ok === false && entry.error) {
      reportLeaderboardServiceError('service.leaderboard.enrichRow', entry.error, {
        guildId,
        region
      });
      continue;
    }
    rows.push(entry);
  }

  return { rows, meta };
}

async function showLeaderboard({ interaction, db, guildId }) {
  const region = interaction.options.getString('region');
  const weekStart = getWeekStartUtcTs();

  if (region) {
    if (!REGIONS.includes(region) && region !== 'GLOBAL') {
      return { error: 'Invalid region.' };
    }
    await interaction.deferReply();
    const respond = (payload) => interaction.editReply(payload);

    let dbIds = [];
    try {
      dbIds = await recruitersRepo.listIds(db, guildId);
    } catch (e) {
      reportLeaderboardServiceError('service.leaderboard.loadRecruiterIds.region', e, {
        guildId,
        region
      });
    }

    const recruiterRoleId = RECRUITER_ROLE_IDS[region];
    const recruiterRole = recruiterRoleId ? interaction.guild.roles.cache.get(recruiterRoleId) : null;
    const allRecruiterIds = new Set();
    const roleMembers = recruiterRole && recruiterRole.members ? recruiterRole.members : null;
    const totalRoleMembers = roleMembers ? roleMembers.size : 0;
    if (totalRoleMembers === 0) {
      await warmMemberCacheIfNeeded(interaction.guild, totalRoleMembers, `region:${region}`, {
        force: dbIds.length === 0,
        db,
        guildId
      });
    }
    const refreshedMembers = recruiterRole && recruiterRole.members ? recruiterRole.members : null;
    if (refreshedMembers) {
      refreshedMembers.forEach(member => allRecruiterIds.add(member.id));
    }

    let memberMap = new Map();
    try {
      const fallbackToDb = allRecruiterIds.size === 0;
      memberMap = await fetchMembersByIds(interaction.guild, dbIds);
      if (recruiterRoleId) {
        for (const member of memberMap.values()) {
          if (member.roles && member.roles.cache && member.roles.cache.has(recruiterRoleId)) {
            allRecruiterIds.add(member.id);
          }
        }
      }
      if (fallbackToDb && dbIds.length) {
        dbIds.forEach(id => allRecruiterIds.add(id));
      }
    } catch (e) {
      reportLeaderboardServiceError('service.leaderboard.resolveMembers.region', e, {
        guildId,
        region
      });
    }

    const recruiterMembers = Array.from(allRecruiterIds);
    if (recruiterMembers.length === 0) {
      const lang = interaction.locale || 'en';
      const text = makeLeaderboardText([], region, lang);
      return respond({ content: text, allowedMentions: { parse: [] } });
    }

    const { rows } = await buildRows({ db, guild: interaction.guild, guildId, recruiterMembers, region, weekStart, memberMap });
    const lang = interaction.locale || 'en';
    const text = makeLeaderboardText(rows, region, lang);
    return respond({ content: text, allowedMentions: { parse: [] } });
  }

  await interaction.deferReply();
  const respond = (payload) => interaction.editReply(payload);
  const allRecruiterIds = new Set();
  const recruiterRoleIds = ['EU', 'NA', 'AS']
    .map(rg => RECRUITER_ROLE_IDS[rg])
    .filter(Boolean);

  let totalRoleMembers = 0;
  for (const roleId of recruiterRoleIds) {
    const recruiterRole = interaction.guild.roles.cache.get(roleId);
    if (recruiterRole && recruiterRole.members) {
      totalRoleMembers += recruiterRole.members.size;
      recruiterRole.members.forEach(member => allRecruiterIds.add(member.id));
    }
  }
  let memberMap = new Map();
  let dbIds = [];
  try {
    dbIds = await recruitersRepo.listIds(db, guildId);
  } catch (e) {
    reportLeaderboardServiceError('service.leaderboard.loadRecruiterIds.global', e, { guildId });
  }
  if (totalRoleMembers === 0 && recruiterRoleIds.length) {
    await warmMemberCacheIfNeeded(interaction.guild, totalRoleMembers, 'global', {
      force: dbIds.length === 0,
      db,
      guildId
    });
    for (const roleId of recruiterRoleIds) {
      const recruiterRole = interaction.guild.roles.cache.get(roleId);
      if (recruiterRole && recruiterRole.members) {
        recruiterRole.members.forEach(member => allRecruiterIds.add(member.id));
      }
    }
  }

  try {
    const fallbackToDb = allRecruiterIds.size === 0;
    memberMap = await fetchMembersByIds(interaction.guild, dbIds);
    for (const member of memberMap.values()) {
      if (!member.roles || !member.roles.cache) continue;
      for (const roleId of recruiterRoleIds) {
        if (member.roles.cache.has(roleId)) {
          allRecruiterIds.add(member.id);
          break;
        }
      }
    }
    if (fallbackToDb && dbIds.length) {
      dbIds.forEach(id => allRecruiterIds.add(id));
    }
  } catch (e) {
    reportLeaderboardServiceError('service.leaderboard.resolveMembers.global', e, { guildId });
  }

  const recruiterMembers = Array.from(allRecruiterIds);
  if (recruiterMembers.length === 0) {
    const lang = interaction.locale || 'en';
    const text = makeLeaderboardText([], 'GLOBAL', lang);
    return respond({ content: text, allowedMentions: { parse: [] } });
  }

  const { rows } = await buildRows({ db, guild: interaction.guild, guildId, recruiterMembers, region: null, weekStart, memberMap });
  const lang = interaction.locale || 'en';
  const text = makeLeaderboardText(rows, 'GLOBAL', lang);
  return respond({ content: text, allowedMentions: { parse: [] } });
}

module.exports = { showLeaderboard, warmMemberCacheIfNeeded };

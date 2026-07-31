const db = require('../../db_async');
const { REGIONS, RECRUITER_ROLE_IDS, ROLE_IDS } = require('../../constants');
const { getRegionInfo } = require('../../lib/regions');
const { ensureCommandAccess } = require('../../lib/command-auth');
const { getWeekStartUtcTs, getRolling7DayStartTs } = require('../../lib/week');
const { fetchLeaderboardRows, loadRecruiterMeta, loadPreviousMinReqs, loadRecruiterIdsFromRecentRecruits } = require('../../lib/leaderboard-utils');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const { resolveGuildId } = require('../../lib/guild');
const { replyError } = require('../../lib/embeds');
const { isInteractionAckError } = require('../../lib/interaction-errors');
const { logUnexpectedError } = require('../../lib/logger');

const FULL_FETCH_MAX = Number.parseInt(process.env.LEADERBOARD_FULL_FETCH_MAX || '5000', 10);
const FULL_FETCH_COOLDOWN_MS = Number.parseInt(process.env.LEADERBOARD_FULL_FETCH_COOLDOWN_MS || '600000', 10);
const FORCE_FULL_FETCH_ON_EMPTY = (process.env.LEADERBOARD_FORCE_FULL_FETCH_ON_EMPTY || 'false').toLowerCase() === 'true';
let lastFullFetchAt = 0;

function reportLeaderboardCommandError(scope, error, meta = {}) {
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
  const memberCount = Number(guild.memberCount || 0);
  const canAutoFetch = Number.isFinite(memberCount) && memberCount > 0 && memberCount <= FULL_FETCH_MAX;
  if (force && !FORCE_FULL_FETCH_ON_EMPTY) return false;
  if (!canAutoFetch) return false;
  if (!force && !allowEnv) return false;
  const now = Date.now();
  if (now - lastFullFetchAt < FULL_FETCH_COOLDOWN_MS) return false;
  lastFullFetchAt = now;
  try {
    await guild.members.fetch();
    return true;
  } catch (e) {
    const hint = e && (e.code === 50001 || e.code === 50013)
      ? ' Check Server Members intent and bot permissions.'
      : '';
    reportLeaderboardCommandError('command.leaderboard.warmMemberCache', e, {
      reason,
      hint,
      guildId: guild ? guild.id : null
    });
    return false;
  }
}

module.exports = {
  data: { name: 'leaderboard' },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = resolveGuildId(interaction.guild);
    if (sub === 'show') {
      const region = interaction.options.getString('region');
      const weekStart = getWeekStartUtcTs();
      const rolling7dStart = getRolling7DayStartTs();
      if (region) {
        if (!REGIONS.includes(region) && region !== 'GLOBAL') return replyError(interaction, 'Invalid region.');
        await interaction.deferReply();
        const respond = (payload) => interaction.editReply(payload);

        // Prefer role membership, but fill missing cache entries from DB-backed IDs.
        let dbIds = [];
        try {
          const dbRows = await db.all('SELECT id FROM recruiters WHERE guild_id = ?', guildId);
          dbIds = (dbRows || []).map(r => r.id).filter(Boolean);
        } catch (e) {
          reportLeaderboardCommandError('command.leaderboard.loadRecruiterIds.region', e, {
            guildId,
            region
          });
        }

        const recruiterRoleId = RECRUITER_ROLE_IDS[region];
        const recruiterRole = recruiterRoleId ? interaction.guild.roles.cache.get(recruiterRoleId) : null;
        if (!recruiterRoleId && dbIds.length === 0) {
          return replyError(
            interaction,
            `Recruiter role for ${region} is not configured. Set RECRUITER_ROLE_IDS.${region}.`
          );
        }
        if (recruiterRoleId && !recruiterRole && dbIds.length === 0) {
          return replyError(
            interaction,
            `Configured recruiter role for ${region} was not found in this server. Check RECRUITER_ROLE_IDS.${region}.`
          );
        }
        const allRecruiterIds = new Set();
        const roleMembers = recruiterRole && recruiterRole.members ? recruiterRole.members : null;
        const totalRoleMembers = roleMembers ? roleMembers.size : 0;
        if (totalRoleMembers === 0) {
          await warmMemberCacheIfNeeded(interaction.guild, totalRoleMembers, `region:${region}`, {
            force: dbIds.length === 0
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
          reportLeaderboardCommandError('command.leaderboard.resolveMembers.region', e, {
            guildId,
            region
          });
        }

        try {
          const recentRecruiterIds = await loadRecruiterIdsFromRecentRecruits(db, {
            guildId,
            region,
            sinceTs: rolling7dStart
          });
          recentRecruiterIds.forEach(id => allRecruiterIds.add(id));
        } catch (e) {
          reportLeaderboardCommandError('command.leaderboard.loadRecentRecruiterIds.region', e, {
            guildId,
            region
          });
        }

        const recruiterMembers = Array.from(allRecruiterIds);
        const meta = await loadRecruiterMeta(db, recruiterMembers, { guildId });

        if (recruiterMembers.length === 0) {
          const { makeLeaderboardText } = require('../../lib/messages');
          const lang = interaction.locale || 'en';
          const text = makeLeaderboardText([], region, lang);
          return respond({ content: text });
        }

        // Get recruit data for all recruiters
        const rowsBase = await fetchLeaderboardRows(db, recruiterMembers, { guildId, region, weekStart, sinceTs: rolling7dStart });
        const missingMinReqIds = rowsBase.filter(r => r.min_req == null).map(r => r.recruiter_id);
        const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart, { guildId });

        // Get 7-day stats and minReq for each recruiter
        const { calculate7DayStats, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('../../lib/recruiting-system');
        const rows = [];
        const statsWindow = { sinceTs: rolling7dStart, untilTs: Date.now(), overrideWeekStart: weekStart };

        for (const r of rowsBase) {
          const absence = meta.absences.has(r.recruiter_id);
          const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;
          const systemWarningRow = meta.systemWarnings.has(r.recruiter_id);

          const staffMember = (memberMap && memberMap.get(r.recruiter_id))
            || (interaction.guild.members && interaction.guild.members.cache ? interaction.guild.members.cache.get(r.recruiter_id) : null);
          const roleBase = getBaseRequirement(staffMember);
          const newStaffCheck = await isNewStaff(db, r.recruiter_id, { guildId }).catch(() => false);

          const teamName = getRegionInfo(region).name || region;
          const displayName = staffMember && staffMember.user
            ? `${staffMember.user.tag || staffMember.user.username} | ${teamName}`
            : `<@${r.recruiter_id}>`;

          const isTrialRecruiter = !!staffMember && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

          let minReq = Number.isFinite(r.min_req) ? Number(r.min_req) : null;
          let previousMinReq = null;
          if (minReq == null) {
            previousMinReq = prevMinReqMap.get(r.recruiter_id) ?? null;
            minReq = previousMinReq;
          }
          if (minReq == null) {
            const stats7d = await calculate7DayStats(db, r.recruiter_id, interaction.guild, { ...statsWindow, guildId }).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
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

          rows.push({
            ...r,
            recruits7d: Number(r.cnt || 0),
            minReq,
            absence: !!absence,
            displayName,
            systemWarning: !!systemWarningRow,
            activeWarnings
          });
        }

        const { makeLeaderboardText } = require('../../lib/messages');
        const lang = interaction.locale || 'en';
        const text = makeLeaderboardText(rows, region, lang);
        return respond({ content: text });
      }

      // Global: get all recruiters from all regions
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
        const dbRows = await db.all('SELECT id FROM recruiters WHERE guild_id = ?', guildId);
        dbIds = (dbRows || []).map(r => r.id).filter(Boolean);
      } catch (e) {
        reportLeaderboardCommandError('command.leaderboard.loadRecruiterIds.global', e, { guildId });
      }
      if (recruiterRoleIds.length === 0 && dbIds.length === 0) {
        return replyError(interaction, 'No recruiter roles are configured. Set RECRUITER_ROLE_IDS for EU/NA/AS.');
      }
      if (totalRoleMembers === 0 && recruiterRoleIds.length) {
        await warmMemberCacheIfNeeded(interaction.guild, totalRoleMembers, 'global', {
          force: dbIds.length === 0
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
        reportLeaderboardCommandError('command.leaderboard.resolveMembers.global', e, { guildId });
      }

      try {
        const recentRecruiterIds = await loadRecruiterIdsFromRecentRecruits(db, {
          guildId,
          sinceTs: rolling7dStart
        });
        recentRecruiterIds.forEach(id => allRecruiterIds.add(id));
      } catch (e) {
        reportLeaderboardCommandError('command.leaderboard.loadRecentRecruiterIds.global', e, { guildId });
      }

      const recruiterMembers = Array.from(allRecruiterIds);
      const meta = await loadRecruiterMeta(db, recruiterMembers, { guildId });

      if (recruiterMembers.length === 0) {
        const { makeLeaderboardText } = require('../../lib/messages');
        const lang = interaction.locale || 'en';
        const text = makeLeaderboardText([], 'GLOBAL', lang);
        return respond({ content: text });
      }

      // Get global recruit data
      const rowsBase = await fetchLeaderboardRows(db, recruiterMembers, { guildId, weekStart, sinceTs: rolling7dStart });
      const missingMinReqIds = rowsBase.filter(r => r.min_req == null).map(r => r.recruiter_id);
      const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart, { guildId });

      // Get 7-day stats and minReq for global
      const { calculate7DayStats, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('../../lib/recruiting-system');
      const rows = [];
      const statsWindow = { sinceTs: rolling7dStart, untilTs: Date.now(), overrideWeekStart: weekStart };

      for (const r of rowsBase) {
        const absence = meta.absences.has(r.recruiter_id);
        const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;
        const systemWarningRow = meta.systemWarnings.has(r.recruiter_id);

        const staffMember = (memberMap && memberMap.get(r.recruiter_id))
          || (interaction.guild.members && interaction.guild.members.cache ? interaction.guild.members.cache.get(r.recruiter_id) : null);
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
          const stats7d = await calculate7DayStats(db, r.recruiter_id, interaction.guild, { ...statsWindow, guildId }).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
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

        rows.push({
          ...r,
          recruits7d: Number(r.cnt || 0),
          minReq,
          absence: !!absence,
          systemWarning: !!systemWarningRow,
          activeWarnings
        });
      }

      const { makeLeaderboardText } = require('../../lib/messages');
      const lang = interaction.locale || 'en';
      const text = makeLeaderboardText(rows, 'GLOBAL', lang);
      return respond({ content: text });
    }

    if (sub === 'init') {
      // admin only
      const allowed = await ensureCommandAccess(interaction, {
        allowStaff: false,
        deniedMessage: 'Administrator permission required.'
      });
      if (!allowed) return null;
      try {
        await interaction.deferReply();
        const scheduler = require('../../scheduler');
        await scheduler.recomputeLeaderboards(db, interaction.guild);
        await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);

        const rows = await db.all(
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
          'Leaderboards initialized/updated.',
          `Tracked rows: ${(rows || []).length}`,
          `Tracked channels: ${uniqueChannels}`,
          `Duplicate row groups: ${duplicateRows.length}`
        ];
        if (duplicateRows.length) {
          const sample = duplicateRows.slice(0, 5).map((r) => `- <#${r.channel_id}> [${r.region || 'null'}]: ${r.cnt}`);
          summary.push('Duplicate details (first 5):');
          summary.push(...sample);
        }
        return await interaction.editReply({ content: summary.join('\n'), allowedMentions: { parse: [] } });
      } catch (e) {
        if (isInteractionAckError(e)) return null;
        reportLeaderboardCommandError('command.leaderboard.init', e, { guildId });
        return replyError(interaction, 'Failed to initialize leaderboards.');
      }
    }
  }
};

const db = require('../db_async');
const { REGIONS, RECRUITER_ROLE_IDS, ROLE_IDS } = require('../constants');
const { getRegionInfo } = require('../lib/regions');
const { hasAdministrator } = require('../lib/permissions');
const { getWeekStartUtcTs } = require('../lib/week');
const { fetchLeaderboardRows, loadRecruiterMeta, loadPreviousMinReqs } = require('../lib/leaderboard-utils');
const { fetchMembersByIds } = require('../lib/member-fetch');
const { replyError } = require('../lib/embeds');

module.exports = {
  data: { name: 'leaderboard' },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub === 'show') {
      const region = interaction.options.getString('region');
      const weekStart = getWeekStartUtcTs();
      if (region) {
        if (!REGIONS.includes(region) && region !== 'GLOBAL') return replyError(interaction, 'Invalid region.');
        await interaction.deferReply();
        const respond = (payload) => interaction.editReply(payload);

        // Prefer role membership, but fill missing cache entries from DB-backed IDs.
        const recruiterRoleId = RECRUITER_ROLE_IDS[region];
        const recruiterRole = recruiterRoleId ? interaction.guild.roles.cache.get(recruiterRoleId) : null;

        const allRecruiterIds = new Set();
        if (recruiterRole && recruiterRole.members) {
          recruiterRole.members.forEach(member => allRecruiterIds.add(member.id));
        }

        let memberMap = new Map();
        try {
          const dbRows = await db.all('SELECT id FROM recruiters');
          const dbIds = (dbRows || []).map(r => r.id).filter(Boolean);
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
          console.error('Failed to resolve recruiter members for leaderboard', e);
        }

        const recruiterMembers = Array.from(allRecruiterIds);
        const meta = await loadRecruiterMeta(db, recruiterMembers);

        if (recruiterMembers.length === 0) {
          const { makeLeaderboardText } = require('../lib/messages');
          const lang = interaction.locale || 'en';
          const text = makeLeaderboardText([], region, lang);
          return respond({ content: text });
        }

        // Get recruit data for all recruiters
        const rowsBase = await fetchLeaderboardRows(db, recruiterMembers, { region, weekStart, sinceTs: weekStart });
        const missingMinReqIds = rowsBase.filter(r => r.min_req == null).map(r => r.recruiter_id);
        const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart);

        // Get 7-day stats and minReq for each recruiter
        const { calculate7DayStats, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('../lib/recruiting-system');
        const rows = [];
        const statsWindow = { sinceTs: weekStart - (7 * 24 * 60 * 60 * 1000), untilTs: weekStart };

        for (const r of rowsBase) {
          const absence = meta.absences.has(r.recruiter_id);
          const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;
          const systemWarningRow = meta.systemWarnings.has(r.recruiter_id);

          const staffMember = (memberMap && memberMap.get(r.recruiter_id))
            || (interaction.guild.members && interaction.guild.members.cache ? interaction.guild.members.cache.get(r.recruiter_id) : null);
          const roleBase = getBaseRequirement(staffMember);
          const newStaffCheck = await isNewStaff(db, r.recruiter_id).catch(() => false);

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
            const stats7d = await calculate7DayStats(db, r.recruiter_id, interaction.guild, statsWindow).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
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

        const { makeLeaderboardText } = require('../lib/messages');
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

      for (const roleId of recruiterRoleIds) {
        const recruiterRole = interaction.guild.roles.cache.get(roleId);
        if (recruiterRole && recruiterRole.members) {
          recruiterRole.members.forEach(member => allRecruiterIds.add(member.id));
        }
      }

      let memberMap = new Map();
      try {
        const dbRows = await db.all('SELECT id FROM recruiters');
        const dbIds = (dbRows || []).map(r => r.id).filter(Boolean);
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
        console.error('Failed to resolve recruiter members for global leaderboard', e);
      }

      const recruiterMembers = Array.from(allRecruiterIds);
      const meta = await loadRecruiterMeta(db, recruiterMembers);

      if (recruiterMembers.length === 0) {
        const { makeLeaderboardText } = require('../lib/messages');
        const lang = interaction.locale || 'en';
        const text = makeLeaderboardText([], 'GLOBAL', lang);
        return respond({ content: text });
      }

      // Get global recruit data
      const rowsBase = await fetchLeaderboardRows(db, recruiterMembers, { weekStart, sinceTs: weekStart });
      const missingMinReqIds = rowsBase.filter(r => r.min_req == null).map(r => r.recruiter_id);
      const prevMinReqMap = await loadPreviousMinReqs(db, missingMinReqIds, weekStart);

      // Get 7-day stats and minReq for global
      const { calculate7DayStats, calculateMinRecruitsFixed, getBaseRequirement, isNewStaff } = require('../lib/recruiting-system');
      const rows = [];
      const statsWindow = { sinceTs: weekStart - (7 * 24 * 60 * 60 * 1000), untilTs: weekStart };

      for (const r of rowsBase) {
        const absence = meta.absences.has(r.recruiter_id);
        const activeWarnings = meta.warnings.get(r.recruiter_id) || 0;
        const systemWarningRow = meta.systemWarnings.has(r.recruiter_id);

        const staffMember = (memberMap && memberMap.get(r.recruiter_id))
          || (interaction.guild.members && interaction.guild.members.cache ? interaction.guild.members.cache.get(r.recruiter_id) : null);
        const roleBase = getBaseRequirement(staffMember);
        const newStaffCheck = await isNewStaff(db, r.recruiter_id).catch(() => false);

        const isTrialRecruiter = !!staffMember && staffMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !staffMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

        let minReq = Number.isFinite(r.min_req) ? Number(r.min_req) : null;
        let previousMinReq = null;
        if (minReq == null) {
          previousMinReq = prevMinReqMap.get(r.recruiter_id) ?? null;
          minReq = previousMinReq;
        }
        if (minReq == null) {
          const stats7d = await calculate7DayStats(db, r.recruiter_id, interaction.guild, statsWindow).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
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

      const { makeLeaderboardText } = require('../lib/messages');
      const lang = interaction.locale || 'en';
      const text = makeLeaderboardText(rows, 'GLOBAL', lang);
      return respond({ content: text });
    }

    if (sub === 'init') {
      // admin only
      if (!hasAdministrator(interaction.member)) return replyError(interaction, 'Admin only.');
      try {
        const scheduler = require('../scheduler');
        await scheduler.recomputeLeaderboards(db, interaction.guild);
        await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
        return interaction.reply({ content: 'Leaderboards initialized/updated.' });
      } catch (e) {
        console.error(e);
        return replyError(interaction, 'Failed to initialize leaderboards.');
      }
    }
  }
};

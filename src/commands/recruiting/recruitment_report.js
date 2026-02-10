const db = require('../../db_async');
const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../../lib/permissions');
const {
  calculate7DayStats,
  getPreviousMinReq,
  calculateMinRecruitsFixed,
  getBaseRequirement,
  isNewStaff
} = require('../../lib/recruiting-system');
const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../../constants');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const { formatPointsValue } = require('../../lib/economy');
const { getWeekStartUtcTs } = require('../../lib/week');
const { clampText } = require('../../lib/text');
const { getTeamLabel, normalizeRegionInput } = require('../../lib/regions');
const { replyError } = require('../../lib/embeds');
const { resolveGuildId } = require('../../lib/guild');

function chunkLines(lines, maxLen = 1024) {
  const chunks = [];
  let cur = '';
  for (const line of lines) {
    const next = cur ? `${cur}\n${line}` : line;
    if (next.length > maxLen) {
      if (cur) chunks.push(cur);
      cur = line;
    } else {
      cur = next;
    }
  }
  if (cur) chunks.push(cur);
  return chunks;
}

function formatPct(x) {
  if (!Number.isFinite(x)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
}

async function getAverageWeeklyRecruits(db, recruiterId, weeks = 4) {
  try {
    const rows = await db.all(
      'SELECT recruits7d FROM weekly_calculations WHERE recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT ?',
      recruiterId,
      weeks
    );
    if (rows && rows.length) {
      const total = rows.reduce((sum, r) => sum + (Number(r.recruits7d) || 0), 0);
      return Math.round((total / rows.length) * 10) / 10;
    }
  } catch (e) {
    void e;
  }

  try {
    const since = Date.now() - (28 * 24 * 60 * 60 * 1000);
    const row = await db.get(
      'SELECT COUNT(*) as c FROM recruits WHERE recruiter_id = ? AND valid = 1 AND created_at >= ?',
      recruiterId,
      since
    );
    const count = row ? Number(row.c || 0) : 0;
    return Math.round((count / 4) * 10) / 10;
  } catch (e) {
    return 0;
  }
}

/**
 * Calculate performance score based on multiple factors:
 * - Recruitment progress (avg of 7d recruits + avg recruits/week) - 40%
 * - Verify rate - 25%
 * - Retention rate - 20%
 * - Warning penalty - 15%
 */
function calculatePerformanceScore({ recruits7d, avgRecruitsWeek, minReq, verifyRate, retention, warnings }) {
  if (minReq <= 0) minReq = 1; // Avoid division by zero

  const avgRecruits = Number.isFinite(avgRecruitsWeek) ? avgRecruitsWeek : recruits7d;
  const recruitProgress = Math.min(2, ((recruits7d + avgRecruits) / 2) / minReq); // Cap at 200%
  const warningPenalty = Math.max(0, 1 - (warnings * 0.25)); // Each warning reduces by 25%

  const score = (
    recruitProgress * 0.40 +
    (verifyRate || 0) * 0.25 +
    (retention || 0) * 0.20 +
    warningPenalty * 0.15
  );

  return score;
}

/**
 * Categories based on relative performance (percentiles):
 * FAILING: bottom 20% OR warnings >= 2
 * ATTENTION: 20-40%
 * PASSING: 40-80%
 * SUCCEEDING: top 20% (and meeting minReq)
 */
function getPerformanceCategory({ percentile, warnings, recruits7d, minReq, absent }) {
  if (absent) return { bucket: 'ABSENT', label: '🏖️ Absent', color: 0x808080 };
  if (warnings >= 2) return { bucket: 'FAILING', label: '❌ Failing', color: 0xFF0000 };
  const p = Number.isFinite(percentile) ? percentile : 0.5;
  if (p < 0.2) return { bucket: 'FAILING', label: '❌ Failing', color: 0xFF0000 };
  if (p < 0.4) return { bucket: 'ATTENTION', label: '⚠️ Attention', color: 0xFFA500 };
  if (p >= 0.8 && (recruits7d || 0) >= (minReq || 0)) return { bucket: 'SUCCEEDING', label: '🌟 Succeeding', color: 0x00FF00 };
  return { bucket: 'PASSING', label: '✅ Passing', color: 0x00AAFF };
}

async function resolveRecruiterIdsForTeam(guild, team, db) {
  const ids = new Set();

  const addRoleMembers = (roleId) => {
    if (!roleId) return;
    const role = guild.roles.cache.get(roleId);
    if (!role || !role.members) return;
    role.members.forEach(m => ids.add(m.id));
  };

  const region = team && team !== 'ALL' ? team : null;
  const roleIds = [];
  if (region) {
    const regionalRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[region] ? RECRUITER_ROLE_IDS[region] : null;
    if (regionalRoleId) roleIds.push(regionalRoleId);
  } else {
    for (const rg of ['EU', 'NA', 'AS']) {
      const regionalRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[rg] ? RECRUITER_ROLE_IDS[rg] : null;
      if (regionalRoleId) roleIds.push(regionalRoleId);
    }
    if (ROLE_IDS.RECRUITER) roleIds.push(ROLE_IDS.RECRUITER);
    if (ROLE_IDS.TRIAL_RECRUITER) roleIds.push(ROLE_IDS.TRIAL_RECRUITER);
  }

  for (const roleId of roleIds) addRoleMembers(roleId);

  if (db) {
    try {
      const rows = await db.all('SELECT id FROM recruiters');
      const dbIds = (rows || []).map(r => r.id).filter(Boolean);
      const memberMap = await fetchMembersByIds(guild, dbIds);
      for (const member of memberMap.values()) {
        if (!member.roles || !member.roles.cache) continue;
        for (const roleId of roleIds) {
          if (member.roles.cache.has(roleId)) {
            ids.add(member.id);
            break;
          }
        }
      }
    } catch (e) {
      console.error('Failed to resolve recruiter members for report', e);
    }
  }

  return Array.from(ids);
}

module.exports = {
  data: {
    name: 'recruitment_report',
    description: 'Admin: show recruiting performance by team'
  },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return replyError(interaction, 'Administrator permission required.', { flags: 64 });
    }

    if (!interaction.guild) {
      return replyError(interaction, 'This command can only be used in a server.');
    }

    const rawTeam = interaction.options && typeof interaction.options.getString === 'function'
      ? interaction.options.getString('team')
      : null;

    // Accept both team names (Fire/Water/Air) and region codes (EU/NA/AS)
    let team = 'ALL';
    if (rawTeam) {
      const upper = rawTeam.toUpperCase();
      if (upper === 'ALL') {
        team = 'ALL';
      } else {
        const normalized = normalizeRegionInput(upper);
        if (normalized) team = normalized;
      }
    }

    await interaction.deferReply({ flags: 64 });

    const allowFullFetch = (process.env.REPORT_ALLOW_FULL_FETCH || '').toLowerCase() === 'true';
    if (allowFullFetch) {
      try {
        if (interaction.guild.members && typeof interaction.guild.members.fetch === 'function') {
          await interaction.guild.members.fetch().catch(err => {
            console.error('Failed to prime member cache for recruitment report:', err);
          });
        }
      } catch (e) {
        void e;
      }
    }

    const recruiterIds = await resolveRecruiterIdsForTeam(interaction.guild, team, db);
    if (!recruiterIds.length) {
      return replyError(interaction, `No recruiters found for ${team}.`);
    }

    const weekStart = getWeekStartUtcTs();
    const statsWindow = { sinceTs: weekStart - (7 * 24 * 60 * 60 * 1000), untilTs: weekStart };

    const placeholders = recruiterIds.map(() => '?').join(',');
    const absencesMap = new Map();
    const warningsMap = new Map();
    const weekCalcMap = new Map();
    const pointsMap = new Map();

    if (placeholders) {
      const [absences, warnings, weekCalcs, points] = await Promise.all([
        db.all(
          `SELECT recruiter_id, start_date, end_date FROM absences WHERE active = 1 AND end_date >= date("now") AND recruiter_id IN (${placeholders})`,
          ...recruiterIds
        ).catch(() => []),
        db.all(
          `SELECT recruiter_id, COUNT(*) as c FROM warnings WHERE revoked = 0 AND (expired_at IS NULL OR expired_at > ?) AND recruiter_id IN (${placeholders}) GROUP BY recruiter_id`,
          ...recruiterIds,
          Date.now()
        ).catch(() => []),
        db.all(
          `SELECT recruiter_id, calculated_min_req, recruits7d, activity_rate, verify_rate, retention
           FROM weekly_calculations
           WHERE week_start = ? AND recruiter_id IN (${placeholders})`,
          weekStart,
          ...recruiterIds
        ).catch(() => []),
        db.all(
          `SELECT id, points FROM recruiters WHERE id IN (${placeholders})`,
          ...recruiterIds
        ).catch(() => [])
      ]);

      for (const row of absences || []) absencesMap.set(row.recruiter_id, row);
      for (const row of warnings || []) warningsMap.set(row.recruiter_id, Number(row.c || 0));
      for (const row of weekCalcs || []) weekCalcMap.set(row.recruiter_id, row);
      for (const row of points || []) pointsMap.set(row.id, Number(row.points || 0));
    }

    const results = [];

    for (const id of recruiterIds) {
      const member = interaction.guild.members && interaction.guild.members.cache
        ? interaction.guild.members.cache.get(id)
        : null;

      const weekCalc = weekCalcMap.get(id) || null;
      let stats7d = null;
      if (weekCalc && Number.isFinite(Number(weekCalc.recruits7d))) {
        stats7d = {
          recruits7d: Number(weekCalc.recruits7d || 0),
          activityRate: Number(weekCalc.activity_rate || 0),
          verifyRate: Number(weekCalc.verify_rate || 0),
          retention: Number(weekCalc.retention || 0)
        };
      } else {
        stats7d = await calculate7DayStats(db, id, interaction.guild, statsWindow)
          .catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
      }
      const avgRecruitsWeek = await getAverageWeeklyRecruits(db, id).catch(() => 0);

      const absence = absencesMap.get(id) || null;

      const activeWarnings = warningsMap.get(id) || 0;

      let newStaffCheck = await isNewStaff(db, id).catch(() => false);

      const roleBase = getBaseRequirement(member);
      const isTrialRecruiter = !!member && !!member.roles && !!member.roles.cache && member.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !member.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

      let minReq = weekCalc && weekCalc.calculated_min_req != null ? Number(weekCalc.calculated_min_req) : null;
      let previousMinReq = null;
      if (minReq == null) {
        previousMinReq = await getPreviousMinReq(db, id).catch(() => null);
        minReq = previousMinReq;
      }

      if (minReq == null) {
        minReq = calculateMinRecruitsFixed({
          roleBase,
          member,
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

      const score = calculatePerformanceScore({
        recruits7d: stats7d.recruits7d,
        avgRecruitsWeek,
        minReq,
        verifyRate: stats7d.verifyRate,
        retention: stats7d.retention,
        warnings: activeWarnings
      });

      const points = pointsMap.has(id) ? pointsMap.get(id) : 0;

      results.push({
        id,
        tag: member && member.user ? member.user.tag : null,
        recruits7d: stats7d.recruits7d,
        avgRecruitsWeek,
        verifyRate: stats7d.verifyRate,
        retention: stats7d.retention,
        minReq,
        activeWarnings,
        score,
        category: null,
        points,
        absent: !!absence,
        isNewRecruiter: !!newStaffCheck
      });
    }

    const scores = results.filter(r => !r.absent && !r.isNewRecruiter).map(r => r.score).sort((a, b) => a - b);
    const percentileFor = (score) => {
      if (!scores.length) return 0.5;
      let below = 0;
      let equal = 0;
      for (const s of scores) {
        if (s < score - 1e-9) {
          below++;
        } else if (Math.abs(s - score) <= 1e-9) {
          equal++;
        } else {
          break;
        }
      }
      return (below + (equal / 2)) / scores.length;
    };

    for (const r of results) {
      if (r.absent) {
        r.category = getPerformanceCategory({
          percentile: null,
          warnings: r.activeWarnings,
          recruits7d: r.recruits7d,
          minReq: r.minReq,
          absent: true
        });
        r.percentile = null;
        continue;
      }
      if (r.isNewRecruiter) {
        r.category = { bucket: 'NEW', label: 'New Recruiter', color: 0x00AAFF };
        r.percentile = null;
        continue;
      }
      const percentile = percentileFor(r.score);
      r.category = getPerformanceCategory({
        percentile,
        warnings: r.activeWarnings,
        recruits7d: r.recruits7d,
        minReq: r.minReq,
        absent: false
      });
      r.percentile = percentile;
    }

    // Define buckets in display order
    const buckets = [
      { key: 'FAILING', title: '❌ FAILING', color: 0xFF0000 },
      { key: 'ATTENTION', title: '⚠️ ATTENTION', color: 0xFFA500 },
      { key: 'NEW', title: 'NEW RECRUITERS', color: 0x00AAFF },
      { key: 'PASSING', title: '✅ PASSING', color: 0x00AAFF },
      { key: 'SUCCEEDING', title: '🌟 SUCCEEDING', color: 0x00FF00 },
      { key: 'ABSENT', title: '🏖️ ABSENT', color: 0x808080 }
    ];

    const grouped = new Map(buckets.map(b => [b.key, []]));
    for (const r of results) {
      const key = r.category && r.category.bucket ? r.category.bucket : 'PASSING';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }

    // Sort within each bucket by score descending, then warnings ascending
    for (const [, arr] of grouped.entries()) {
      arr.sort((a, b) => {
        if (a.category.bucket === 'FAILING' || a.category.bucket === 'ATTENTION') {
          // For failing/attention, sort by warnings DESC then score ASC (worst first)
          if (b.activeWarnings !== a.activeWarnings) return b.activeWarnings - a.activeWarnings;
          return a.score - b.score;
        }
        // For passing/succeeding, sort by score DESC (best first)
        return b.score - a.score;
      });
    }

    const teamLabel = team === 'ALL' ? 'All Teams' : getTeamLabel(team);

    const embed = new EmbedBuilder()
      .setTitle(clampText(`📊 Recruitment Report - ${teamLabel}`, 256))
      .setColor(0x00AAFF)
      .setDescription('Performance score: recruits (40%), verify rate (25%), retention (20%), warnings penalty (15%). New recruiters (role-age grace window) are grouped separately; buckets are relative percentiles (warnings/absence override).')
      .setTimestamp();

    let fieldCount = 0;
    for (const b of buckets) {
      const arr = grouped.get(b.key) || [];
      if (!arr.length) continue;

      const lines = arr.map(x => {
        const perf = `${x.recruits7d}/${x.minReq}`;
        const avg = Number.isFinite(x.avgRecruitsWeek) ? String(x.avgRecruitsWeek).replace(/\.0$/, '') : '0';
        const verify = formatPct(x.verifyRate);
        const ret = formatPct(x.retention);
        const warn = x.activeWarnings > 0 ? ` ⚠️${x.activeWarnings}` : '';
        const scoreDisplay = Math.round(x.score * 100);
        return `<@${x.id}> [${perf}] avg${avg}/w v${verify} r${ret}${warn} pts${formatPointsValue(x.points)} (${scoreDisplay}%)`;
      });

      const chunks = chunkLines(lines, 1024);
      for (let i = 0; i < chunks.length; i++) {
        if (fieldCount >= 24) break;
        const fname = i === 0 ? `${b.title} (${arr.length})` : `${b.title} (${i + 1})`;
        embed.addFields({ name: fname, value: chunks[i] });
        fieldCount++;
      }
      if (fieldCount >= 24) break;
    }

    // Summary footer
    const failing = (grouped.get('FAILING') || []).length;
    const attention = (grouped.get('ATTENTION') || []).length;
    const newly = (grouped.get('NEW') || []).length;
    const passing = (grouped.get('PASSING') || []).length;
    const succeeding = (grouped.get('SUCCEEDING') || []).length;
    const absent = (grouped.get('ABSENT') || []).length;

    embed.setFooter({
      text: `Total: ${results.length} | NEW${newly} | ❌${failing} ⚠️${attention} ✅${passing} 🌟${succeeding} 🏖️${absent}`
    });

    return interaction.editReply({ embeds: [embed] });
  }
};

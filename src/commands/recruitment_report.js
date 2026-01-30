const db = require('../db_async');
const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');
const {
  calculate7DayStats,
  getPreviousMinReq,
  calculateMinRecruitsFixed,
  getBaseRequirement,
  isNewStaff
} = require('../lib/recruiting-system');
const { ROLE_IDS, RECRUITER_ROLE_IDS, REGION_INFO } = require('../constants');

// Team mappings
const TEAM_INFO = {
  EU: { name: 'Fire', emoji: '🔥' },
  NA: { name: 'Water', emoji: '💧' },
  AS: { name: 'Air', emoji: '🌬️' }
};

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

/**
 * Calculate performance score based on multiple factors:
 * - Recruitment progress (recruits/minReq) - 40%
 * - Verify rate - 25%
 * - Retention rate - 20%
 * - Warning penalty - 15%
 */
function calculatePerformanceScore({ recruits7d, minReq, verifyRate, retention, warnings }) {
  if (minReq <= 0) minReq = 1; // Avoid division by zero

  const recruitProgress = Math.min(2, recruits7d / minReq); // Cap at 200%
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
 * Categories based on performance score:
 * FAILING: score < 0.5 OR warnings >= 2
 * ATTENTION: 0.5 <= score < 0.8
 * PASSING: 0.8 <= score < 1.2
 * SUCCEEDING: score >= 1.2 AND recruits > minReq
 */
function getPerformanceCategory({ score, warnings, recruits7d, minReq, absent }) {
  if (absent) return { bucket: 'ABSENT', label: '🏖️ Absent', color: 0x808080 };
  if (warnings >= 2) return { bucket: 'FAILING', label: '❌ Failing', color: 0xFF0000 };
  if (score < 0.5) return { bucket: 'FAILING', label: '❌ Failing', color: 0xFF0000 };
  if (score < 0.8) return { bucket: 'ATTENTION', label: '⚠️ Attention', color: 0xFFA500 };
  if (score >= 1.2 && recruits7d >= minReq) return { bucket: 'SUCCEEDING', label: '🌟 Succeeding', color: 0x00FF00 };
  return { bucket: 'PASSING', label: '✅ Passing', color: 0x00AAFF };
}

async function resolveRecruiterIdsForTeam(guild, team) {
  const ids = new Set();

  const addRoleMembers = (roleId) => {
    if (!roleId) return;
    const role = guild.roles.cache.get(roleId);
    if (!role || !role.members) return;
    role.members.forEach(m => ids.add(m.id));
  };

  // Map team names to region codes
  const regionMap = { 'Fire': 'EU', 'Water': 'NA', 'Air': 'AS' };
  const region = regionMap[team] || team;

  if (['EU', 'NA', 'AS'].includes(region)) {
    const regionalRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[region] ? RECRUITER_ROLE_IDS[region] : null;
    addRoleMembers(regionalRoleId);
    return Array.from(ids);
  }

  // ALL - get all recruiters
  for (const rg of ['EU', 'NA', 'AS']) {
    const regionalRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[rg] ? RECRUITER_ROLE_IDS[rg] : null;
    addRoleMembers(regionalRoleId);
  }
  addRoleMembers(ROLE_IDS.RECRUITER);
  addRoleMembers(ROLE_IDS.TRIAL_RECRUITER);

  return Array.from(ids);
}

module.exports = {
  data: {
    name: 'recruitment_report',
    description: 'Admin: show recruiting performance by team (Fire/Water/Air)'
  },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ content: '❌ Administrator permission required.' });
    }

    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.' });
    }

    const rawTeam = interaction.options && typeof interaction.options.getString === 'function'
      ? interaction.options.getString('team')
      : null;

    // Accept both team names (Fire/Water/Air) and region codes (EU/NA/AS)
    let team = 'ALL';
    if (rawTeam) {
      const upper = rawTeam.toUpperCase();
      if (['FIRE', 'EU'].includes(upper)) team = 'Fire';
      else if (['WATER', 'NA'].includes(upper)) team = 'Water';
      else if (['AIR', 'AS'].includes(upper)) team = 'Air';
      else if (upper === 'ALL') team = 'ALL';
    }

    await interaction.deferReply();

    try {
      if (interaction.guild.members && typeof interaction.guild.members.fetch === 'function') {
        await interaction.guild.members.fetch().catch(() => { });
      }
    } catch (e) {
      void e;
    }

    const recruiterIds = await resolveRecruiterIdsForTeam(interaction.guild, team);
    if (!recruiterIds.length) {
      return interaction.editReply({ content: `No recruiters found for ${team}.` });
    }

    const results = [];

    for (const id of recruiterIds) {
      const member = await interaction.guild.members.fetch(id).catch(() => null);

      const stats7d = await calculate7DayStats(db, id, interaction.guild).catch(() => ({ recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 }));
      const previousMinReq = await getPreviousMinReq(db, id).catch(() => null);

      const absence = await db.get(
        'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
        id
      ).catch(() => null);

      const warningsRow = await db.get(
        'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
        id,
        Date.now()
      ).catch(() => null);
      const activeWarnings = warningsRow ? warningsRow.c : 0;

      let newStaffCheck = await isNewStaff(db, id).catch(() => false);

      const roleBase = getBaseRequirement(member);
      const isTrialRecruiter = !!member && !!member.roles && !!member.roles.cache && member.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !member.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

      const minReq = isTrialRecruiter
        ? 3
        : calculateMinRecruitsFixed({
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

      const score = calculatePerformanceScore({
        recruits7d: stats7d.recruits7d,
        minReq,
        verifyRate: stats7d.verifyRate,
        retention: stats7d.retention,
        warnings: activeWarnings
      });

      const category = getPerformanceCategory({
        score,
        warnings: activeWarnings,
        recruits7d: stats7d.recruits7d,
        minReq,
        absent: !!absence
      });

      results.push({
        id,
        tag: member && member.user ? member.user.tag : null,
        recruits7d: stats7d.recruits7d,
        verifyRate: stats7d.verifyRate,
        retention: stats7d.retention,
        minReq,
        activeWarnings,
        score,
        category
      });
    }

    // Define buckets in display order
    const buckets = [
      { key: 'FAILING', title: '❌ FAILING', color: 0xFF0000 },
      { key: 'ATTENTION', title: '⚠️ ATTENTION', color: 0xFFA500 },
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

    const teamLabel = team === 'ALL' ? 'All Teams' : `${TEAM_INFO[team === 'Fire' ? 'EU' : team === 'Water' ? 'NA' : 'AS']?.emoji || ''} ${team}`;

    const embed = new EmbedBuilder()
      .setTitle(`📊 Recruitment Report - ${teamLabel}`)
      .setColor(0x00AAFF)
      .setDescription('Performance based on: recruits (40%), verify rate (25%), retention (20%), warnings penalty (15%)')
      .setTimestamp();

    let fieldCount = 0;
    for (const b of buckets) {
      const arr = grouped.get(b.key) || [];
      if (!arr.length) continue;

      const lines = arr.map(x => {
        const perf = `${x.recruits7d}/${x.minReq}`;
        const verify = formatPct(x.verifyRate);
        const ret = formatPct(x.retention);
        const warn = x.activeWarnings > 0 ? ` ⚠️${x.activeWarnings}` : '';
        const scoreDisplay = Math.round(x.score * 100);
        return `<@${x.id}> [${perf}] v${verify} r${ret}${warn} (${scoreDisplay}%)`;
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
    const passing = (grouped.get('PASSING') || []).length;
    const succeeding = (grouped.get('SUCCEEDING') || []).length;
    const absent = (grouped.get('ABSENT') || []).length;

    embed.setFooter({
      text: `Total: ${results.length} | ❌${failing} ⚠️${attention} ✅${passing} 🌟${succeeding} 🏖️${absent}`
    });

    return interaction.editReply({ embeds: [embed] });
  }
};

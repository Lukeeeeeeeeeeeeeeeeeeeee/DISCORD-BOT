const db = require('../db_async');
const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');
const {
  calculate7DayStats,
  getPreviousMinReq,
  calculateMinRecruitsFixed,
  getBaseRequirement,
  isNewStaff,
  getRecruiterStatus
} = require('../lib/recruiting-system');
const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');

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

async function resolveRecruiterIdsForRegion(guild, region) {
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
  ].filter(Boolean);

  const ids = new Set();

  const addRoleMembers = (roleId) => {
    if (!roleId) return;
    const role = guild.roles.cache.get(roleId);
    if (!role || !role.members) return;
    role.members.forEach(m => ids.add(m.id));
  };

  if (region === 'EU' || region === 'NA' || region === 'AS') {
    const regionalRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[region] ? RECRUITER_ROLE_IDS[region] : null;
    addRoleMembers(regionalRoleId);

    if (region === 'EU') {
      addRoleMembers(ROLE_IDS.RECRUITER);
      addRoleMembers(ROLE_IDS.TRIAL_RECRUITER);
      for (const r of staffRoleIds) addRoleMembers(r);
    }

    return Array.from(ids);
  }

  for (const rg of ['EU', 'NA', 'AS']) {
    const regionalRoleId = RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS[rg] ? RECRUITER_ROLE_IDS[rg] : null;
    addRoleMembers(regionalRoleId);
  }
  addRoleMembers(ROLE_IDS.RECRUITER);
  addRoleMembers(ROLE_IDS.TRIAL_RECRUITER);
  for (const r of staffRoleIds) addRoleMembers(r);

  return Array.from(ids);
}

module.exports = {
  data: {
    name: 'recruitment_report',
    description: 'Admin: show recruiting data for all recruiters (optionally filtered by region)'
  },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ content: '❌ Administrator permission required.' });
    }

    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.' });
    }

    const rawRegion = interaction.options && typeof interaction.options.getString === 'function'
      ? interaction.options.getString('region')
      : null;

    const region = rawRegion && ['EU', 'NA', 'AS', 'ALL'].includes(rawRegion) ? rawRegion : 'ALL';

    await interaction.deferReply();

    try {
      if (interaction.guild.members && typeof interaction.guild.members.fetch === 'function') {
        await interaction.guild.members.fetch().catch(() => {});
      }
    } catch (e) {
      void e;
    }

    const recruiterIds = await resolveRecruiterIdsForRegion(interaction.guild, region);
    if (!recruiterIds.length) {
      return interaction.editReply({ content: `No recruiters found for ${region}.` });
    }

    const results = [];

    const now = new Date();
    const weekStart = (new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), 0, 0, 0, 0))).getTime() - (((now.getUTCDay() + 6) % 7) * 24 * 60 * 60 * 1000);
    const prevWeekStart = weekStart - (7 * 24 * 60 * 60 * 1000);

    for (const id of recruiterIds) {
      const member = await interaction.guild.members.fetch(id).catch(() => null);

      const totalAllRow = await db.get(
        'SELECT COUNT(*) as c FROM recruits WHERE recruiter_id = ? AND valid = 1',
        id
      );
      const totalAll = totalAllRow ? totalAllRow.c : 0;

      const stats7d = await calculate7DayStats(db, id, interaction.guild).catch(() => ({ recruits7d: 0, activityRate: 0, retention: 0 }));
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

      // "Attention" means: missed quota last week AND currently below minReq.
      const missKey = `quota_last_miss_${id}`;
      const lastMiss = await db.get('SELECT timestamp FROM system_events WHERE key = ? LIMIT 1', missKey).catch(() => null);
      const attention = !!lastMiss && Number(lastMiss.timestamp) === prevWeekStart;

      let newStaffCheck = await isNewStaff(db, id).catch(() => false);
      if (totalAll === 0) newStaffCheck = true;

      const roleBase = getBaseRequirement(member);
      const isTrialRecruiter = !!member && !!member.roles && !!member.roles.cache && member.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !member.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

      const minReq = isTrialRecruiter
        ? 3
        : calculateMinRecruitsFixed({
            roleBase,
            member,
            recruits7d: stats7d.recruits7d,
            activityRate: stats7d.activityRate,
            retention: stats7d.retention,
            warnings: activeWarnings,
            previousMinReq,
            absent: !!absence,
            isNewStaff: newStaffCheck
          });

      const status = getRecruiterStatus({ recruits7d: stats7d.recruits7d, minReq, activeWarnings, absent: !!absence, attention });

      results.push({
        id,
        tag: member && member.user ? member.user.tag : null,
        recruits7d: stats7d.recruits7d,
        retention: stats7d.retention,
        totalAll,
        minReq,
        activeWarnings,
        status
      });
    }

    const buckets = [
      { key: 'DEMOTION', title: 'Demotion watch (2+ warnings)' },
      { key: 'FAILING', title: 'Failing' },
      { key: 'ATTENTION', title: 'Attention' },
      { key: 'PASSING', title: 'Passing' },
      { key: 'GOOD', title: 'Good' },
      { key: 'ABSENT', title: 'Absent' }
    ];

    const grouped = new Map(buckets.map(b => [b.key, []]));
    for (const r of results) {
      const key = r.status && r.status.bucket ? r.status.bucket : 'PASSING';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key).push(r);
    }

    for (const [, arr] of grouped.entries()) {
      arr.sort((a, b) => {
        if (b.activeWarnings !== a.activeWarnings) return b.activeWarnings - a.activeWarnings;
        if (b.minReq !== a.minReq) return b.minReq - a.minReq;
        return (b.recruits7d || 0) - (a.recruits7d || 0);
      });
    }

    const embed = new EmbedBuilder()
      .setTitle(`Recruitment Report (${region})`)
      .setColor(0x00AAFF)
      .setTimestamp();

    let fieldCount = 0;
    for (const b of buckets) {
      const arr = grouped.get(b.key) || [];
      if (!arr.length) continue;

      const lines = arr.map(x => {
        const perf = `${x.recruits7d}/${x.minReq}`;
        const ret = formatPct(x.retention);
        const warn = `${x.activeWarnings}`;
        return `<@${x.id}> — ${perf} — ret ${ret} — warns ${warn} — all ${x.totalAll}`;
      });

      const chunks = chunkLines(lines, 1024);
      for (let i = 0; i < chunks.length; i++) {
        if (fieldCount >= 24) break;
        const fname = i === 0 ? b.title : `${b.title} (${i + 1})`;
        embed.addFields({ name: fname, value: chunks[i] });
        fieldCount++;
      }
      if (fieldCount >= 24) break;
    }

    return interaction.editReply({ embeds: [embed] });
  }
};

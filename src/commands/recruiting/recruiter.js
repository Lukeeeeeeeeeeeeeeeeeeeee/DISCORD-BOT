const db = require('../../db_async');
const { EmbedBuilder } = require('discord.js');
const {
  ROLE_IDS,
  RECRUITER_ROLE_IDS,
  TESTING_USER_ID
} = require('../../constants');
const { hasRecruiterOrStaffPermissions, hasAdminOrStaffPermissions } = require('../../lib/permissions');
const { formatPointsValue } = require('../../lib/economy');
const { formatDiscordTimestamp, formatUtcDate } = require('../../lib/time');
const { clampText, sanitizeForEmbed } = require('../../lib/text');
const { resolveGuildId } = require('../../lib/guild');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const { handleBuy } = require('../../services/recruiting/recruiter-buy-service');
const {
  handleMultiplierList,
  handleMultiplierView,
  handleMultiplierActive,
  handleMultiplierApply,
  handleMultiplierEvent,
  handleMultiplierReset
} = require('../../services/recruiting/recruiter-multiplier-service');
const {
  calculate7DayStats,
  getPreviousMinReq,
  calculateMinRecruitsFixed,
  getBaseRequirement,
  isNewStaff,
  getRecruiterStatus
} = require('../../lib/recruiting-system');
const { getWeekStartUtcTs } = require('../../lib/week');

function toUnixSeconds(ms) {
  return Math.floor(ms / 1000);
}

function safeDaysLeftFromEndDate(endDateStr) {
  if (!endDateStr) return null;
  const d = new Date(`${endDateStr}T23:59:59.000Z`);
  const diffMs = d.getTime() - Date.now();
  if (!Number.isFinite(diffMs)) return null;
  return Math.ceil(diffMs / (24 * 60 * 60 * 1000));
}

function formatPct(x) {
  if (!Number.isFinite(x)) return '0%';
  return `${Math.round(Math.max(0, Math.min(1, x)) * 100)}%`;
}

function hasRecruiterRole(member) {
  if (!member || !member.roles || !member.roles.cache) return false;
  const recruiterRoleIds = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
  ].filter(Boolean);
  return recruiterRoleIds.some(roleId => member.roles.cache.has(roleId));
}

async function getAverageWeeklyRecruits(db, recruiterId, guildId, weeks = 4) {
  try {
    const rows = await db.all(
      'SELECT recruits7d FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? ORDER BY COALESCE(week_start, timestamp) DESC LIMIT ?',
      guildId,
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
      'SELECT COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ?',
      guildId,
      recruiterId,
      since
    );
    const count = row ? Number(row.c || 0) : 0;
    return Math.round((count / 4) * 10) / 10;
  } catch (e) {
    return 0;
  }
}

async function computeRetentionCounts({ db, guild, recruiterId, cohortStartMs, cohortEndMs, cap = 30 } = {}) {
    if (!db || !guild || !recruiterId) return { cohortSize: 0, retained: 0, sampled: false };

    const rows = await db.all(
        'SELECT recruited_id, created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ? AND created_at < ? ORDER BY created_at DESC',
        resolveGuildId(guild),
        recruiterId,
        cohortStartMs,
        cohortEndMs
    );

    const cohortSize = rows ? rows.length : 0;
    const slice = rows && rows.length > cap ? rows.slice(0, cap) : (rows || []);
    const sampled = !!rows && rows.length > cap;

    const ids = slice.map(r => r.recruited_id);
    const members = await fetchMembersByIds(guild, ids).catch(() => new Map());
    return { cohortSize, retained: members.size, sampled };
}

module.exports = {
    data: { name: 'recruiter' },
    async execute(interaction) {
        // support subcommands: info, buy
        const sub = interaction.options.getSubcommand();
        const guildId = resolveGuildId(interaction.guild || interaction);

        if (sub === 'buy') {
            return handleBuy({ interaction, db, guildId });
        }

        if (sub === 'multiplier-list') {
            return handleMultiplierList({ interaction });
        }

        if (sub === 'multiplier-view') {
            return handleMultiplierView({ interaction, db, guildId });
        }

        if (sub === 'multiplier-active') {
            return handleMultiplierActive({ interaction, db, guildId });
        }

        if (sub === 'multiplier-apply') {
            return handleMultiplierApply({ interaction, db, guildId });
        }

        if (sub === 'multiplier-event') {
            return handleMultiplierEvent({ interaction, db, guildId });
        }

        if (sub === 'multiplier-reset') {
            return handleMultiplierReset({ interaction, db, guildId });
        }
        if (sub === 'info') {
            const member = interaction.options.getUser('member') || interaction.user;
            if (typeof interaction.deferReply === 'function') {
                await interaction.deferReply();
            }
            const respond = (payload) => {
                if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
                    return interaction.editReply(payload);
                }
                return interaction.reply(payload);
            };

            // Check if user has permission to view info (basic check)
            const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
            if (!guildMember) {
                return respond({ content: 'Unable to verify your guild membership.' });
            }

            if (!hasRecruiterOrStaffPermissions(guildMember)) {
                return respond({ content: 'Recruiter/staff only.' });
            }

            if (member.id !== interaction.user.id && !hasAdminOrStaffPermissions(interaction.member)) {
                return respond({ content: 'You can only view your own recruiter info.' });
            }

            if (!interaction.guild) {
                return respond({ content: 'This command can only be used in a server.' });
            }

            // Basic rows
            const rec = await db.get('SELECT * FROM recruiters WHERE guild_id = ? AND id = ?', guildId, member.id);
            const recruits = await db.all('SELECT * FROM recruits WHERE guild_id = ? AND recruiter_id = ? ORDER BY created_at DESC LIMIT 5', guildId, member.id);
            const totalAllRow = await db.get('SELECT COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1', guildId, member.id);
            const totalAll = totalAllRow ? totalAllRow.c : 0;

            // Last recruit timestamp
            const lastRow = await db.get('SELECT created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 1', guildId, member.id);
            const lastTs = lastRow ? lastRow.created_at : null;
            const activeWarningsRow = await db.get('SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)', guildId, member.id, Date.now());
            const totalWarningsRow = await db.get('SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0', guildId, member.id);

            // Active multiplier and multiplier history
            const econ = require('../../lib/economy');
            const mul = await econ.getActiveMultiplier(db, member.id, { guildId });
            const multipliers = await db.all('SELECT * FROM multipliers WHERE guild_id = ? AND recruiter_id = ? ORDER BY expires_at DESC', guildId, member.id);

            // Purchases and flags/warnings samples
            const purchases = await db.all('SELECT * FROM purchases WHERE guild_id = ? AND recruiter_id = ? ORDER BY created_at DESC LIMIT 5', guildId, member.id);
            const recentFlags = await db.all('SELECT * FROM flags WHERE guild_id = ? AND recruiter_id = ? ORDER BY created_at DESC LIMIT 5', guildId, member.id);
            const recentWarnings = await db.all('SELECT * FROM warnings WHERE guild_id = ? AND recruiter_id = ? ORDER BY created_at DESC LIMIT 5', guildId, member.id);

            // Get 7-day stats using current week window
            const weekStart = getWeekStartUtcTs();
            const statsWindow = { sinceTs: weekStart, untilTs: Date.now() };
            const stats7d = await calculate7DayStats(db, member.id, interaction.guild, { ...statsWindow, guildId });
            const avgRecruitsWeek = await getAverageWeeklyRecruits(db, member.id, guildId);
            const avgRecruitsDisplay = Number.isFinite(avgRecruitsWeek)
                ? String(avgRecruitsWeek).replace(/\.0$/, '')
                : '0';

            // Check for active absence
            const absence = await db.get(
                'SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ? AND active = 1 AND end_date >= date("now")',
                guildId,
                member.id
            );

            // Get role base requirement
            const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
            const hasRecruiterRoleFlag = hasRecruiterRole(targetMember);
            const roleBase = getBaseRequirement(targetMember);

            // Check if new staff (first 2 recalcs) - consider when people begin recruiting
            let newStaffCheck = false;
            try {
                newStaffCheck = await isNewStaff(db, member.id, { guildId });
            } catch (e) {
                newStaffCheck = false;
            }
            const isTrialRecruiter = !!targetMember && targetMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER) && !targetMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE);

            const weekCalc = await db.get(
                'SELECT calculated_min_req FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? AND week_start = ? LIMIT 1',
                guildId,
                member.id,
                weekStart
            ).catch(() => null);

            let minReq = weekCalc && weekCalc.calculated_min_req != null ? Number(weekCalc.calculated_min_req) : null;
            let previousMinReq = null;
            if (minReq == null) {
                previousMinReq = await getPreviousMinReq(db, member.id, { guildId });
                minReq = previousMinReq;
            }

            if (minReq == null) {
                minReq = calculateMinRecruitsFixed({
                    roleBase,
                    member: targetMember,
                    recruits7d: stats7d.recruits7d,
                    activityRate: stats7d.activityRate,
                    verifyRate: stats7d.verifyRate,
                    retention: stats7d.retention,
                    warnings: activeWarningsRow ? activeWarningsRow.c : 0,
                    previousMinReq,
                    absent: !!absence,
                    isNewStaff: newStaffCheck
                });
            }

            if (isTrialRecruiter) minReq = 3;
            if (absence) minReq = 0;
            if (!Number.isFinite(minReq)) minReq = 2;

            const recentText = recruits.length
                ? recruits.map(r => `<@${r.recruited_id}> (${formatDiscordTimestamp(r.created_at, 'R')}) - ${formatPointsValue(r.points || 0)} pts`).join('\n')
                : 'None';

            const pointsValue = (member.id === TESTING_USER_ID)
                ? '8'
                : formatPointsValue(rec ? rec.points : 0);

            const statusBase = getRecruiterStatus({
                recruits7d: stats7d.recruits7d,
                minReq,
                activeWarnings: activeWarningsRow ? activeWarningsRow.c : 0,
                absent: !!absence
            });
            let statusLabel = statusBase.label;
            let statusColor = statusBase.color;
            if (targetMember && !hasRecruiterRoleFlag) {
                statusLabel = 'Not a recruiter';
                statusColor = 0x808080;
            } else if (hasRecruiterRoleFlag && newStaffCheck && !absence) {
                statusLabel = 'New Recruiter';
                statusColor = 0x00AAFF;
            }

            const embed = new EmbedBuilder()
                .setTitle(clampText(`Recruiter: ${member.tag}`, 256))
                .addFields(
                    { name: 'Points', value: `${pointsValue}`, inline: true },
                    { name: 'Active Multiplier', value: mul && mul.type ? `${mul.type} - x${mul.value}` : 'None', inline: true },
                    { name: 'Total recruits (all time)', value: `${totalAll}`, inline: true },
                    { name: 'Recruits (7 days)', value: `${stats7d.recruits7d}`, inline: true },
                    { name: 'Verify rate (7d)', value: formatPct(stats7d.verifyRate), inline: true },
                    { name: 'Avg recruits/week', value: avgRecruitsDisplay, inline: true },
                    { name: 'Warnings (active)', value: `${activeWarningsRow ? activeWarningsRow.c : 0}`, inline: true },
                    { name: 'Warnings (all time)', value: `${totalWarningsRow ? totalWarningsRow.c : 0}`, inline: true },
                    { name: 'Min recruits required', value: `${minReq}`, inline: true }
                )
                .addFields(
                    { name: 'Recent recruits (last 5)', value: sanitizeForEmbed(recentText || 'None') },
                    { name: 'Status', value: statusLabel, inline: true }
                )
                .setColor(statusColor)
                .setTimestamp();

            if (absence) {
                const daysLeft = safeDaysLeftFromEndDate(absence.end_date);
                embed.addFields({
                    name: 'Absence details',
                    value: `Until **${absence.end_date}**${Number.isFinite(daysLeft) ? ` (${daysLeft}d left)` : ''}\nSet by: <@${absence.created_by}>`,
                    inline: false
                });
            }

            const now = Date.now();
            const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
            const cohort7d = await computeRetentionCounts({
                db,
                guild: interaction.guild,
                recruiterId: member.id,
                cohortStartMs: now - (14 * 24 * 60 * 60 * 1000),
                cohortEndMs: now - (7 * 24 * 60 * 60 * 1000),
                cap: 25
            });
            const retention7dPct = cohort7d.cohortSize > 0 ? Math.round((cohort7d.retained / cohort7d.cohortSize) * 100) : 0;

            const allTimeEligible = await db.all(
                'SELECT recruited_id, created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at <= ? ORDER BY created_at DESC',
                guildId,
                member.id,
                now - sevenDaysMs
            );
            const allTimeCohortSize = allTimeEligible ? allTimeEligible.length : 0;
            const allTimeSlice = allTimeEligible && allTimeEligible.length > 30 ? allTimeEligible.slice(0, 30) : (allTimeEligible || []);
            const allTimeSampled = !!allTimeEligible && allTimeEligible.length > 30;
            const allTimeIds = allTimeSlice.map(r => r.recruited_id);
            const allTimeMembers = await fetchMembersByIds(interaction.guild, allTimeIds).catch(() => new Map());
            const allTimeRetained = allTimeMembers.size;
            const retentionAllPct = allTimeCohortSize > 0 ? Math.round((allTimeRetained / allTimeCohortSize) * 100) : 0;

            embed.addFields({
                name: 'Retention (7d cohort)',
                value: cohort7d.cohortSize > 0
                    ? `${retention7dPct}% (${cohort7d.retained}/${cohort7d.cohortSize})${cohort7d.sampled ? ' (sampled)' : ''}`
                    : 'N/A',
                inline: true
            });
            embed.addFields({
                name: 'Retention (all time, =7d old)',
                value: allTimeCohortSize > 0
                    ? `${retentionAllPct}% (${allTimeRetained}/${allTimeCohortSize})${allTimeSampled ? ' (sampled)' : ''}`
                    : 'N/A',
                inline: true
            });

            const oldestCandidates = await db.all(
                'SELECT recruited_id, created_at FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 ORDER BY created_at ASC LIMIT 30',
                guildId,
                member.id
            );
            const retainedDurations = [];
            const oldestIds = (oldestCandidates || []).map(r => r.recruited_id);
            const oldestMembers = await fetchMembersByIds(interaction.guild, oldestIds).catch(() => new Map());
            for (const r of (oldestCandidates || [])) {
                if (!oldestMembers.has(r.recruited_id)) continue;
                const days = Math.floor((now - r.created_at) / (24 * 60 * 60 * 1000));
                retainedDurations.push({ recruitedId: r.recruited_id, createdAt: r.created_at, days });
            }
            retainedDurations.sort((a, b) => b.days - a.days);
            const topN = totalAll >= 10 ? 5 : 3;
            const topRetained = retainedDurations.slice(0, topN);
            if (topRetained.length) {
                embed.addFields({
                    name: `Longest retained recruits (top ${topRetained.length})`,
                    value: topRetained
                        .map(r => `<@${r.recruitedId}> - ${r.days}d (recruited <t:${toUnixSeconds(r.createdAt)}:R>)`)
                        .join('\n'),
                    inline: false
                });
            }

            // Add compact summaries for purchases/multipliers if present
            if (purchases.length) {
                embed.addFields({
                    name: 'Recent purchases',
                    value: sanitizeForEmbed(purchases.map(p => `${p.item} - ${formatPointsValue(p.cost)} pts`).join('\n'))
                });
            }
            if (multipliers.length) {
                embed.addFields({
                    name: 'Multipliers (recent)',
                    value: sanitizeForEmbed(multipliers.slice(0, 3).map(m => `${m.type} - x${m.value} (exp ${formatDiscordTimestamp(m.expires_at, 'R')})`).join('\n'))
                });
            }
            if (recentFlags.length) {
                embed.addFields({
                    name: 'Recent flags',
                    value: sanitizeForEmbed(recentFlags.map(f => `${formatDiscordTimestamp(f.created_at, 'R')} - ${f.reason}`).join('\n'))
                });
            }
            if (recentWarnings.length) {
                embed.addFields({
                    name: 'Recent warnings',
                    value: sanitizeForEmbed(recentWarnings.map(w => `${formatDiscordTimestamp(w.created_at, 'R')} - ${w.note || ''}`).join('\n'))
                });
            }

            // Additional info footnote
            embed.setFooter({ text: `7-Day Retention: ${Math.round(stats7d.retention * 100)}% - Last recruit: ${lastTs ? formatUtcDate(lastTs) : 'Never'}` });

            return respond({ embeds: [embed] });
        }
    }
};

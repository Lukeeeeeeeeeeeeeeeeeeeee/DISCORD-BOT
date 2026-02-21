const db = require('../../db_async');
const { EmbedBuilder, PermissionsBitField } = require('discord.js');
const {
  PURCHASE_ITEMS,
  APPROVAL_ONLY_ITEMS,
  PURCHASE_ITEM_ALIASES,
  ROLE_IDS,
  RECRUITER_ROLE_IDS,
  TESTING_USER_ID
} = require('../../constants');
const { hasRecruiterOrStaffPermissions, hasAdminOrStaffPermissions, hasAdministrator, getMemberRoleIds } = require('../../lib/permissions');
const { formatPointsValue } = require('../../lib/economy');
const { formatDiscordTimestamp, formatUtcDate } = require('../../lib/time');
const { clampText, sanitizeForEmbed } = require('../../lib/text');
const { replyError } = require('../../lib/embeds');
const { logUnexpectedError } = require('../../lib/logger');
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

const PURCHASE_ITEM_LABELS = Object.freeze({
  'custom-nickname': 'Custom nickname',
  'vip': 'VIP',
  'mvp': 'MVP',
  'custom-vc': 'Custom VC',
  'custom-role': 'Custom role',
  'custom-suggestion': 'Custom suggestion'
});

function normalizePurchaseItemKey(item) {
  if (!item) return '';
  const value = String(item).trim();
  if (!value) return '';
  if (PURCHASE_ITEM_ALIASES && PURCHASE_ITEM_ALIASES[value]) {
    return PURCHASE_ITEM_ALIASES[value];
  }
  return value;
}

function getPurchaseItemLabel(itemKey) {
  if (!itemKey) return 'Unknown item';
  return PURCHASE_ITEM_LABELS[itemKey] || itemKey;
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

async function postPurchaseLog({ guild, userId, item, cost }) {
  if (!guild) return;
  try {
    const { CHANNELS } = require('../../constants');
    const channelId = CHANNELS && CHANNELS.ECONOMY_NOTIFICATIONS;
    if (!channelId) return;
    const channel = guild.channels && guild.channels.cache
      ? guild.channels.cache.get(channelId)
      : null;
    if (channel && channel.send) {
      const formattedCost = formatPointsValue(cost);
await channel.send(`<@${userId}> bought **${item}** for **${formattedCost}** pts!`).catch(err => {
    console.error('Failed to post purchase log:', err);
});
    }
  } catch (e) {
    // best-effort logging
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

function parseExpiryDateToUtcMs(rawDate) {
    if (!rawDate) return null;
    const value = String(rawDate).trim();
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/);
    if (!match) return null;
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day)) return null;
    if (month < 1 || month > 12 || day < 1 || day > 31) return null;
    const utcMs = Date.UTC(year, month - 1, day, 23, 59, 59, 999);
    return Number.isFinite(utcMs) ? utcMs : null;
}

function buildEventMultiplierType({ label, value, durationDays, expiresAt }) {
    const normalizedLabel = label == null
        ? ''
        : String(label)
            .trim()
            .toLowerCase()
            .replace(/[^a-z0-9_-]+/g, '_')
            .replace(/_+/g, '_')
            .replace(/^_+|_+$/g, '');
    if (normalizedLabel) return `event_${normalizedLabel}`.slice(0, 80);

    const valuePart = String(formatPointsValue(value)).replace('.', '_');
    if (Number.isFinite(durationDays) && durationDays > 0) {
        return `event_x${valuePart}_${Math.floor(durationDays)}d`;
    }
    const isoDate = new Date(expiresAt).toISOString().slice(0, 10);
    return `event_x${valuePart}_${isoDate}`;
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

        if (sub === 'multiplier-list') {
            try {
                const { ECONOMY_CONFIG } = require('../../lib/economy');
                const embed = new EmbedBuilder()
                    .setTitle('Available Multipliers')
                    .setDescription(
                        Object.entries(ECONOMY_CONFIG.MULTIPLIERS)
                            .map(([k, v]) => `**${formatPointsValue(v.value)}x - ${v.days} days** - **${formatPointsValue(v.cost)}** pts (\`${k}\`)`)
                            .join('\n') || 'None available'
                    )
                    .setColor(0x00AAFF)
                    .setTimestamp();

                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                console.error('Failed to show multiplier list', e);
                return replyError(interaction, 'Failed to show multipliers.');
            }
        }

        if (sub === 'multiplier-view') {
            const target = interaction.options.getUser('member') || interaction.user;
            try {
                const econ = require('../../lib/economy');

                let active = null;
                try {
                    active = await econ.getActiveMultiplier(db, target.id, { guildId });
                } catch (e) {
                    active = null;
                }

                const embed = new EmbedBuilder()
                    .setTitle(clampText(`Multiplier for ${target.tag}`, 256))
                    .setDescription(active && active.type ? `Active: **${active.type}** - x${active.value}` : 'No active multiplier.')
                    .setColor(0x00AAFF)
                    .setTimestamp();

                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                console.error('Failed to show multiplier view', e);
                return replyError(interaction, 'Failed to show multiplier.');
            }
        }

        if (sub === 'multiplier-active') {
            try {
                const rows = await db.all(
                    'SELECT recruiter_id, value, type, created_at, expires_at FROM multipliers WHERE guild_id = ? AND expires_at > ? ORDER BY expires_at DESC',
                    guildId,
                    Date.now()
                );

                const embed = new EmbedBuilder()
                    .setTitle('Active Multipliers')
                    .setColor(0x00AAFF)
                    .setTimestamp();

                if (!rows || rows.length === 0) {
                    embed.setDescription('No active multipliers.');
                } else {
                    embed.setDescription(
                        rows
                            .slice(0, 25)
                            .map(r => `<@${r.recruiter_id}> - **${r.type || 'unknown'}** x${r.value} (exp ${formatDiscordTimestamp(r.expires_at, 'R')})`)
                            .join('\n')
                    );
                }

                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                console.error('Failed to show active multipliers', e);
                return replyError(interaction, 'Failed to show active multipliers.');
            }
        }

        if (sub === 'multiplier-apply') {
            if (!hasAdministrator(interaction.member)) return replyError(interaction, 'Admin/Staff only.');

            const getUser = (key) => (interaction.options && typeof interaction.options.getUser === 'function' ? interaction.options.getUser(key) : null);
            const getString = (key) => (interaction.options && typeof interaction.options.getString === 'function' ? interaction.options.getString(key) : null);

            let target = getUser('member') || getUser('user') || getUser('target');
            if (!target) {
                try {
                    target = interaction.options && typeof interaction.options.getUser === 'function' ? interaction.options.getUser() : null;
                } catch (e) {
                    target = null;
                }
            }

            let type = getString('item') || getString('type');
            if (!type) {
                try {
                    type = interaction.options && typeof interaction.options.getString === 'function' ? interaction.options.getString() : null;
                } catch (e) {
                    type = null;
                }
            }

            if (!target || !type) {
                return replyError(interaction, 'Missing target or multiplier type.');
            }

            try {
                let dbConn = db;
                let shouldClose = false;
                if (process.env.NODE_ENV === 'test' && process.env.DATABASE_PATH) {
                    const sqlite3 = require('sqlite3');
                    const { open } = require('sqlite');
                    dbConn = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
                    shouldClose = true;
                }

                const { applyMultiplier } = require('../../lib/economy');
                await applyMultiplier(dbConn, target.id, type, { guildId });

                if (shouldClose) {
                    await dbConn.close();
                }
                const embed = new EmbedBuilder()
                    .setTitle('Multiplier Applied')
                    .setDescription(`Applied **${type}** to <@${target.id}>.`)
                    .setColor(0x00AAFF)
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                console.error('Failed to apply multiplier', e);
                return replyError(interaction, 'Failed to apply multiplier.');
            }
        }

        if (sub === 'multiplier-event') {
            if (!hasAdministrator(interaction.member)) return replyError(interaction, 'Admin/Staff only.');

            const target = interaction.options.getUser('member');
            const value = interaction.options.getNumber('value');
            const cost = interaction.options.getNumber('cost');
            const durationDays = interaction.options.getInteger('duration_days');
            const expiryDateRaw = interaction.options.getString('expiry_date');
            const label = interaction.options.getString('label');

            if (!target || !Number.isFinite(value) || value <= 0) {
                return replyError(interaction, 'Missing target or invalid multiplier value.');
            }
            if (!Number.isFinite(cost) || cost < 0) {
                return replyError(interaction, 'Invalid cost value.');
            }

            const now = Date.now();
            let expiresAt = parseExpiryDateToUtcMs(expiryDateRaw);
            if (!expiresAt && Number.isFinite(durationDays) && durationDays > 0) {
                expiresAt = now + (durationDays * 24 * 60 * 60 * 1000);
            }
            if (!Number.isFinite(expiresAt) || expiresAt <= now) {
                return replyError(interaction, 'Set a future expiry via duration_days or expiry_date (YYYY-MM-DD).');
            }

            const type = buildEventMultiplierType({
                label,
                value,
                durationDays,
                expiresAt
            });

            try {
                const { applyCustomMultiplier } = require('../../lib/economy');
                await db.run('BEGIN TRANSACTION');
                try {
                    if (cost > 0) {
                        await db.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', guildId, target.id);
                        await db.run('UPDATE recruiters SET points = points - ? WHERE guild_id = ? AND id = ? AND points >= ?', cost, guildId, target.id, cost);
                        const updated = await db.get('SELECT changes() AS c');
                        if (!updated || Number(updated.c || 0) === 0) {
                            throw new Error('INSUFFICIENT_POINTS');
                        }
                        await db.run(
                            'INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)',
                            guildId,
                            target.id,
                            `event:${type}`,
                            cost,
                            Date.now()
                        );
                    }

                    await applyCustomMultiplier(
                        db,
                        target.id,
                        {
                            value,
                            type,
                            expiresAt,
                            days: Number.isFinite(durationDays) ? durationDays : null
                        },
                        { guildId }
                    );
                    await db.run('COMMIT');
                } catch (e) {
                    await db.run('ROLLBACK');
                    throw e;
                }
            } catch (e) {
                if (String((e && e.message) || '') === 'INSUFFICIENT_POINTS') {
                    return replyError(interaction, `Target user does not have enough points for cost ${formatPointsValue(cost)}.`);
                }
                console.error('Failed to create event multiplier', e);
                return replyError(interaction, 'Failed to create event multiplier.');
            }

            const embed = new EmbedBuilder()
                .setTitle('Event Multiplier Created')
                .addFields(
                    { name: 'Target', value: `<@${target.id}>`, inline: true },
                    { name: 'Value', value: `x${formatPointsValue(value)}`, inline: true },
                    { name: 'Cost', value: `${formatPointsValue(cost)} pts`, inline: true },
                    { name: 'Expires', value: formatDiscordTimestamp(expiresAt, 'F'), inline: false },
                    { name: 'Type', value: type, inline: false }
                )
                .setColor(0x00AAFF)
                .setTimestamp();

            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'multiplier-reset') {
            if (!hasAdministrator(interaction.member)) return replyError(interaction, 'Admin/Staff only.');

            let target = interaction.options.getUser('member') || interaction.options.getUser('user') || interaction.options.getUser('target') || interaction.options.getUser('recruiter');
            if (!target) {
                try {
                    target = interaction.options.getUser();
                } catch (e) {
                    target = null;
                }
            }

            if (!target) {
                return replyError(interaction, 'Missing target user.');
            }

            try {
                let dbConn = db;
                let shouldClose = false;
                if (process.env.NODE_ENV === 'test' && process.env.DATABASE_PATH) {
                    const sqlite3 = require('sqlite3');
                    const { open } = require('sqlite');
                    dbConn = await open({ filename: process.env.DATABASE_PATH, driver: sqlite3.Database });
                    shouldClose = true;
                }

                const { resetMultipliers } = require('../../lib/economy');
                await resetMultipliers(dbConn, target.id, { guildId });

                if (shouldClose) {
                    await dbConn.close();
                }
                const embed = new EmbedBuilder()
                    .setTitle('Multipliers Reset')
                    .setDescription(`Reset multipliers for <@${target.id}>.`)
                    .setColor(0x00AAFF)
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            } catch (e) {
                console.error('Failed to reset multipliers', e);
                return replyError(interaction, 'Failed to reset multipliers.');
            }
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

        if (sub === 'buy') {
            const requestedItem = interaction.options.getString('item');
            const item = normalizePurchaseItemKey(requestedItem);
            const userId = interaction.user.id;
            const isTest = process.env.NODE_ENV === 'test' || process.env.JEST_WORKER_ID !== undefined;

            // In unit tests, interaction.guild may be undefined.
            const guildMember = interaction.guild && interaction.guild.members && interaction.guild.members.fetch
                ? await interaction.guild.members.fetch(userId).catch(() => null)
                : null;
            const roleSource = guildMember || interaction.member || null;

            // Check if user has permission to buy (basic check)
            const roleIds = getMemberRoleIds(roleSource);

            if (!roleSource || (!roleIds.length && !isTest)) {
                return replyError(interaction, 'Unable to verify your roles right now. Please try again.');
            }

            if (!isTest && roleIds.includes(ROLE_IDS.UNVERIFIED)) {
                return replyError(interaction, 'You must be verified (Rookie+) to purchase items.');
            }

            const verifiedRoleIds = [
                ROLE_IDS.ROOKIE,
                ROLE_IDS.AUTO_PROMOTE_ROLE,
                ...(ROLE_IDS.TEAM_MEMBER ? Object.values(ROLE_IDS.TEAM_MEMBER) : []),
                ROLE_IDS.VIP,
                ROLE_IDS.MVP,
                ROLE_IDS.CUSTOM
            ].filter(Boolean);

            const hasVerifiedRole = verifiedRoleIds.some(roleId => roleIds.includes(roleId));
            const isAllowed = isTest
                ? true
                : (hasRecruiterOrStaffPermissions(roleSource) || hasVerifiedRole);

            if (!isAllowed) {
                return replyError(interaction, 'You need to be verified (Rookie+) or a recruiter/staff to purchase items.');
            }

            const rec = await db.get('SELECT * FROM recruiters WHERE guild_id = ? AND id = ?', guildId, userId);
            const points = (userId === TESTING_USER_ID)
                ? 999999999
                : Number(rec && rec.points ? rec.points : 0);

            // Check if item is a multiplier type
            const { ECONOMY_CONFIG, applyMultiplier } = require('../../lib/economy');
            const multCfg = ECONOMY_CONFIG.MULTIPLIERS[item];
            if (multCfg) {
                const cost = multCfg.cost;
                if (points < cost) return replyError(interaction, 'Not enough points to buy that multiplier.');
                try {
                    await db.run('BEGIN TRANSACTION');
                    await db.run('UPDATE recruiters SET points = points - ? WHERE guild_id = ? AND id = ?', cost, guildId, userId);
                    await applyMultiplier(db, userId, item, { guildId });
                    await db.run('INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)', guildId, userId, item, cost, Date.now());
                    await db.run('COMMIT');
                } catch (e) {
                    try { await db.run('ROLLBACK'); } catch (err) { void err; }
                    logUnexpectedError('economy.buyMultiplier', e, { userId, item });
                    return replyError(interaction, 'Purchase failed. Please try again.');
                }
                await postPurchaseLog({ guild: interaction.guild, userId, item, cost });
                const embed = new EmbedBuilder()
                    .setTitle('Multiplier Purchased')
                    .setDescription(`Applied **${item}** for ${multCfg.days} days for **${formatPointsValue(cost)}** points.`)
                    .setColor(0x00AAFF)
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            }

            if (APPROVAL_ONLY_ITEMS && APPROVAL_ONLY_ITEMS[item]) {
                const label = getPurchaseItemLabel(item);
                const approvalNote = String(APPROVAL_ONLY_ITEMS[item]);
                const embed = new EmbedBuilder()
                    .setTitle('Approval Required')
                    .setDescription(`**${label}** is staff-approved only.\n${approvalNote}\n\nNo points were deducted.`)
                    .setColor(0x00AAFF)
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            }

            const cost = PURCHASE_ITEMS[item];
            if (!Number.isFinite(cost)) {
                // Show available items if item not found
                const multiplierItems = Object.entries(ECONOMY_CONFIG.MULTIPLIERS)
                    .map(([k, v]) => `**${formatPointsValue(v.value)}x - ${v.days} days** - **${formatPointsValue(v.cost)}** pts (\`${k}\`)`)
                    .join('\n');
                const purchaseItems = Object.entries(PURCHASE_ITEMS)
                    .map(([k, c]) => `**${getPurchaseItemLabel(k)}** - **${formatPointsValue(c)}** pts (\`${k}\`)`)
                    .join('\n');
                const approvalOnlyItems = Object.entries(APPROVAL_ONLY_ITEMS || {})
                    .map(([k, note]) => `**${getPurchaseItemLabel(k)}** - ${String(note)} (\`${k}\`)`)
                    .join('\n');
                const embed = new EmbedBuilder()
                    .setTitle('Available Items')
                    .addFields(
                        { name: 'Multipliers', value: multiplierItems || 'None available', inline: false },
                        { name: 'Rewards', value: purchaseItems || 'None available', inline: false },
                        { name: 'Staff approval', value: approvalOnlyItems || 'None', inline: false }
                    )
                    .setColor(0x00AAFF)
                    .setFooter({ text: 'Use /recruiter buy <item_name> to purchase' })
                    .setTimestamp();
                return interaction.reply({ embeds: [embed] });
            }

            if (points < cost) return replyError(interaction, 'Not enough points.');

            const roleGrantMap = {
                'vip': ROLE_IDS.VIP,
                'mvp': ROLE_IDS.MVP
            };
            const grantRoleId = roleGrantMap[item] || null;
            let memberRec = null;
            let grantRole = null;

            if (grantRoleId && interaction.guild) {
                grantRole = interaction.guild.roles.cache.get(grantRoleId) || null;
                if (!grantRole) {
                    return replyError(interaction, 'That role is not configured for purchase right now.');
                }

                memberRec = guildMember
                    || (interaction.guild.members && typeof interaction.guild.members.fetch === 'function'
                        ? await interaction.guild.members.fetch(userId).catch(() => null)
                        : null);
                if (!memberRec) {
                    return replyError(interaction, 'Unable to resolve your member record for role purchase.');
                }

                const botMember = interaction.guild.members && interaction.guild.members.me
                    ? interaction.guild.members.me
                    : (interaction.guild.members && typeof interaction.guild.members.fetch === 'function'
                        ? await interaction.guild.members.fetch(interaction.client.user.id).catch(() => null)
                        : null);
                const canManageRoles = botMember && botMember.permissions && botMember.permissions.has
                    ? botMember.permissions.has(PermissionsBitField.Flags.ManageRoles)
                    : false;
                if (!canManageRoles) {
                    return replyError(interaction, 'Bot lacks Manage Roles permission to grant that item.');
                }
                if (!botMember || !botMember.roles || !botMember.roles.highest) {
                    return replyError(interaction, 'Unable to verify bot role hierarchy for role purchase.');
                }
                if (grantRole.position >= botMember.roles.highest.position) {
                    return replyError(interaction, 'Bot role hierarchy is too low to grant that role.');
                }
                if (memberRec.roles && memberRec.roles.cache && memberRec.roles.cache.has(grantRoleId)) {
                    return replyError(interaction, 'You already have that role.');
                }
            }

            if (grantRoleId && memberRec) {
                try {
                    await memberRec.roles.add(grantRoleId);
                } catch (e) {
                    logUnexpectedError('economy.buyItemRoleGrant', e, { userId, item });
                    return replyError(interaction, 'Failed to grant that role. Please try again later.');
                }
            }

            try {
                await db.run('BEGIN TRANSACTION');
                await db.run('UPDATE recruiters SET points = points - ? WHERE guild_id = ? AND id = ?', cost, guildId, userId);
                await db.run('INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)', guildId, userId, item, cost, Date.now());
                await db.run('COMMIT');
            } catch (e) {
                try { await db.run('ROLLBACK'); } catch (err) { void err; }
                if (grantRoleId && memberRec) {
                    await memberRec.roles.remove(grantRoleId).catch(err => {
                        console.error('Failed to rollback role grant after purchase error:', err);
                    });
                }
                logUnexpectedError('economy.buyItem', e, { userId, item });
                return replyError(interaction, 'Purchase failed. Please try again.');
            }

            await postPurchaseLog({ guild: interaction.guild, userId, item, cost });

            const embed = new EmbedBuilder()
                .setTitle('Purchase Complete')
                .setDescription(`Purchased **${getPurchaseItemLabel(item)}** for **${formatPointsValue(cost)}** points.`)
                .setColor(0x00AAFF)
                .setTimestamp();
            return interaction.reply({ embeds: [embed] });
        }

        if (sub === 'warn') {
            // admin/staff only
            if (!hasAdminOrStaffPermissions(interaction.member)) return replyError(interaction, 'Admin/Staff only.');
            if (typeof interaction.deferReply === 'function') {
                await interaction.deferReply({ flags: 64 });
            }
            const respond = (payload) => {
                if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
                    return interaction.editReply(payload);
                }
                return interaction.reply(payload);
            };
            const member = interaction.options.getUser('member');
            const note = interaction.options.getString('note') || 'Manual warning by staff';
            const expiresDays = interaction.options.getInteger('expires_days');

            // Validate member exists
            const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
            if (!targetMember) {
                return respond({ content: 'Member not found in this guild.' });
            }

            try {
                // Insert warning and increment counter atomically
                const createdAt = Date.now();
                const expiredAt = expiresDays ? (createdAt + (expiresDays * 24 * 60 * 60 * 1000)) : null;
                await db.run('BEGIN TRANSACTION');
                try {
                    await db.run('INSERT INTO warnings (guild_id, recruiter_id, created_at, note, expired_at) VALUES (?, ?, ?, ?, ?)', guildId, member.id, createdAt, note, expiredAt);
                    await db.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', guildId, member.id);
                    await db.run('UPDATE recruiters SET warnings = warnings + 1 WHERE guild_id = ? AND id = ?', guildId, member.id);
                    await db.run('COMMIT');
                } catch (e) {
                    await db.run('ROLLBACK');
                    throw e;
                }

                // DM the user with an embed
                const { EmbedBuilder } = require('discord.js');
                const warnEmbed = new EmbedBuilder()
                    .setTitle('?? Recruiter Warning')
                    .setDescription(`**Reason:** ${note}${expiredAt ? `\n**Expires:** ${formatDiscordTimestamp(expiredAt, 'R')}` : ''}`)
                    .setColor(0xFF8800)
                    .setTimestamp();
                try {
                    const m = await interaction.guild.members.fetch(member.id).catch(() => null);
                    if (m) {
                        await m.send({ embeds: [warnEmbed] }).catch(err => {
                            console.error('Failed to DM recruiter warning:', err);
                        });
                    }
                } catch (e) {
                    console.error('Failed to DM warned member', { memberId: member.id, error: e });
                }

                // Post to staff channel as embed with context
                const { CHANNELS } = require('../../constants');
                const ch = interaction.guild.channels.cache.get(CHANNELS.RECRUITER_WARNINGS);
                if (ch) {
                    const staffEmbed = new EmbedBuilder()
                        .setTitle('?? Recruiter Warning Issued')
                        .addFields(
                            { name: 'Recruiter', value: `<@${member.id}>`, inline: true },
                            { name: 'By', value: `<@${interaction.user.id}>`, inline: true },
                            { name: 'Reason', value: note, inline: false }
                        )
                        .setColor(0xFF4400)
                        .setTimestamp();
                    if (expiredAt) staffEmbed.addFields({ name: 'Expires', value: formatDiscordTimestamp(expiredAt, 'R'), inline: true });
                    ch.send({ embeds: [staffEmbed] }).catch((e) => console.error('Failed to post warning to channel', { channelId: ch.id, error: e }));
                }

                // Update leaderboards
                try {
                    const scheduler = require('../../scheduler');
                    await scheduler.recomputeLeaderboards(db, interaction.guild);
                    await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
                } catch (e) {
                    console.error('Failed to update leaderboards after warning:', e);
                }

                console.info('Warning issued', { recruiterId: member.id, by: interaction.user.id, note, expiredAt });

                return respond({ content: `Warning issued to ${member.tag}. ?` });
            } catch (e) {
                console.error('Failed to issue warning', { error: e });
                return respond({ content: 'Failed to issue warning.' });
            }
        }

        if (sub === 'warnings-revoke') {
            // admin/staff only
            if (!hasAdminOrStaffPermissions(interaction.member)) return replyError(interaction, 'Admin/Staff only.');
            if (typeof interaction.deferReply === 'function') {
                await interaction.deferReply({ flags: 64 });
            }
            const respond = (payload) => {
                if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
                    return interaction.editReply(payload);
                }
                return interaction.reply(payload);
            };
            const member = interaction.options.getUser('member');
            const warningId = interaction.options.getInteger('warning_id');
            try {
                if (warningId) {
                    // Revoke specific warning
                    const warning = await db.get('SELECT * FROM warnings WHERE guild_id = ? AND id = ? AND recruiter_id = ?', guildId, warningId, member.id);
                    if (!warning) {
                        return respond({ content: `Warning #${warningId} not found for ${member.tag}.` });
                    }

                    await db.run('UPDATE warnings SET revoked = 1 WHERE guild_id = ? AND id = ? AND recruiter_id = ?', guildId, warningId, member.id);
                } else {
                    // Revoke all warnings for this recruiter
                    await db.run('UPDATE warnings SET revoked = 1 WHERE guild_id = ? AND recruiter_id = ?', guildId, member.id);
                }

                // Recompute warnings count
                const cntRow = await db.get('SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)', guildId, member.id, Date.now());
                const active = cntRow ? cntRow.c : 0;
                await db.run('INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)', guildId, member.id);
                await db.run('UPDATE recruiters SET warnings = ? WHERE guild_id = ? AND id = ?', active, guildId, member.id);

                // Update leaderboards
                try {
                    const scheduler = require('../../scheduler');
                    await scheduler.recomputeLeaderboards(db, interaction.guild);
                    await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
                } catch (e) {
                    console.error('Failed to update leaderboards after warning revocation:', e);
                }

                return respond({ content: `Revoked ${warningId ? `warning #${warningId}` : 'all warnings'} for ${member.tag}. ?` });
            } catch (e) {
                console.error('Failed to revoke warnings', { error: e });
                return respond({ content: 'Failed to revoke warnings.' });
            }
        }

    }
};


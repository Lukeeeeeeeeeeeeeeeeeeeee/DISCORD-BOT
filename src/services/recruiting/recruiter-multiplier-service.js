const { EmbedBuilder } = require('discord.js');
const {
  formatPointsValue,
  ECONOMY_CONFIG,
  getActiveMultiplier,
  applyMultiplier,
  applyCustomMultiplier,
  resetMultipliers
} = require('../../lib/economy');
const { replyError } = require('../../lib/embeds');
const { formatDiscordTimestamp } = require('../../lib/time');
const { hasAdministrator } = require('../../lib/permissions');
const { logUnexpectedError } = require('../../lib/logger');

function reportMultiplierServiceError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'recruiter',
    ...meta
  });
}

function resolveServiceGuildId(guildId, interaction) {
  return guildId || (interaction && interaction.guild && interaction.guild.id) || process.env.GUILD_ID || 'GLOBAL';
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

async function handleMultiplierList({ interaction }) {
  try {
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
    reportMultiplierServiceError('service.recruiter.multiplier.list', e);
    return replyError(interaction, 'Failed to show multipliers.');
  }
}

async function handleMultiplierView({ interaction, db, guildId }) {
  const resolvedGuildId = resolveServiceGuildId(guildId, interaction);
  const target = interaction.options.getUser('member') || interaction.user;
  try {
    let active = null;
    try {
      active = await getActiveMultiplier(db, target.id, { guildId: resolvedGuildId });
    } catch (e) {
      active = null;
    }

    const embed = new EmbedBuilder()
      .setTitle(`Multiplier for ${target.tag}`.slice(0, 256))
      .setDescription(active && active.type ? `Active: **${active.type}** - x${active.value}` : 'No active multiplier.')
      .setColor(0x00AAFF)
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  } catch (e) {
    reportMultiplierServiceError('service.recruiter.multiplier.view', e, {
      targetId: target ? target.id : null,
      guildId: resolvedGuildId
    });
    return replyError(interaction, 'Failed to show multiplier.');
  }
}

async function handleMultiplierActive({ interaction, db, guildId }) {
  const resolvedGuildId = resolveServiceGuildId(guildId, interaction);
  try {
    const rows = await db.all(
      'SELECT recruiter_id, value, type, created_at, expires_at FROM multipliers WHERE guild_id = ? AND expires_at > ? ORDER BY expires_at DESC',
      resolvedGuildId,
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
    reportMultiplierServiceError('service.recruiter.multiplier.active', e, { guildId: resolvedGuildId });
    return replyError(interaction, 'Failed to show active multipliers.');
  }
}

async function handleMultiplierApply({ interaction, db, guildId }) {
  const resolvedGuildId = resolveServiceGuildId(guildId, interaction);
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
    await applyMultiplier(db, target.id, type, { guildId: resolvedGuildId });
    const embed = new EmbedBuilder()
      .setTitle('Multiplier Applied')
      .setDescription(`Applied **${type}** to <@${target.id}>.`)
      .setColor(0x00AAFF)
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  } catch (e) {
    reportMultiplierServiceError('service.recruiter.multiplier.apply', e, {
      guildId: resolvedGuildId,
      targetId: target ? target.id : null,
      type
    });
    return replyError(interaction, 'Failed to apply multiplier.');
  }
}

async function handleMultiplierReset({ interaction, db, guildId }) {
  const resolvedGuildId = resolveServiceGuildId(guildId, interaction);
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
    await resetMultipliers(db, target.id, { guildId: resolvedGuildId });
    const embed = new EmbedBuilder()
      .setTitle('Multipliers Reset')
      .setDescription(`Reset multipliers for <@${target.id}>.`)
      .setColor(0x00AAFF)
      .setTimestamp();
    return interaction.reply({ embeds: [embed] });
  } catch (e) {
    reportMultiplierServiceError('service.recruiter.multiplier.reset', e, {
      guildId: resolvedGuildId,
      targetId: target ? target.id : null
    });
    return replyError(interaction, 'Failed to reset multipliers.');
  }
}

async function handleMultiplierEvent({ interaction, db, guildId }) {
  const resolvedGuildId = resolveServiceGuildId(guildId, interaction);
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
    await db.run('BEGIN TRANSACTION');
    try {
      if (cost > 0) {
        await db.run(
          'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
          resolvedGuildId,
          target.id
        );
        await db.run(
          'UPDATE recruiters SET points = points - ? WHERE guild_id = ? AND id = ? AND points >= ?',
          cost,
          resolvedGuildId,
          target.id,
          cost
        );
        const updated = await db.get('SELECT changes() AS c');
        if (!updated || Number(updated.c || 0) === 0) {
          throw new Error('INSUFFICIENT_POINTS');
        }
        await db.run(
          'INSERT INTO purchases (guild_id, recruiter_id, item, cost, created_at) VALUES (?, ?, ?, ?, ?)',
          resolvedGuildId,
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
        { guildId: resolvedGuildId }
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
    reportMultiplierServiceError('service.recruiter.multiplier.event', e, {
      guildId: resolvedGuildId,
      targetId: target ? target.id : null,
      type
    });
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

module.exports = {
  handleMultiplierList,
  handleMultiplierView,
  handleMultiplierActive,
  handleMultiplierApply,
  handleMultiplierEvent,
  handleMultiplierReset
};

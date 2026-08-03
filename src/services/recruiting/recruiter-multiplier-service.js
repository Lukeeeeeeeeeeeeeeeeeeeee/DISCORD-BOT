const { EmbedBuilder } = require('discord.js');
const {
  formatPointsValue,
  ECONOMY_CONFIG,
  getActiveMultiplier,
  applyMultiplier,
  resetMultipliers
} = require('../../lib/economy');
const { replyError } = require('../../lib/embeds');
const { formatDiscordTimestamp } = require('../../lib/time');
const { hasAdministrator } = require('../../lib/permissions');

function resolveServiceGuildId(guildId, interaction) {
  return guildId || (interaction && interaction.guild && interaction.guild.id) || process.env.GUILD_ID || 'GLOBAL';
}

async function handleMultiplierList({ interaction }) {
  try {
    const embed = new EmbedBuilder()
      .setTitle('Available Multipliers')
      .setDescription(
        Object.entries(ECONOMY_CONFIG.MULTIPLIERS)
          .map(([k, v]) => `**${k}** - x${v.value} for ${v.days}d - **${formatPointsValue(v.cost)}** pts`)
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
    console.error('Failed to show multiplier view', e);
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
    console.error('Failed to show active multipliers', e);
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
    console.error('Failed to apply multiplier', e);
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
    console.error('Failed to reset multipliers', e);
    return replyError(interaction, 'Failed to reset multipliers.');
  }
}

module.exports = {
  handleMultiplierList,
  handleMultiplierView,
  handleMultiplierActive,
  handleMultiplierApply,
  handleMultiplierReset
};

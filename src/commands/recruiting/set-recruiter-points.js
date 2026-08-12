const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../../db_async');
const { resolveGuildId } = require('../../lib/guild');
const { formatPointsValue } = require('../../lib/economy');
const { hasAdministrator } = require('../../lib/permissions');
const scheduler = require('../../scheduler');

function withTimeout(promise, ms, label) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${label || 'Operation'} timed out after ${ms}ms`)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

async function safeEdit(interaction, content) {
  try {
    if (interaction.deferred || interaction.replied) {
      return await interaction.editReply({ content });
    }
    return await interaction.reply({ content, ephemeral: true });
  } catch (e) {
    console.error('safeEdit failed:', e);
  }
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-recruiter-points')
    .setDescription('Set a recruiter\'s TOTAL recruitment points (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set a recruiter\'s total recruitment points')
        .addUserOption(option =>
          option.setName('member')
            .setDescription('The recruiter')
            .setRequired(true))
        .addNumberOption(option =>
          option.setName('points')
            .setDescription('New total points')
            .setRequired(true)
            .setMinValue(0))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for adjustment (optional)')
            .setRequired(false))),

  async execute(interaction, _client, dbHandle = null) {
    const database = dbHandle || db;

    // Acknowledge immediately so the interaction can never time out ("application did not respond").
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    // Run all work detached and timeout-guarded so a slow DB op or Discord fetch
    // can never leave the interaction stuck on "thinking" / "did not respond".
    withTimeout(runCommand(interaction, database), 25000, 'command')
      .catch(err => {
        console.error('set-recruiter-points error:', err);
        safeEdit(interaction, `❌ ${err && err.message ? err.message : err}`);
      });
    return;
  }
};

async function runCommand(interaction, database) {
  if (!hasAdministrator(interaction.member)) {
    return safeEdit(interaction, '❌ Administrator permission required.');
  }
  if (!interaction.guild) {
    return safeEdit(interaction, '❌ This command can only be used in a server.');
  }

  const member = interaction.options.getUser('member');
  const reason = interaction.options.getString('reason') || 'Manual adjustment by admin';
  const guildId = resolveGuildId(interaction.guild);

  if (!member) {
    return safeEdit(interaction, 'Please provide a valid member.');
  }

  // Best-effort guild membership check; admin override proceeds even if the fetch fails.
  const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
  const newPoints = interaction.options.getNumber('points');

  const work = async () => {
    await database.run(
      'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
      guildId,
      member.id
    );

    const existing = await database.get(
      'SELECT CAST(points AS REAL) AS points FROM recruiters WHERE guild_id = ? AND id = ?',
      guildId,
      member.id
    );
    const previousPoints = existing ? Number(existing.points || 0) : 0;

    await database.run(
      'UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?',
      newPoints,
      guildId,
      member.id
    );

    await database.run(
      'INSERT INTO recruiter_points_ledger (guild_id, recruiter_id, delta, reason, ref_type, ref_id, resulting_points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      guildId,
      member.id,
      newPoints - previousPoints,
      reason,
      'admin_set',
      `admin:${interaction.user.id}`,
      newPoints,
      Date.now()
    ).catch(() => {});

    return { previousPoints, newPoints, targetMember, reason };
  };

  const result = await withTimeout(work(), 20000, 'points update');

  await safeEdit(interaction,
    `✅ Set **${result.targetMember ? result.targetMember.user.tag : member.tag}**'s total recruitment points to **${formatPointsValue(result.newPoints)}**\n` +
    `Previous: ${formatPointsValue(result.previousPoints)}\n` +
    `Change: ${result.newPoints - result.previousPoints >= 0 ? '+' : ''}${formatPointsValue(result.newPoints - result.previousPoints)}\n` +
    `Reason: ${result.reason}`
  );

  // Refresh leaderboards in the background, without the heavy full member fetch.
  withTimeout(
    scheduler.recomputeLeaderboards(database, interaction.guild, { skipMemberCache: true }),
    60000,
    'recompute'
  ).catch(e => console.error('Failed to refresh leaderboards:', e));
}

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../../db_async');
const { resolveGuildId } = require('../../lib/guild');
const { formatPointsValue } = require('../../lib/economy');
const { hasAdministrator } = require('../../lib/permissions');
const { withTransaction } = require('../../lib/transactions');
const { getWeekStartUtcTs } = require('../../lib/week');
const { RECRUITER_ROLE_IDS } = require('../../constants');
const scheduler = require('../../scheduler');

const REGION_CHOICES = ['EU', 'NA', 'AS'];

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

function inferRegion(member) {
  if (!member || !member.roles || !member.roles.cache) return null;
  for (const [region, roleId] of Object.entries(RECRUITER_ROLE_IDS || {})) {
    if (roleId && member.roles.cache.has(roleId)) return region;
  }
  return null;
}

function makeSyntheticRecruitedId(recruiterId, i) {
  return `ADMIN_RECRUIT_${recruiterId}_${Date.now()}_${i}_${Math.random().toString(36).slice(2, 8)}`;
}

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-recruiter-stats')
    .setDescription('Manage recruiter statistics (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    // Points subcommand
    .addSubcommand(subcommand =>
      subcommand
        .setName('points')
        .setDescription('Set a recruiter\'s total recruitment points')
        .addUserOption(option =>
          option.setName('member')
            .setDescription('The recruiter')
            .setRequired(true))
        .addNumberOption(option =>
          option.setName('amount')
            .setDescription('New total points')
            .setRequired(true)
            .setMinValue(0))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for adjustment (optional)')
            .setRequired(false)))
    // Recruits subcommand
    .addSubcommand(subcommand =>
      subcommand
        .setName('recruits')
        .setDescription('Set a recruiter\'s weekly recruit count')
        .addUserOption(option => 
          option.setName('member')
            .setDescription('The recruiter')
            .setRequired(true))
        .addIntegerOption(option => 
          option.setName('amount')
            .setDescription('New weekly recruit count')
            .setRequired(true)
            .setMinValue(0))
        .addStringOption(option => 
          option.setName('region')
            .setDescription('Region (defaults to recruiter\'s regional role)')
            .setRequired(false)
            .addChoices(...REGION_CHOICES.map(r => ({ name: r, value: r }))))
        .addStringOption(option => 
          option.setName('reason')
            .setDescription('Reason (optional)')
            .setRequired(false))),

  async execute(interaction, _client, dbHandle = null) {
    const database = dbHandle || db;

    // Acknowledge immediately so the interaction can never time out
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    // Run all work with proper await so the command doesn't finish prematurely
    // Reduced timeout since we no longer await leaderboard recomputation
    try {
      await withTimeout(runCommand(interaction, database), 15000, 'command');
    } catch (err) {
      console.error('set-recruiter-stats error:', err);
      await safeEdit(interaction, `❌ ${err && err.message ? err.message : err}`);
    }
  }
};

async function runCommand(interaction, database) {
  if (!hasAdministrator(interaction.member)) {
    return safeEdit(interaction, '❌ Administrator permission required.');
  }
  if (!interaction.guild) {
    return safeEdit(interaction, '❌ This command can only be used in a server.');
  }

  const subcommand = interaction.options.getSubcommand();
  
  if (subcommand === 'points') {
    await handlePointsSubcommand(interaction, database);
  } else if (subcommand === 'recruits') {
    await handleRecruitsSubcommand(interaction, database);
  } else {
    return safeEdit(interaction, '❌ Unknown subcommand.');
  }
}

async function handlePointsSubcommand(interaction, database) {
  const member = interaction.options.getUser('member');
  const newPoints = interaction.options.getNumber('amount');
  const reason = interaction.options.getString('reason') || 'Manual adjustment by admin';
  const guildId = resolveGuildId(interaction.guild);

  if (!member) {
    return safeEdit(interaction, 'Please provide a valid member.');
  }

  const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);

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

  const result = await withTimeout(work(), 30000, 'points update');

  await safeEdit(interaction,
    `✅ Set **${result.targetMember ? result.targetMember.user.tag : member.tag}**'s **TOTAL RECRUITMENT POINTS** to **${formatPointsValue(result.newPoints)}**\n` +
    `Previous: ${formatPointsValue(result.previousPoints)}\n` +
    `Change: ${result.newPoints - result.previousPoints >= 0 ? '+' : ''}${formatPointsValue(result.newPoints - result.previousPoints)}\n` +
    `Reason: ${result.reason}\n` +
    `💡 This changes their total points (leaderboard). To change weekly recruits, use \`/set-recruiter-stats recruits\`\n` +
    `⏳ Leaderboard will update in the background...`
  );

  // EMERGENCY FIX: Don't await the leaderboard refresh - it's too slow and causes command timeouts
  // Fire and forget - let it run in the background
  scheduler.recomputeLeaderboards(database, interaction.guild, { skipMemberCache: true })
    .catch(e => console.error('Failed to refresh leaderboards (points):', e));
}

async function handleRecruitsSubcommand(interaction, database) {
  const member = interaction.options.getUser('member');
  const targetCount = interaction.options.getInteger('amount');
  const reason = interaction.options.getString('reason') || 'Manual adjustment by admin';
  const guildId = resolveGuildId(interaction.guild);

  if (!member) {
    return safeEdit(interaction, 'Please provide a valid member.');
  }

  const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);

  // Determine region
  let region = interaction.options.getString('region');
  const roleRegion = inferRegion(targetMember);
  const requestedRegion = region;
  if (!region) {
    region = roleRegion;
  } else if (roleRegion && region !== roleRegion) {
    region = roleRegion;
  }
  if (!region || !REGION_CHOICES.includes(region)) {
    return safeEdit(interaction, 'Could not determine region. Ensure the recruiter has a regional recruiter role, or specify a valid region (EU/NA/AS).');
  }

  const weekStart = getWeekStartUtcTs();
  const regionNote = (requestedRegion && requestedRegion !== region)
    ? ` (used ${region} from recruiter's role; ${requestedRegion} would not display on their board)`
    : '';

  const work = async () => {
    const currentRow = await database.get(
      'SELECT COUNT(*) AS c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND region = ? AND valid = 1 AND created_at >= ?',
      guildId, member.id, region, weekStart
    );
    const current = currentRow ? Number(currentRow.c || 0) : 0;
    const diff = targetCount - current;

    await applyRecruitDelta(database, guildId, member.id, region, weekStart, diff);

    const newCountRow = await database.get(
      'SELECT COUNT(*) AS c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND region = ? AND valid = 1 AND created_at >= ?',
      guildId, member.id, region, weekStart
    );
    const newCount = newCountRow ? Number(newCountRow.c || 0) : 0;

    return { newCount, region, targetMember, reason, regionNote };
  };

  const result = await withTimeout(work(), 30000, 'recruits update');

  await safeEdit(interaction,
    `✅ Set **${result.targetMember ? result.targetMember.user.tag : member.tag}**'s **WEEKLY RECRUITS** to **${result.newCount}** (${result.region})${result.regionNote}\n` +
    `New weekly recruit count: ${result.newCount}\n` +
    `Reason: ${result.reason}\n` +
    `💡 This changes weekly recruits only. To change total points, use \`/set-recruiter-stats points\`\n` +
    `⏳ Leaderboard will update in the background...`
  );

  // EMERGENCY FIX: Don't await the leaderboard refresh - it's too slow and causes command timeouts
  // Fire and forget - let it run in the background
  scheduler.recomputeLeaderboards(database, interaction.guild, { skipMemberCache: true })
    .catch(e => console.error('Failed to refresh leaderboards (recruits):', e));
}

async function applyRecruitDelta(database, guildId, recruiterId, region, weekStart, delta) {
  if (!Number.isFinite(delta) || delta === 0) return 0;

  if (delta > 0) {
    await withTransaction(database, async (tx) => {
      for (let i = 0; i < delta; i++) {
        const createdAt = Date.now() - ((delta - 1 - i) * 1000);
        await tx.run(
          'INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, points, created_at, valid) VALUES (?, ?, ?, ?, 1, ?, 1)',
          guildId, recruiterId, makeSyntheticRecruitedId(recruiterId, i), region, createdAt
        );
      }
    });
    return delta;
  }

  const toRemove = Math.abs(delta);
  const rows = await database.all(
    'SELECT id FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND region = ? AND valid = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT ?',
    guildId, recruiterId, region, weekStart, toRemove
  );
  await withTransaction(database, async (tx) => {
    for (const r of (rows || [])) {
      await tx.run('DELETE FROM recruits WHERE guild_id = ? AND id = ?', guildId, r.id);
    }
  });
  return -((rows || []).length);
}

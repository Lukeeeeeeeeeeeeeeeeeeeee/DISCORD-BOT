const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../../db_async');
const { resolveGuildId } = require('../../lib/guild');
const { hasAdministrator } = require('../../lib/permissions');
const { withTransaction } = require('../../lib/transactions');
const { getWeekStartUtcTs } = require('../../lib/week');
const { RECRUITER_ROLE_IDS } = require('../../constants');
const scheduler = require('../../scheduler');

const REGION_CHOICES = ['EU', 'NA', 'AS'];

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
    .setName('set-recruiter-recruits')
    .setDescription('Set a recruiter\'s TOTAL recruits for the current week (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('set')
        .setDescription('Set the total weekly recruit count')
        .addUserOption(option => option.setName('member').setDescription('The recruiter').setRequired(true))
        .addIntegerOption(option => option.setName('count').setDescription('New total recruit count for the week').setRequired(true).setMinValue(0))
        .addStringOption(option => option.setName('region').setDescription('Region (defaults to recruiter\'s regional role)').setRequired(false).addChoices(...REGION_CHOICES.map(r => ({ name: r, value: r }))))
        .addStringOption(option => option.setName('reason').setDescription('Reason (optional)').setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add or remove weekly recruits')
        .addUserOption(option => option.setName('member').setDescription('The recruiter').setRequired(true))
        .addIntegerOption(option => option.setName('amount').setDescription('Amount to add (negative to remove)').setRequired(true))
        .addStringOption(option => option.setName('region').setDescription('Region (defaults to recruiter\'s regional role)').setRequired(false).addChoices(...REGION_CHOICES.map(r => ({ name: r, value: r }))))
        .addStringOption(option => option.setName('reason').setDescription('Reason (optional)').setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('reset')
        .setDescription('Remove all weekly recruits for a recruiter')
        .addUserOption(option => option.setName('member').setDescription('The recruiter').setRequired(true))
        .addStringOption(option => option.setName('region').setDescription('Region (defaults to recruiter\'s regional role)').setRequired(false).addChoices(...REGION_CHOICES.map(r => ({ name: r, value: r }))))
        .addStringOption(option => option.setName('reason').setDescription('Reason (optional)').setRequired(false))),

  async execute(interaction, _client, dbHandle = null) {
    const database = dbHandle || db;

    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
    }

    if (!hasAdministrator(interaction.member)) {
      return interaction.editReply({ content: '❌ Administrator permission required.' });
    }
    if (!interaction.guild) {
      return interaction.editReply({ content: '❌ This command can only be used in a server.' });
    }

    const sub = interaction.options.getSubcommand();
    const member = interaction.options.getUser('member');
    const reason = interaction.options.getString('reason') || 'Manual adjustment by admin';
    const guildId = resolveGuildId(interaction.guild);

    if (!member) {
      return interaction.editReply({ content: 'Please provide a valid member.' });
    }
    const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
    if (!targetMember) {
      return interaction.editReply({ content: 'That member is not in this server.' });
    }

    let region = interaction.options.getString('region');
    if (!region) region = inferRegion(targetMember);
    if (!region || !REGION_CHOICES.includes(region)) {
      return interaction.editReply({ content: 'Could not determine region. Please specify the `region` option (EU/NA/AS).' });
    }

    const weekStart = getWeekStartUtcTs();

    try {
      let changed = 0;
      let actionLabel = '';

      if (sub === 'set') {
        const target = interaction.options.getInteger('count');
        const currentRow = await database.get(
          'SELECT COUNT(*) AS c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND region = ? AND valid = 1 AND created_at >= ?',
          guildId, member.id, region, weekStart
        );
        const current = currentRow ? Number(currentRow.c || 0) : 0;
        const diff = target - current;
        actionLabel = `Set weekly recruits to **${target}** (${region})`;
        changed = await applyRecruitDelta(database, guildId, member.id, region, weekStart, diff);
      } else if (sub === 'add') {
        const amount = interaction.options.getInteger('amount');
        actionLabel = `Adjusted weekly recruits by **${amount >= 0 ? '+' : ''}${amount}** (${region})`;
        changed = await applyRecruitDelta(database, guildId, member.id, region, weekStart, amount);
      } else if (sub === 'reset') {
        const ids = await database.all(
          'SELECT id FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND region = ? AND valid = 1 AND created_at >= ?',
          guildId, member.id, region, weekStart
        );
        await withTransaction(database, async (tx) => {
          for (const r of (ids || [])) {
            await tx.run('DELETE FROM recruits WHERE guild_id = ? AND id = ?', guildId, r.id);
          }
        });
        changed = (ids || []).length;
        actionLabel = `Reset weekly recruits (removed **${changed}**) (${region})`;
      } else {
        return interaction.editReply({ content: '❌ Unknown subcommand.' });
      }

      const newCountRow = await database.get(
        'SELECT COUNT(*) AS c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND region = ? AND valid = 1 AND created_at >= ?',
        guildId, member.id, region, weekStart
      );
      const newCount = newCountRow ? Number(newCountRow.c || 0) : 0;

      await interaction.editReply({
        content: `✅ ${actionLabel}\n` +
                 `Recruiter: ${targetMember.user.tag}\n` +
                 `New weekly recruit count: **${newCount}** (${region})\n` +
                 `Reason: ${reason}`
      });
    } catch (error) {
      console.error('set-recruiter-recruits command error:', error);
      return interaction.editReply({ content: `❌ Failed to update recruits: ${error.message}` });
    }

    // Refresh leaderboards in the background so it can never block the reply.
    scheduler.recomputeLeaderboards(database, interaction.guild)
      .catch(e => console.error('Failed to refresh leaderboards:', e));
  }
};

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

const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../../db_async');
const { resolveGuildId } = require('../../lib/guild');
const { replyError } = require('../../lib/embeds');
const { formatPointsValue } = require('../../lib/economy');
const { hasAdministrator } = require('../../lib/permissions');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('set-recruiter-stats')
    .setDescription('Manually set recruiter points or recruit count (Admin only)')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand(subcommand =>
      subcommand
        .setName('points')
        .setDescription('Set a recruiter\'s total points')
        .addUserOption(option => 
          option.setName('member')
            .setDescription('The recruiter')
            .setRequired(true))
        .addNumberOption(option =>
          option.setName('points')
            .setDescription('New points total')
            .setRequired(true)
            .setMinValue(0))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for adjustment (optional)')
            .setRequired(false)))
    .addSubcommand(subcommand =>
      subcommand
        .setName('add-points')
        .setDescription('Add or subtract points from a recruiter')
        .addUserOption(option =>
          option.setName('member')
            .setDescription('The recruiter')
            .setRequired(true))
        .addNumberOption(option =>
          option.setName('amount')
            .setDescription('Amount to add (use negative to subtract)')
            .setRequired(true))
        .addStringOption(option =>
          option.setName('reason')
            .setDescription('Reason for adjustment (optional)')
            .setRequired(false))),

  async execute(interaction, _client, dbHandle = null) {
    const database = dbHandle || db;

    if (!hasAdministrator(interaction.member)) {
      return replyError(interaction, 'Administrator permission required.');
    }

    if (!interaction.guild) {
      return replyError(interaction, 'This command can only be used in a server.');
    }

    // Check if already deferred/replied to avoid double-defer
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply({ ephemeral: true });
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

    try {
      // Ensure recruiter exists in database
      await database.run(
        'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
        guildId,
        member.id
      );

      if (sub === 'points') {
        const newPoints = interaction.options.getNumber('points');
        
        // Get current points
        const existing = await database.get(
          'SELECT CAST(points AS REAL) AS points FROM recruiters WHERE guild_id = ? AND id = ?',
          guildId,
          member.id
        );
        const previousPoints = existing ? Number(existing.points || 0) : 0;

        // Set new points
        await database.run(
          'UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?',
          newPoints,
          guildId,
          member.id
        );

        // Log the change
        await database.run(
          'INSERT INTO recruiter_points_ledger (guild_id, recruiter_id, delta, reason, ref_type, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          guildId,
          member.id,
          newPoints - previousPoints,
          reason,
          'admin_set',
          `admin:${interaction.user.id}`,
          Date.now()
        ).catch(() => {}); // Ignore if table doesn't exist

        // Refresh leaderboards
        try {
          const scheduler = require('../../scheduler');
          await scheduler.recomputeLeaderboards(database, interaction.guild);
        } catch (e) {
          console.error('Failed to refresh leaderboards:', e);
        }

        return interaction.editReply({
          content: `✅ Set **${targetMember.user.tag}**'s points to **${formatPointsValue(newPoints)}**\n` +
                   `Previous: ${formatPointsValue(previousPoints)}\n` +
                   `Change: ${newPoints - previousPoints >= 0 ? '+' : ''}${formatPointsValue(newPoints - previousPoints)}\n` +
                   `Reason: ${reason}`
        });

      } else if (sub === 'add-points') {
        const amount = interaction.options.getNumber('amount');

        // Get current points
        const existing = await database.get(
          'SELECT CAST(points AS REAL) AS points FROM recruiters WHERE guild_id = ? AND id = ?',
          guildId,
          member.id
        );
        const previousPoints = existing ? Number(existing.points || 0) : 0;
        const newPoints = Math.max(0, previousPoints + amount);

        // Update points
        await database.run(
          'UPDATE recruiters SET points = ? WHERE guild_id = ? AND id = ?',
          newPoints,
          guildId,
          member.id
        );

        // Log the change
        await database.run(
          'INSERT INTO recruiter_points_ledger (guild_id, recruiter_id, delta, reason, ref_type, ref_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
          guildId,
          member.id,
          amount,
          reason,
          'admin_adjust',
          `admin:${interaction.user.id}`,
          Date.now()
        ).catch(() => {}); // Ignore if table doesn't exist

        // Refresh leaderboards
        try {
          const scheduler = require('../../scheduler');
          await scheduler.recomputeLeaderboards(database, interaction.guild);
        } catch (e) {
          console.error('Failed to refresh leaderboards:', e);
        }

        return interaction.editReply({
          content: `✅ ${amount >= 0 ? 'Added' : 'Subtracted'} **${formatPointsValue(Math.abs(amount))}** ${amount >= 0 ? 'to' : 'from'} **${targetMember.user.tag}**\n` +
                   `Previous: ${formatPointsValue(previousPoints)}\n` +
                   `New total: ${formatPointsValue(newPoints)}\n` +
                   `Reason: ${reason}`
        });
      }

    } catch (error) {
      console.error('set-recruiter-stats command error:', error);
      return interaction.editReply({
        content: `❌ Failed to update stats: ${error.message}`
      });
    }
  }
};

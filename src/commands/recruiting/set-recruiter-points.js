const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const db = require('../../db_async');
const { resolveGuildId } = require('../../lib/guild');
const { formatPointsValue } = require('../../lib/economy');
const { hasAdministrator } = require('../../lib/permissions');
const scheduler = require('../../scheduler');

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

    // Defer FIRST so the interaction is always acknowledged.
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

    if (sub !== 'set') {
      return interaction.editReply({ content: '❌ Unknown subcommand.' });
    }

    if (!member) {
      return interaction.editReply({ content: 'Please provide a valid member.' });
    }

    const targetMember = await interaction.guild.members.fetch(member.id).catch(() => null);
    if (!targetMember) {
      return interaction.editReply({ content: 'That member is not in this server.' });
    }

    const newPoints = interaction.options.getNumber('points');

    try {
      // Ensure recruiter exists in database
      await database.run(
        'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
        guildId,
        member.id
      );

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
        'INSERT INTO recruiter_points_ledger (guild_id, recruiter_id, delta, reason, ref_type, ref_id, resulting_points, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        guildId,
        member.id,
        newPoints - previousPoints,
        reason,
        'admin_set',
        `admin:${interaction.user.id}`,
        newPoints,
        Date.now()
      ).catch(() => {}); // Ignore if table doesn't exist

      // Reply FIRST so the user always gets a response (fixes the "thinking" hang).
      await interaction.editReply({
        content: `✅ Set **${targetMember.user.tag}**'s total recruitment points to **${formatPointsValue(newPoints)}**\n` +
                 `Previous: ${formatPointsValue(previousPoints)}\n` +
                 `Change: ${newPoints - previousPoints >= 0 ? '+' : ''}${formatPointsValue(newPoints - previousPoints)}\n` +
                 `Reason: ${reason}`
      });
    } catch (error) {
      console.error('set-recruiter-points command error:', error);
      return interaction.editReply({
        content: `❌ Failed to update points: ${error.message}`
      });
    }

    // Refresh leaderboards in the background so it can never block the reply.
    scheduler.recomputeLeaderboards(database, interaction.guild)
      .catch(e => console.error('Failed to refresh leaderboards:', e));
  }
};

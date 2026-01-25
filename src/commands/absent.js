const db = require('../db_async');
const { SlashCommandBuilder } = require('@discordjs/builders');
const { EmbedBuilder } = require('discord.js');
const { hasModPlusPermissions } = require('../lib/recruiting-system');

module.exports = {
  data: {
    name: 'absent',
    description: 'Set absence period for recruiting requirements (MOD+ only)',
  },
  async execute(interaction) {
    // MOD+ only
    if (!hasModPlusPermissions(interaction.member)) {
      return interaction.reply({ content: 'MOD+ only.', flags: 64 });
    }

    const targetUser = interaction.options.getUser('member') || interaction.user;
    const targetId = targetUser.id;
    const targetMention = `<@${targetId}>`;

    if (interaction.guild) {
      const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
      if (!targetMember) {
        return interaction.reply({ content: 'That member is not in this server.', flags: 64 });
      }
    }

    const endDate = interaction.options.getString('date');
    
    // Validate ISO date format
    const dateRegex = /^\d{4}-\d{2}-\d{2}$/;
    if (!dateRegex.test(endDate)) {
      return interaction.reply({ content: 'Invalid date format. Use YYYY-MM-DD format.', flags: 64 });
    }

    // Parse and validate date
    const absenceDate = new Date(endDate);
    if (isNaN(absenceDate.getTime())) {
      return interaction.reply({ content: 'Invalid date. Please use a valid date in YYYY-MM-DD format.', flags: 64 });
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    absenceDate.setHours(0, 0, 0, 0);

    // Must be future date
    if (absenceDate <= today) {
      return interaction.reply({ content: 'Absence date must be in the future.', flags: 64 });
    }

    // Check for existing active absence
    try {
      const existingAbsence = await db.get(
        'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1',
        targetId
      );

      if (existingAbsence) {
        // Update existing absence
        await db.run(
          'UPDATE absences SET end_date = ?, created_by = ? WHERE recruiter_id = ? AND active = 1',
          endDate, interaction.user.id, targetId
        );
      } else {
        // Create new absence
        await db.run(
          'INSERT INTO absences (recruiter_id, start_date, end_date, created_at, created_by, active) VALUES (?, ?, ?, ?, ?, 1)',
          targetId, today.toISOString().split('T')[0], endDate, Date.now(), interaction.user.id
        );
      }

      const embed = new EmbedBuilder()
        .setTitle('📅 Absence Set')
        .setDescription(`${targetMention}'s recruiting requirements have been suspended until **${endDate}**`)
        .addFields(
          { name: 'Start Date', value: today.toISOString().split('T')[0], inline: true },
          { name: 'End Date', value: endDate, inline: true },
          { name: 'Status', value: 'Requirements suspended', inline: true }
        )
        .setColor(0x00AAFF)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });

    } catch (error) {
      console.error('Error setting absence:', error);
      return interaction.reply({ content: 'Failed to set absence. Please try again later.', flags: 64 });
    }
  }
};

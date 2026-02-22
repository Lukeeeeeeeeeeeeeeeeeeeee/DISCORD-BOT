const db = require('../../db_async');
const { EmbedBuilder } = require('discord.js');
const { hasModPlusPermissions } = require('../../lib/recruiting-system');
const { formatUtcDateOnly } = require('../../lib/time');
const { resolveGuildId } = require('../../lib/guild');
const { replyError } = require('../../lib/embeds');
const { logUnexpectedError } = require('../../lib/logger');

module.exports = {
  data: {
    name: 'absent',
    description: 'Set absence period for recruiting requirements (MOD+ only)',
  },
  async execute(interaction) {
    if (!interaction.guild) {
      return replyError(interaction, 'This command can only be used in a server.');
    }
    const guildId = resolveGuildId(interaction.guild);

    // MOD+ only
    if (!hasModPlusPermissions(interaction.member)) {
      return replyError(interaction, 'MOD+ only.');
    }

    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: 64 });
    }
    const respond = (payload) => {
      if ((interaction.deferred || interaction.replied) && typeof interaction.editReply === 'function') {
        return interaction.editReply(payload);
      }
      return interaction.reply(payload);
    };

    const targetUser = interaction.options.getUser('member') || interaction.user;
    const targetId = targetUser.id;
    const targetMention = `<@${targetId}>`;

    const targetMember = await interaction.guild.members.fetch(targetId).catch(() => null);
    if (!targetMember) {
      return replyError(interaction, 'That member is not in this server.');
    }

    const endDateRaw = interaction.options.getString('date');
    if (!endDateRaw) {
      return replyError(interaction, 'Missing required date. Please use YYYY-MM-DD.');
    }

    // Basic YYYY-MM-DD validation before parsing.
    if (!/^\d{4}-\d{2}-\d{2}$/.test(endDateRaw)) {
      return replyError(interaction, 'Invalid date. Please use YYYY-MM-DD format.');
    }

    const dayjs = require('dayjs');
    const parsedDate = dayjs(endDateRaw);

    if (!parsedDate.isValid()) {
      return replyError(interaction, 'Invalid date. Please use YYYY-MM-DD format.');
    }

    const endDate = parsedDate.format('YYYY-MM-DD');
    const todayStart = dayjs().startOf('day');
    if (!parsedDate.isAfter(todayStart)) {
      return replyError(interaction, 'Absence date must be in the future.');
    }

    const todayStr = formatUtcDateOnly();

    // Check for existing active absence
    try {
      const existingAbsence = await db.get(
        'SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ? AND active = 1',
        guildId,
        targetId
      );

      const startDate = existingAbsence && existingAbsence.start_date ? existingAbsence.start_date : todayStr;

      if (existingAbsence) {
        // Update existing absence
        await db.run(
          'UPDATE absences SET end_date = ?, created_by = ?, start_date = ? WHERE guild_id = ? AND recruiter_id = ? AND active = 1',
          endDate, interaction.user.id, startDate, guildId, targetId
        );
      } else {
        // Create new absence
        await db.run(
          'INSERT INTO absences (guild_id, recruiter_id, start_date, end_date, created_at, created_by, active) VALUES (?, ?, ?, ?, ?, ?, 1)',
          guildId, targetId, startDate, endDate, Date.now(), interaction.user.id
        );
      }

      const embed = new EmbedBuilder()
        .setTitle('📅 Absence Set')
        .setDescription(`${targetMention}'s recruiting requirements have been suspended until **${endDate}**`)
        .addFields(
          { name: 'Start Date', value: startDate, inline: true },
          { name: 'End Date', value: endDate, inline: true },
          { name: 'Status', value: 'Requirements suspended', inline: true }
        )
        .setColor(0x00AAFF)
        .setTimestamp();

      return respond({ embeds: [embed] });

    } catch (error) {
      const dispatchResult = await logUnexpectedError('command.absent.execute', error, {
        command: 'absent',
        guildId,
        targetId,
        actorId: interaction.user ? interaction.user.id : null
      });
      return replyError(
        interaction,
        `Failed to set absence. Please try again later.${dispatchResult && dispatchResult.supportId ? ` Support ID: \`${dispatchResult.supportId}\`.` : ''}`
      );
    }
  }
};

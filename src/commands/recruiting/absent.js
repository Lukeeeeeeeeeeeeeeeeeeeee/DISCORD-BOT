const { EmbedBuilder } = require('discord.js');
const { hasModPlusPermissions } = require('../../lib/recruiting-system');
const { replyError } = require('../../lib/embeds');
const { resolveGuildId } = require('../../lib/guild');
const { createResponder } = require('../../lib/respond');
const { setAbsence } = require('../../services/recruiting/absence-service');
const defaultDb = require('../../db_async');
const dayjs = require('dayjs');

module.exports = {
  data: {
    name: 'absent',
    description: 'Set absence period for recruiting requirements (MOD+ only)'
  },
  async execute(interaction, _client, db) {
    if (!interaction.guild) {
      return replyError(interaction, 'This command can only be used in a server.');
    }

    // MOD+ only
    if (!hasModPlusPermissions(interaction.member)) {
      return replyError(interaction, 'MOD+ only.');
    }

    const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
    await defer();

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

    const parsedDate = dayjs(endDateRaw);

    if (!parsedDate.isValid()) {
      return replyError(interaction, 'Invalid date. Please use YYYY-MM-DD format.');
    }

    const endDate = parsedDate.format('YYYY-MM-DD');
    const todayStart = dayjs().startOf('day');
    if (!parsedDate.isAfter(todayStart)) {
      return replyError(interaction, 'Absence date must be in the future.');
    }

    try {
      const dbHandle = db || defaultDb;
      const guildId = resolveGuildId(interaction.guild);
      const record = await setAbsence({
        db: dbHandle,
        guildId,
        recruiterId: targetId,
        createdBy: interaction.user.id,
        endDate
      });

      const embed = new EmbedBuilder()
        .setTitle('?? Absence Set')
        .setDescription(`${targetMention}'s recruiting requirements have been suspended until **${endDate}**`)
        .addFields(
          { name: 'Start Date', value: record.start_date, inline: true },
          { name: 'End Date', value: record.end_date, inline: true },
          { name: 'Status', value: 'Requirements suspended', inline: true }
        )
        .setColor(0x00AAFF)
        .setTimestamp();

      return respond({ embeds: [embed] });
    } catch (error) {
      console.error('Error setting absence:', error);
      return replyError(interaction, 'Failed to set absence. Please try again later.');
    }
  }
};


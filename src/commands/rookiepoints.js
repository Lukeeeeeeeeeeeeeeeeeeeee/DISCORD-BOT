const db = require('../db_async');
const { ROLE_IDS } = require('../constants');
const { hasModPlusPermissions } = require('../lib/recruiting-system');
const { addRookiePoints, formatPoints } = require('../lib/rookie-points');

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rookiepoints')
    .setDescription('Manage rookie points (MOD+ only)')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add points to a rookie')
        .addUserOption(option => option.setName('member').setDescription('The rookie').setRequired(true))
        .addNumberOption(option => option.setName('points').setDescription('Points to add').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove points from a rookie')
        .addUserOption(option => option.setName('member').setDescription('The rookie').setRequired(true))
        .addNumberOption(option => option.setName('points').setDescription('Points to remove').setRequired(true))
    ),
  async execute(interaction) {
    if (!hasModPlusPermissions(interaction.member)) {
      return interaction.reply({ content: 'MOD+ only.' });
    }

    const sub = interaction.options && typeof interaction.options.getSubcommand === 'function'
      ? interaction.options.getSubcommand()
      : 'add';

    if (sub !== 'add' && sub !== 'remove') {
      return interaction.reply({ content: 'Unsupported subcommand.' });
    }

    const targetUser = interaction.options.getUser('member');
    const rawPoints = interaction.options.getNumber('points');

    if (!targetUser || !Number.isFinite(rawPoints)) {
      return interaction.reply({ content: 'Please provide a member and points value.' });
    }

    if (rawPoints <= 0) {
      return interaction.reply({ content: 'Points must be greater than 0.' });
    }

    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    if (!targetMember) {
      return interaction.reply({ content: 'That member is not in this server.' });
    }

    if (!targetMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
      return interaction.reply({ content: 'That member is not a rookie.' });
    }

    const delta = sub === 'remove' ? -rawPoints : rawPoints;
    const result = await addRookiePoints({
      db,
      member: targetMember,
      delta,
      guild: interaction.guild,
      verifierId: interaction.user.id
    });

    if (result.promoted) {
      return interaction.reply({
        content: `Updated ${targetUser.tag} to 10/10 points. Promoted to ${result.teamName}.`
      });
    }

    return interaction.reply({
      content: `Updated ${targetUser.tag} to ${formatPoints(result.points)}/10 points.`
    });
  }
};

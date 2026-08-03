const { SlashCommandBuilder } = require('discord.js');
const { execute } = require('../../services/recruiting/rookie-points-service');

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
  execute
};

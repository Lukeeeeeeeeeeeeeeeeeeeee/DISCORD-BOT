const { SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');
const recruitService = require('../../services/recruiting/recruit-service');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('recruit')
    .setDescription('Recruit a new member into the guild.')
    .addUserOption(option =>
      option.setName('member').setDescription('The member to recruit').setRequired(true))
    .addStringOption(option =>
      option.setName('ign').setDescription('The In-Game Name of the member').setRequired(true))
    .addUserOption(option =>
      option.setName('credit_to').setDescription('Credit this recruit to another recruiter (Admin only)').setRequired(false))
    .addBooleanOption(option =>
      option.setName('admin_bypass').setDescription('Bypass account age and join time checks (Admin only)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .setDMPermission(false),

  async execute(interaction) {
    return recruitService.execute(interaction, interaction ? interaction.client : null);
  }
};

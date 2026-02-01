const { SlashCommandBuilder } = require('discord.js');
const { hasAdminOrStaffPermissions } = require('../lib/permissions');
const { CHANNELS } = require('../constants');
const { runReview } = require('../lib/ai-review');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('ai')
    .setDescription('AI analytics and reviews')
    .addSubcommand(sub => sub
      .setName('review')
      .setDescription('Run a deep AI review of server activity (admin/staff)')
      .addChannelOption(opt => opt
        .setName('channel')
        .setDescription('Channel to post the report (defaults to AI review channel)')
        .setRequired(false))
    ),
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    if (sub !== 'review') {
      return interaction.reply({ content: 'Unsupported subcommand.' });
    }

    if (!hasAdminOrStaffPermissions(interaction.member)) {
      return interaction.reply({ content: 'Admin/Staff only.' });
    }

    if (!interaction.guild) {
      return interaction.reply({ content: 'This command can only be used in a server.' });
    }

    const channelOption = interaction.options.getChannel('channel');
    const channel = channelOption || (CHANNELS.AI_REVIEW ? interaction.guild.channels.cache.get(CHANNELS.AI_REVIEW) : null) || interaction.channel;

    if (channel && typeof channel.isTextBased === 'function' && !channel.isTextBased()) {
      return interaction.reply({ content: 'Please select a text channel for the AI review.' });
    }

    await interaction.deferReply();
    const result = await runReview({ guild: interaction.guild, channelId: channel ? channel.id : null, requesterId: interaction.user.id, force: true });
    if (!result.ok) {
      const reason = result.reason || 'Unknown error';
      const safeReason = reason.length > 1900 ? reason.slice(0, 1900) + '...' : reason;
      return interaction.editReply({ content: `AI review failed: ${safeReason}` });
    }

    const channelText = channel ? ` and posted in <#${channel.id}>` : '';
    return interaction.editReply({ content: `AI review completed${channelText}.` });
  }
};

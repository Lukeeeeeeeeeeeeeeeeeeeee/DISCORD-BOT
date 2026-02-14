const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');
const { buildErrorEmbed } = require('../lib/embeds');
const { createResponder } = require('../lib/respond');
const runtime = require('../lib/runtime');

module.exports = {
  data: {
    name: 'reset_scores',
    description: 'Reset beast mode scores (Admin only)',
    options: [
      {
        name: 'user',
        description: 'User to reset (optional - resets all if not provided)',
        type: 6, // USER
        required: false
      }
    ]
  },
  async execute(interaction) {
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ embeds: [buildErrorEmbed('Administrator permission required.')], flags: 64 });
    }

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }

    const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
    await defer();

    const targetUser = interaction.options.getUser('user');

    try {
      if (targetUser) {
        antiNuke.resetScores(interaction.guild.id, targetUser.id);

        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('Score Reset Successful')
          .setDescription(`Reset beast mode score for ${targetUser.tag}`)
          .addFields(
            { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
            { name: 'New Score', value: '0', inline: true }
          )
          .setTimestamp();

        antiNuke.logAction(interaction.guild.id, {
          type: 'score_reset',
          executorId: interaction.user.id,
          targetUserId: targetUser.id,
          resetType: 'individual'
        });

        return respond({ embeds: [embed] });
      }

      antiNuke.resetScores(interaction.guild.id);

      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('All Scores Reset')
        .setDescription('Reset beast mode scores for all users in this server')
        .addFields(
          { name: 'Server', value: interaction.guild.name, inline: true },
          { name: 'Reset By', value: interaction.user.tag, inline: true }
        )
        .setTimestamp();

      antiNuke.logAction(interaction.guild.id, {
        type: 'score_reset',
        executorId: interaction.user.id,
        resetType: 'all'
      });

      return respond({ embeds: [embed] });
    } catch (error) {
      console.error('Score reset error:', error);
      const embed = buildErrorEmbed(`Failed to reset scores: ${error.message}`, 'Score Reset Failed');
      return respond({ embeds: [embed] });
    }
  }
};

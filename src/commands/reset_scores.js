const { EmbedBuilder } = require('discord.js');
const { ensureCommandAccess } = require('../lib/command-auth');
const { buildErrorEmbed } = require('../lib/embeds');
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
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required.',
      flags: 64
    });
    if (!allowed) return null;

    const antiNuke = runtime.getAntiNuke();
    if (!antiNuke) {
      return interaction.reply({ embeds: [buildErrorEmbed('Anti-nuke system not initialized.')], flags: 64 });
    }

    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply({ flags: 64 });
    }

    const respond = (payload) => {
      if (interaction.deferred || interaction.replied) {
        if (typeof interaction.editReply === 'function') return interaction.editReply(payload);
        if (typeof interaction.followUp === 'function') return interaction.followUp(payload);
      }
      return interaction.reply(payload);
    };

    const targetUser = interaction.options.getUser('user');
    
    try {
      if (targetUser) {
        // Reset specific user
        antiNuke.resetScores(interaction.guild.id, targetUser.id);
        
        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ Score Reset Successful')
          .setDescription(`Reset beast mode score for ${targetUser.tag}`)
          .addFields(
            { name: 'User', value: `${targetUser.tag} (${targetUser.id})`, inline: true },
            { name: 'New Score', value: '0', inline: true }
          )
          .setTimestamp();

        // Log the action
        antiNuke.logAction(interaction.guild.id, {
          type: 'score_reset',
          executorId: interaction.user.id,
          targetUserId: targetUser.id,
          resetType: 'individual'
        });

        return respond({ embeds: [embed] });

      } else {
        // Reset all users
        antiNuke.resetScores(interaction.guild.id);
        
        const embed = new EmbedBuilder()
          .setColor('#00FF00')
          .setTitle('✅ All Scores Reset')
          .setDescription('Reset beast mode scores for all users in this server')
          .addFields(
            { name: 'Server', value: interaction.guild.name, inline: true },
            { name: 'Reset By', value: interaction.user.tag, inline: true }
          )
          .setTimestamp();

        // Log the action
        antiNuke.logAction(interaction.guild.id, {
          type: 'score_reset',
          executorId: interaction.user.id,
          resetType: 'all'
        });

        return respond({ embeds: [embed] });
      }

    } catch (error) {
      console.error('Score reset error:', error);
      
      const embed = buildErrorEmbed(`Failed to reset scores: ${error.message}`, 'Score Reset Failed');
      return respond({ embeds: [embed] });
    }
  }
};

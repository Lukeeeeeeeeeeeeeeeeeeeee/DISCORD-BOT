const { EmbedBuilder } = require('discord.js');
const AntiNuke = require('../lib/antinuke');

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
    // Check admin permissions
    if (!interaction.member.permissions.has('Administrator')) {
      return interaction.reply({ 
        content: '❌ Administrator permission required.', 
        flags: 64 
      });
    }

    const antiNuke = global.antiNuke;
    if (!antiNuke) {
      return interaction.reply({ 
        content: '❌ Anti-nuke system not initialized.', 
        flags: 64 
      });
    }

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

        return interaction.reply({ embeds: [embed], flags: 64 });

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

        return interaction.reply({ embeds: [embed], flags: 64 });
      }

    } catch (error) {
      console.error('Score reset error:', error);
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Score Reset Failed')
        .setDescription(`Failed to reset scores: ${error.message}`)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  }
};

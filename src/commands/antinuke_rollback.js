const { EmbedBuilder } = require('discord.js');
const AntiNukeRollback = require('../lib/antinuke-rollback');

module.exports = {
  data: {
    name: 'antinuke_rollback',
    description: 'Rollback all anti-nuke actions (Owner only)'
  },
  async execute(interaction, client) {
    // Check if user is the owner
    if (interaction.user.id !== '1381692847018868778') {
      return interaction.reply({ 
        content: '❌ This command can only be used by the server owner.', 
        flags: 64 
      });
    }

    const rollback = new AntiNukeRollback();
    await rollback.init();

    const guild = interaction.guild;
    const status = rollback.getRollbackStatus(guild.id);

    if (!status.hasActions) {
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('🔄 Anti-Nuke Rollback Status')
        .setDescription('✅ No anti-nuke actions to rollback.')
        .addFields(
          { name: 'Server', value: guild.name, inline: true },
          { name: 'Actions Found', value: '0', inline: true }
        )
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }

    // Show confirmation dialog
    const embed = new EmbedBuilder()
      .setColor('#FFA500')
      .setTitle('🔄 Anti-Nuke Rollback Confirmation')
      .setDescription(`⚠️ **WARNING**: This will rollback **${status.totalActions}** anti-nuke actions in **${guild.name}**.`)
      .addFields(
        { name: 'Actions to Rollback', value: status.totalActions.toString(), inline: true },
        { name: 'Oldest Action', value: `<t:${Math.floor(status.oldestAction/1000)}:R>`, inline: true },
        { name: 'Newest Action', value: `<t:${Math.floor(status.newestAction/1000)}:R>`, inline: true }
      )
      .addFields(
        { name: 'Action Types', value: status.actions.map(a => `• ${a.type}`).join('\n') || 'None', inline: false }
      )
      .setColor('#FF0000')
      .setFooter({ text: 'This action cannot be undone!' })
      .setTimestamp();

    const row = {
      type: 1,
      components: [
        {
          type: 2,
          style: 4, // Danger
          label: '🔄 Rollback All Actions',
          customId: 'confirm_rollback',
        },
        {
          type: 2,
          style: 2, // Secondary
          label: '❌ Cancel',
          customId: 'cancel_rollback',
        }
      ]
    };

    await interaction.reply({ 
      embeds: [embed], 
      components: [row],
      flags: 64 
    });

    // Create collector for button interaction
    const filter = (i) => i.user.id === interaction.user.id;
    const collector = interaction.channel.createMessageComponentCollector({ 
      filter, 
      time: 30000 // 30 seconds
    });

    collector.on('collect', async (i) => {
      if (i.customId === 'confirm_rollback') {
        await i.update({ 
          content: '🔄 Starting rollback... This may take a few minutes.',
          embeds: [],
          components: []
        });

        try {
          const results = await rollback.rollbackAll(guild, client);
          
          const resultEmbed = new EmbedBuilder()
            .setTitle('🔄 Rollback Complete')
            .setDescription(results.success ? '✅ Rollback completed successfully!' : '⚠️ Rollback completed with some issues.')
            .setColor(results.success ? '#00FF00' : '#FFA500')
            .addFields(
              { name: 'Total Actions', value: results.total.toString(), inline: true },
              { name: '✅ Reverted', value: results.reverted.toString(), inline: true },
              { name: '❌ Failed', value: results.failed.toString(), inline: true }
            )
            .setTimestamp();

          if (results.details.length > 0) {
            const detailsText = results.details
              .filter(d => d.success)
              .slice(0, 10) // Show first 10 successful actions
              .map(d => `✅ ${d.action}: ${d.target}`)
              .join('\n');

            if (detailsText) {
              resultEmbed.addFields({
                name: 'Successfully Reverted',
                value: detailsText,
                inline: false
              });
            }
          }

          if (results.failed > 0) {
            const failedText = results.details
              .filter(d => !d.success)
              .slice(0, 5) // Show first 5 failed actions
              .map(d => `❌ ${d.actionType}: ${d.error}`)
              .join('\n');

            if (failedText) {
              resultEmbed.addFields({
                name: 'Failed Actions',
                value: failedText,
                inline: false
              });
            }
          }

          await i.editReply({ embeds: [resultEmbed] });

        } catch (error) {
          console.error('Rollback error:', error);
          await i.editReply({ 
            content: `❌ Rollback failed: ${error.message}`,
            embeds: [],
            components: []
          });
        }

      } else if (i.customId === 'cancel_rollback') {
        await i.update({ 
          content: '❌ Rollback cancelled.',
          embeds: [],
          components: []
        });
      }
    });

    collector.on('end', (collected, reason) => {
      if (reason === 'time') {
        interaction.editReply({ 
          content: '⏰ Rollback confirmation timed out.',
          embeds: [],
          components: []
        }).catch(() => {});
      }
    });
  }
};

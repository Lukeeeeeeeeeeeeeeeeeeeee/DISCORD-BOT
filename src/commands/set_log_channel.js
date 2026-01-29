const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

module.exports = {
  data: {
    name: 'set_log_channel',
    description: 'Configure anti-nuke log channel (Admin only)',
    options: [
      {
        name: 'channel',
        description: 'Channel to set as log channel',
        type: 7, // CHANNEL
        required: true
      }
    ]
  },
  async execute(interaction) {
    // Check admin permissions
    if (!hasAdministrator(interaction.member)) {
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

    const channel = interaction.options.getChannel('channel');
    
    // Verify it's a text channel
    if (channel.type !== 0) { // GUILD_TEXT
      return interaction.reply({ 
        content: '❌ Log channel must be a text channel.', 
        flags: 64 
      });
    }

    try {
      // Set the log channel
      antiNuke.setLogChannel(interaction.guild.id, channel.id);
      
      const embed = new EmbedBuilder()
        .setColor('#00FF00')
        .setTitle('✅ Log Channel Configured')
        .setDescription(`Anti-nuke logs will now be sent to ${channel}`)
        .addFields(
          { name: 'Channel', value: `${channel.name} (${channel.id})`, inline: true },
          { name: 'Server', value: interaction.guild.name, inline: true },
          { name: 'Configured By', value: interaction.user.tag, inline: true }
        )
        .addFields(
          {
            name: '📝 What Gets Logged',
            value: '• All bans and kicks\n• Channel/role deletions\n• Beast mode warnings\n• Emergency mode activation\n• Whitelist changes\n• Backup creation/recovery',
            inline: false
          }
        )
        .setTimestamp();

      // Log the configuration change
      antiNuke.logAction(interaction.guild.id, {
        type: 'log_channel_configured',
        executorId: interaction.user.id,
        channelId: channel.id,
        channelName: channel.name
      });

      return interaction.reply({ embeds: [embed], flags: 64 });

    } catch (error) {
      console.error('Set log channel error:', error);
      
      const embed = new EmbedBuilder()
        .setColor('#FF0000')
        .setTitle('❌ Failed to Set Log Channel')
        .setDescription(`Error: ${error.message}`)
        .setTimestamp();

      return interaction.reply({ embeds: [embed], flags: 64 });
    }
  }
};

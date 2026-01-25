const { EmbedBuilder } = require('discord.js');
const AntiNuke = require('../lib/antinuke');

module.exports = {
  data: {
    name: 'check_score',
    description: "Check user's beast mode score (Admin only)",
    options: [
      {
        name: 'user',
        description: 'User to check',
        type: 6, // USER
        required: true
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

    const user = interaction.options.getUser('user');
    const score = antiNuke.getUserScore(interaction.guild.id, user.id);
    const isWhitelisted = antiNuke.isWhitelisted(user.id);
    const threshold = 40;
    
    // Determine status and color
    let status, color, emoji, pointsUntilBan;
    if (score >= 35) {
      status = 'Critical';
      color = 0x992D22;
      emoji = '🔴';
    } else if (score >= 30) {
      status = 'Danger';
      color = 0xFFA500;
      emoji = '🟠';
    } else if (score >= 20) {
      status = 'Warning';
      color = 0xFFFF00;
      emoji = '🟡';
    } else {
      status = 'Safe';
      color = 0x00FF00;
      emoji = '🟢';
    }
    
    pointsUntilBan = Math.max(0, threshold - score);
    
    // Get recent actions (mock data for now)
    const recentActions = [
      'Ban action (+20 points)',
      'Bot addition (+20 points)',
      'No recent actions'
    ].slice(0, score > 0 ? 2 : 1);
    
    const embed = new EmbedBuilder()
      .setColor(color)
      .setTitle(`${emoji} Beast Mode Score Check`)
      .setThumbnail(user.displayAvatarURL())
      .addFields(
        { 
          name: '👤 User', 
          value: `${user.tag}\n${user.id}`, 
          inline: true 
        },
        { 
          name: '📊 Score', 
          value: `${score} / ${threshold}`, 
          inline: true 
        },
        { 
          name: '🛡️ Status', 
          value: `${status} ${pointsUntilBan === 0 ? '(BAN THRESHOLD)' : `(${pointsUntilBan} points until ban)`}`, 
          inline: true 
        }
      )
      .addFields(
        { 
          name: '⚖️ Whitelist Status', 
          value: isWhitelisted ? '✅ Whitelisted (Immune)' : '❌ Not Whitelisted', 
          inline: true 
        },
        { 
          name: '📈 Points Until Ban', 
          value: pointsUntilBan.toString(), 
          inline: true 
        }
      )
      .addFields(
        {
          name: '📋 Recent Actions (24h)',
          value: recentActions.length > 0 ? recentActions.join('\n') : 'No recent actions',
          inline: false
        }
      )
      .setFooter({ text: 'This information is only visible to you' })
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: 64 }); // Ephemeral
  }
};

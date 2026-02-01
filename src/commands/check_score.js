const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');

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
    if (!hasAdministrator(interaction.member)) {
      return interaction.reply({ 
        content: '❌ Administrator permission required.'
      });
    }

    const antiNuke = global.antiNuke;
    if (!antiNuke) {
      return interaction.reply({ 
        content: '❌ Anti-nuke system not initialized.'
      });
    }

    const user = interaction.options.getUser('user');
    const score = antiNuke.getUserScore(interaction.guild.id, user.id);
    const isWhitelisted = antiNuke.isWhitelisted(user.id);
    const threshold = antiNuke.BEAST_MODE_THRESHOLD || 40;
    const level = typeof antiNuke.getScoreLevel === 'function'
      ? antiNuke.getScoreLevel(score)
      : score >= threshold
        ? 'critical'
        : score >= (antiNuke.BEAST_MODE_DANGER || 30)
          ? 'danger'
          : score >= (antiNuke.BEAST_MODE_WARN || 20)
            ? 'warning'
            : 'safe';

    const statusMap = {
      safe: { label: 'Safe', color: 0x00FF00, emoji: '🟢' },
      warning: { label: 'Warning', color: 0xFFFF00, emoji: '🟡' },
      danger: { label: 'Danger', color: 0xFFA500, emoji: '🟠' },
      critical: { label: 'Critical', color: 0x992D22, emoji: '�' }
    };
    const statusInfo = statusMap[level] || statusMap.safe;
    const pointsUntilBan = Math.max(0, threshold - score);

    const recentActions = typeof antiNuke.getRecentBeastActions === 'function'
      ? antiNuke.getRecentBeastActions(interaction.guild.id, user.id, 6)
      : [];
    const recentLines = recentActions.length
      ? recentActions.map(action => {
        const label = typeof antiNuke.formatActionLabel === 'function'
          ? antiNuke.formatActionLabel(action.type)
          : action.type;
        return `• ${label} (+${action.points}) — <t:${Math.floor(action.timestamp / 1000)}:R>`;
      })
      : ['No recent actions'];
    
    const embed = new EmbedBuilder()
      .setColor(statusInfo.color)
      .setTitle(`${statusInfo.emoji} Beast Mode Score Check`)
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
          value: `${statusInfo.label} ${pointsUntilBan === 0 ? '(BAN THRESHOLD)' : `(${pointsUntilBan} points until ban)`}`,
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
        },
        {
          name: '🕒 Window',
          value: 'Last 24 hours',
          inline: true
        }
      )
      .addFields(
        {
          name: '📋 Recent Actions (24h)',
          value: recentLines.join('\n'),
          inline: false
        }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed] });
  }
};

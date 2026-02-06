const { EmbedBuilder } = require('discord.js');
const { hasAdministrator } = require('../lib/permissions');
const { buildErrorEmbed } = require('../lib/embeds');
const runtime = require('../lib/runtime');

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
      return interaction.reply({ embeds: [buildErrorEmbed('Administrator permission required.')], flags: 64 });
    }

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

    const formatWindow = (ms) => {
      if (!ms && ms !== 0) return 'unknown';
      if (ms % 3600000 === 0) return `${ms / 3600000}h`;
      if (ms % 60000 === 0) return `${ms / 60000}m`;
      return `${Math.round(ms / 1000)}s`;
    };
    const windowLabel = formatWindow(antiNuke.BEAST_MODE_WINDOW || (24 * 60 * 60 * 1000));
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
          value: `Last ${windowLabel}`,
          inline: true
        }
      )
      .addFields(
        {
          name: `📋 Recent Actions (${windowLabel})`,
          value: recentLines.join('\n'),
          inline: false
        }
      )
      .setTimestamp();

    return respond({ embeds: [embed] });
  }
};

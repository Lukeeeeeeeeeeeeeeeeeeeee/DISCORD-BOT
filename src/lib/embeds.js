const { EmbedBuilder } = require('discord.js');

function buildErrorEmbed(message, title = 'Error') {
  return new EmbedBuilder()
    .setTitle(title)
    .setDescription(message)
    .setColor(0xFF4444)
    .setTimestamp();
}

async function replyError(interaction, message, opts = {}) {
  if (!interaction) return null;
  const title = opts.title || 'Error';
  const embed = buildErrorEmbed(message, title);
  const payload = { embeds: [embed], allowedMentions: { parse: [] } };
  if (opts.flags !== undefined) payload.flags = opts.flags;

  if (interaction.deferred || interaction.replied) {
    if (typeof interaction.editReply === 'function') return interaction.editReply(payload);
    if (typeof interaction.followUp === 'function') return interaction.followUp(payload);
  }
  return interaction.reply(payload);
}

module.exports = { buildErrorEmbed, replyError };

const { EmbedBuilder } = require('discord.js');
const INTERACTION_ACK_ERROR_CODES = new Set([10008, 10062, 40060]);

function isInteractionAckError(error) {
  return Boolean(error && INTERACTION_ACK_ERROR_CODES.has(Number(error.code)));
}

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
  const payload = { embeds: [embed] };
  if (opts.flags !== undefined) payload.flags = opts.flags;

  try {
    if (interaction.deferred || interaction.replied) {
      if (typeof interaction.editReply === 'function') {
        const editPayload = { ...payload };
        delete editPayload.flags;
        return await interaction.editReply(editPayload);
      }
      if (typeof interaction.followUp === 'function') return await interaction.followUp(payload);
    }
    return await interaction.reply(payload);
  } catch (error) {
    if (isInteractionAckError(error)) return null;
    throw error;
  }
}

module.exports = { buildErrorEmbed, replyError };

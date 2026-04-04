const { MessageFlags } = require('discord.js');
const { isInteractionAckError } = require('../lib/interaction-errors');

function createInteractionCreateHandler({
  isSystemsReady,
  client,
  db,
  analytics,
  dispatchCommand,
  logVerbose,
  getCommandCategory,
  getInteractionMeta,
  isAppError,
  logUnexpectedError,
  buildErrorEmbed
} = {}) {
  return async function onInteractionCreate(interaction) {
    if (!isSystemsReady || !isSystemsReady()) return;
    if (!interaction || typeof interaction.isChatInputCommand !== 'function' || !interaction.isChatInputCommand()) return;
    const cmd = client && client.commands ? client.commands.get(interaction.commandName) : null;
    if (!cmd) return;
    const startedAt = Date.now();
    const meta = getInteractionMeta ? getInteractionMeta(interaction) : {};
    const category = getCommandCategory ? getCommandCategory(meta.command) : 'unknown';
    if (logVerbose) logVerbose('command.start', 'Dispatching command', { ...meta, category });
    let success = false;
    try {
      if (interaction.guild && analytics && typeof analytics.recordCommand === 'function') {
        await analytics.recordCommand({ guildId: interaction.guild.id, commandName: interaction.commandName });
      }
      await dispatchCommand(cmd, interaction, { client, db });
      success = true;
    } catch (err) {
      if (isInteractionAckError(err)) return;
      const isKnown = isAppError ? isAppError(err) : false;
      let dispatchResult = null;
      if (!isKnown && logUnexpectedError) {
        dispatchResult = await logUnexpectedError('command', err, { ...meta, category });
      }
      if (logVerbose) logVerbose('command.error', 'Command failed', { ...meta, category });
      try {
        const title = isKnown && err && err.title ? err.title : 'Error';
        const supportSuffix = !isKnown && dispatchResult && dispatchResult.supportId
          ? ` Support ID: \`${dispatchResult.supportId}\`.`
          : '';
        const userMessage = isKnown && err && err.userMessage
          ? err.userMessage
          : `Command failed.${supportSuffix}`;
        const embed = buildErrorEmbed ? buildErrorEmbed(userMessage, title) : null;
        if (!embed) return;
        if (interaction.deferred || interaction.replied) {
          await interaction.editReply({ embeds: [embed] });
        } else {
          await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        }
      } catch (err2) {
        if (isInteractionAckError(err2)) return;
        console.error('Failed to send error response for interaction:', err2);
      }
    } finally {
      const durationMs = Date.now() - startedAt;
      if (logVerbose) logVerbose('command.finish', 'Command completed', { ...meta, category, durationMs, success });
    }
  };
}

module.exports = { createInteractionCreateHandler };

const path = require('path');
const { AppError } = require('./errors');

async function dispatchCommand(cmd, interaction, ctx = {}, ...extraArgs) {
  if (!cmd || typeof cmd.execute !== 'function') {
    const name = cmd && cmd.data && cmd.data.name ? cmd.data.name : 'unknown';
    throw new AppError(`Invalid command module for ${name}: missing execute()`, {
      code: 'CMD_INVALID',
      userMessage: 'This command is unavailable right now.',
      title: 'Command Error'
    });
  }

  const client = ctx.client;
  const db = ctx.db;
  return cmd.execute(interaction, client, db, ...extraArgs);
}

function getCommandName(cmd) {
  if (!cmd) return 'unknown';
  if (cmd.data && typeof cmd.data === 'object' && typeof cmd.data.name === 'string') return cmd.data.name;
  if (typeof cmd.data === 'string') return cmd.data;
  return 'unknown';
}

function getCommandFileLabel(filePath) {
  if (!filePath) return '';
  return path.basename(filePath);
}

module.exports = { dispatchCommand, getCommandName, getCommandFileLabel };

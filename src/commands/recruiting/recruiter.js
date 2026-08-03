const { resolveGuildId } = require('../../lib/guild');

const { handlers: multiplierHandlers } = require('./recruiter-handlers/multiplier');
const { handlers: infoHandlers } = require('./recruiter-handlers/info');
const { handlers: buyHandlers } = require('./recruiter-handlers/buy');
const { handlers: warnHandlers } = require('./recruiter-handlers/warn');
const { handlers: warningsRevokeHandlers } = require('./recruiter-handlers/warnings-revoke');
const defaultDb = require('../../db_async');

const handlers = {
  ...multiplierHandlers,
  ...infoHandlers,
  ...buyHandlers,
  ...warnHandlers,
  ...warningsRevokeHandlers
};

module.exports = {
  data: { name: 'recruiter' },
  async execute(interaction, _client, db) {
    const sub = interaction.options.getSubcommand();
    const dbHandle = db || defaultDb;
    const guildId = resolveGuildId(interaction.guild || interaction);
    const handler = handlers[sub];
    if (!handler) return;
    return handler({ interaction, db: dbHandle, guildId, subcommand: sub });
  }
};

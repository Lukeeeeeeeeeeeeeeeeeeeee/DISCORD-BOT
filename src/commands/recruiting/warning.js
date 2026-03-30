const db = require('../../db_async');
const { resolveGuildId } = require('../../lib/guild');
const { 
  handleWarn, 
  handleWarningsRevoke, 
  handleWarningsResetAll 
} = require('../../services/recruiting/recruiter-warning-service');

module.exports = {
  data: { name: 'warning' },
  async execute(interaction) {
    const sub = interaction.options.getSubcommand();
    const guildId = resolveGuildId(interaction.guild || interaction);

    if (sub === 'warn') {
      return handleWarn({ interaction, db, guildId });
    }

    if (sub === 'revoke') {
      return handleWarningsRevoke({ interaction, db, guildId });
    }

    if (sub === 'reset-all') {
      return handleWarningsResetAll({ interaction, db, guildId });
    }
  }
};

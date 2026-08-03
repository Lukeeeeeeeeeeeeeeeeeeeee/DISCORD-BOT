function formatErrorForLog(error) {
  if (!error) return { message: 'Unknown error' };
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code
    };
  }
  return { message: String(error) };
}

const VERBOSE_LOGGING = (() => {
  const raw = String(process.env.VERBOSE_LOGGING || '').trim().toLowerCase();
  return raw === '1' || raw === 'true' || raw === 'yes' || raw === 'on';
})();

function logUnexpectedError(scope, error, meta = {}) {
  const payload = {
    scope,
    ...meta,
    error: formatErrorForLog(error)
  };
  console.error('Unexpected error', payload);
}

function logVerbose(scope, message, meta = {}) {
  if (!VERBOSE_LOGGING) return;
  const payload = {
    scope,
    message,
    ...meta
  };
  console.log('Verbose', payload);
}

const ANTINUKE_COMMANDS = new Set([
  'antinuke_status',
  'antinuke_rollback',
  'simulate_attack',
  'toggle_strict_mode',
  'toggle_aggressive_ban',
  'set_quarantine_options',
  'whitelist',
  'set_log_channel',
  'force_backup',
  'view_backups',
  'emergency_recover',
  'export_logs',
  'check_score',
  'reset_scores'
]);

const ECONOMY_COMMANDS = new Set([
  'recruiter'
]);

function getCommandCategory(commandName) {
  if (ANTINUKE_COMMANDS.has(commandName)) return 'antinuke';
  if (ECONOMY_COMMANDS.has(commandName)) return 'economy';
  return 'general';
}

function getInteractionMeta(interaction) {
  if (!interaction) return {};
  let subcommand = null;
  try {
    if (interaction.options && typeof interaction.options.getSubcommand === 'function') {
      subcommand = interaction.options.getSubcommand(false);
    }
  } catch (e) {
    subcommand = null;
  }
  return {
    command: interaction.commandName,
    subcommand,
    userId: interaction.user ? interaction.user.id : null,
    guildId: interaction.guild ? interaction.guild.id : null,
    channelId: interaction.channelId || null
  };
}

module.exports = {
  logUnexpectedError,
  logVerbose,
  getCommandCategory,
  getInteractionMeta
};

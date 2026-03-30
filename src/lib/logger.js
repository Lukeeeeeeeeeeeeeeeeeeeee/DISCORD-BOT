const { AECS, CodexError } = require('./aecs');

const SECRET_KEYS = new Set(['token', 'secret', 'password', 'key', 'auth', 'authorization', 'api_key', 'apikey']);

function stripSecrets(obj, depth = 0) {
  if (depth > 5 || !obj || typeof obj !== 'object') return obj;
  if (Array.isArray(obj)) return obj.map(item => stripSecrets(item, depth + 1));
  
  const sanitized = {};
  for (const [key, value] of Object.entries(obj)) {
    const lowerKey = key.toLowerCase();
    let isSecret = false;
    for (const secretKey of SECRET_KEYS) {
      const regex = new RegExp(`\\b${secretKey}\\b`, 'i');
      if (regex.test(lowerKey)) {
        isSecret = true;
        break;
      }
    }
    
    if (isSecret) {
      sanitized[key] = '[REDACTED]';
    } else if (typeof value === 'object' && value !== null) {
      sanitized[key] = stripSecrets(value, depth + 1);
    } else {
      sanitized[key] = value;
    }
  }
  return sanitized;
}

function formatErrorForLog(error) {
  if (!error) return { message: 'Unknown error' };
  if (error instanceof Error) {
    const base = {
      name: error.name,
      message: error.message,
      stack: error.stack,
      code: error.code
    };
    // Copy any extra properties but strip secrets
    for (const key of Object.keys(error)) {
      if (!(key in base)) base[key] = error[key];
    }
    return stripSecrets(base);
  }
  return { message: String(error) };
}

function inferCodeFromScope(scope, error) {
  const value = String(scope || '').toLowerCase();
  const message = error instanceof Error ? String(error.message || '').toLowerCase() : String(error || '').toLowerCase();

  if (value.startsWith('command') || value.includes('interaction')) return 'CMD-500';
  if (value.startsWith('scheduler') || value.includes('weekly') || value.includes('cron')) return 'SCH-500';
  if (value.includes('db') || message.includes('sqlite') || message.includes('constraint')) return 'DB-500';
  return 'SYS-500';
}

function toMeta(scope, error, meta) {
  const payload = {
    scope,
    ...(meta || {})
  };

  if (error instanceof Error) {
    payload.name = error.name;
    payload.message = error.message;
    if (error.code !== undefined) payload.errorCode = String(error.code);
    
    // Include extra error properties if safe
    for (const key of Object.keys(error)) {
       if (!['name', 'message', 'stack', 'code'].includes(key)) {
         payload[`err_${key}`] = error[key];
       }
    }
  } else if (error !== undefined && error !== null) {
    payload.message = String(error);
  }

  return stripSecrets(payload);
}

function logUnexpectedError(scope, error, meta = {}) {
  const code = inferCodeFromScope(scope, error);
  const codex = error instanceof CodexError
    ? error
    : CodexError.fromUnknown(error, code, toMeta(scope, error, meta));

  return AECS.dispatch(codex, {
    scope,
    meta: toMeta(scope, error, meta)
  }).catch((dispatchError) => {
    const payload = {
      scope,
      error: formatErrorForLog(error),
      dispatchError: formatErrorForLog(dispatchError)
    };
    console.error('Unexpected error (AECS dispatch failed)', payload);
    return { supportId: null, suppressed: false, record: null };
  });
}

function normalizeRuntimeEventLevel(level, scope, message) {
  const normalizedLevel = String(level || 'info').toLowerCase();
  if (
    normalizedLevel === 'warn'
    && scope === 'startup.commands'
    && typeof message === 'string'
    && message.startsWith('Skipping compatibility command shim:')
  ) {
    return 'info';
  }
  return normalizedLevel;
}

function logRuntimeEvent(level, scope, message, meta = {}) {
  const normalizedLevel = normalizeRuntimeEventLevel(level, scope, message);
  const payload = stripSecrets({
    scope,
    message,
    level: normalizedLevel,
    ...(meta || {})
  });

  const code = normalizedLevel === 'error' ? 'SYS-500' : (normalizedLevel === 'warn' ? 'SYS-210' : 'SYS-110');
  const codex = new CodexError(code, payload, { message: String(message || 'Runtime event') });

  return AECS.dispatch(codex, {
    scope: scope || 'runtime',
    meta: payload
  }).catch((dispatchError) => {
    const fallback = {
      scope,
      message,
      level: normalizedLevel,
      meta: stripSecrets(meta),
      dispatchError: formatErrorForLog(dispatchError)
    };
    if (normalizedLevel === 'error') {
      console.error('Runtime event', fallback);
      return;
    }
    if (normalizedLevel === 'warn') {
      console.warn('Runtime event', fallback);
      return;
    }
    console.log('Runtime event', fallback);
  });
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
  } catch (_error) {
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
  logRuntimeEvent,
  getCommandCategory,
  getInteractionMeta,
  formatErrorForLog
};

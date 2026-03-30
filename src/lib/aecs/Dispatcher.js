const crypto = require('crypto');
const CodexError = require('./CodexError');
const dictionaries = require('./dictionaries');
const { sanitizeMeta, normalizeSeverity, clampImpact } = require('./sanitize');
const { TelemetryAdapter } = require('./telemetry-adapter');

const SUPPORT_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function createSupportId(traceId) {
  const seed = traceId || crypto.randomUUID();
  const digest = crypto.createHash('sha256').update(String(seed)).digest();
  let out = '';
  for (let i = 0; i < 7; i += 1) {
    out += SUPPORT_ALPHABET[digest[i] % SUPPORT_ALPHABET.length];
  }
  return out;
}

function normalizeMessage(message) {
  if (!message) return '';
  // Audit Hardening: Strip dynamic identifiers to prevent suppression-bypass (VULN-04 Regression)
  return String(message)
    .replace(/\b\d{17,20}\b/g, '[ID]') // Snowflake IDs
    .replace(/\b[a-fA-F0-9]{24,128}\b/g, '[HEX_LONG]') // Long hex (IDs, Hashes)
    .replace(/\b0x[a-fA-F0-9]+\b/g, '[HEX]') // 0x prefixed hex
    .replace(/\b\d+\b/g, '[NUM]') // whole numbers only
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[UUID]') 
    .trim();
}

/**
 * Creates a unique fingerprint for an error based on scope, code, and normalized message (FIX: VULN-04)
 */
function createFingerprint(scope, code, message) {
  const base = `${scope || 'global'}|${code}`;
  const normalized = normalizeMessage(message);
  const salt = normalized ? `|${crypto.createHash('md5').update(normalized).digest('hex').slice(0, 8)}` : '';
  return crypto.createHash('md5').update(`${base}${salt}`).digest('hex');
}

function hashIdFromFingerprint(fingerprint) {
  const raw = Number.parseInt(String(fingerprint).slice(0, 8), 16);
  if (!Number.isFinite(raw)) return 0;
  return raw >>> 0;
}

function getDomainForCode(code) {
  const normalized = dictionaries.normalizeCode(code);
  const dashIndex = normalized.indexOf('-');
  if (dashIndex <= 0) return 'SYS';
  return normalized.slice(0, dashIndex);
}

function getContextView(context) {
  if (!context) return {};
  return {
    traceId: context.traceId || null,
    command: context.command || null,
    userId: context.userId || null,
    guildId: context.guildId || null,
    channelId: context.channelId || null,
    source: context.source || null
  };
}

class Dispatcher {
  constructor(options = {}) {
    this.vault = options.vault;
    this.getContext = typeof options.getContext === 'function' ? options.getContext : () => null;
    this.runWithContext = typeof options.runWithContext === 'function' ? options.runWithContext : async (_context, fn) => fn();

    this.suppressionThreshold = Number.parseInt(options.suppressionThreshold || '50', 10);
    this.suppressionWindowMs = Number.parseInt(options.suppressionWindowMs || '60000', 10);
    this.fatalImpactThreshold = Number.parseInt(options.fatalImpactThreshold || '90', 10);
    this.maxCureDepth = Number.parseInt(options.maxCureDepth || process.env.AECS_MAX_CURE_DEPTH || '3', 10);

    this.telemetryOptions = {
      telemetryWebhookUrl: options.telemetryWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL || '',
      telemetryFatalWebhookUrl: options.telemetryFatalWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL || '',
      telemetryHighImpactWebhookUrl: options.telemetryHighImpactWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH || '',
      telemetryChannelId: options.telemetryChannelId || process.env.AECS_TELEMETRY_CHANNEL_ID || '',
      supportLookupTemplate: options.supportLookupTemplate || process.env.AECS_SUPPORT_LOOKUP_TEMPLATE || '',
      webhookImpactThreshold: options.webhookImpactThreshold || process.env.AECS_WEBHOOK_IMPACT_THRESHOLD || '70',
      telemetryTimeoutMs: options.telemetryTimeoutMs || process.env.AECS_TELEMETRY_TIMEOUT_MS || '5000',
      fetchImpl: options.fetchImpl
    };
    this.telemetryAdapter = options.telemetryAdapter || this.createTelemetryAdapter(this.telemetryOptions);
    this.exitOnFatal = options.exitOnFatal === true || process.env.AECS_EXIT_ON_FATAL === '1';

    this.suppressionMap = new Map();
    this.suppressionTimer = null;
  }

  createTelemetryAdapter(telemetryOptions = {}) {
    return new TelemetryAdapter({
      defaultWebhookUrl: telemetryOptions.telemetryWebhookUrl || '',
      fatalWebhookUrl: telemetryOptions.telemetryFatalWebhookUrl || '',
      highImpactWebhookUrl: telemetryOptions.telemetryHighImpactWebhookUrl || '',
      channelId: telemetryOptions.telemetryChannelId || '',
      supportLookupTemplate: telemetryOptions.supportLookupTemplate || '',
      impactThreshold: telemetryOptions.webhookImpactThreshold || '70',
      timeoutMs: telemetryOptions.telemetryTimeoutMs || '5000',
      fetchImpl: telemetryOptions.fetchImpl
    });
  }

  setTelemetryOptions(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    if (partial.telemetryAdapter && typeof partial.telemetryAdapter.send === 'function') {
      this.telemetryAdapter = partial.telemetryAdapter;
      return;
    }
    this.telemetryOptions = { ...this.telemetryOptions, ...partial };
    this.telemetryAdapter = this.createTelemetryAdapter(this.telemetryOptions);
  }

  start() {
    if (this.suppressionTimer) return;
    this.suppressionTimer = setInterval(() => {
      this.flushSuppressionSummaries().catch((error) => {
        console.error('AECS suppression summary flush failed:', error);
      });
    }, this.suppressionWindowMs);
    if (typeof this.suppressionTimer.unref === 'function') this.suppressionTimer.unref();
  }

  async stop() {
    if (this.suppressionTimer) {
      clearInterval(this.suppressionTimer);
      this.suppressionTimer = null;
    }
    await this.flushSuppressionSummaries();
  }

  computeImpact(definition, sanitizedMeta, traceContext) {
    let impact = clampImpact(definition && definition.baseImpact !== undefined ? definition.baseImpact : 50);
    if (definition && typeof definition.escalator === 'function') {
      try {
        impact = clampImpact(definition.escalator(sanitizedMeta, traceContext || {}));
      } catch (error) {
        void error;
      }
    }
    return impact;
  }

  shouldSuppress(fingerprint, code, scope, severity) {
    if (severity === 'FATAL') return false;

    const now = Date.now();
    let state = this.suppressionMap.get(fingerprint);
    if (!state) {
      state = {
        code,
        scope,
        count: 0,
        suppressed: 0,
        windowStart: now
      };
      this.suppressionMap.set(fingerprint, state);
    }

    if (now - state.windowStart >= this.suppressionWindowMs) {
      state.count = 0;
      state.suppressed = 0;
      state.windowStart = now;
    }

    state.count += 1;
    if (state.count > this.suppressionThreshold) {
      state.suppressed += 1;
      return true;
    }
    return false;
  }

  async flushSuppressionSummaries() {
    const now = Date.now();
    for (const [fingerprint, state] of this.suppressionMap.entries()) {
      if (!state || state.suppressed <= 0) {
        if (state && now - state.windowStart >= this.suppressionWindowMs) {
          state.count = 0;
          state.windowStart = now;
        }
        continue;
      }

      const summaryRecord = {
        version: '6.1.0',
        timestamp: now,
        traceId: null,
        supportId: null,
        code: 'SYS-700',
        title: 'Circuit Breaker Suppression Summary',
        severity: 'WARN',
        impact: 40,
        domain: 'SYS',
        scope: 'aecs.circuit_breaker',
        message: `${state.code} suppressed ${state.suppressed} times in ${Math.round(this.suppressionWindowMs / 1000)}s`,
        meta: {
          fingerprint,
          code: state.code,
          scope: state.scope,
          suppressed: state.suppressed,
          windowMs: this.suppressionWindowMs
        },
        hash: createFingerprint('aecs.circuit_breaker', state.code, state.message),
        hashId: hashIdFromFingerprint(createFingerprint('aecs.circuit_breaker', state.code, state.message))
      };

      if (this.vault) this.vault.queue(summaryRecord);
      console.warn('[AECS]', summaryRecord.message);

      state.count = 0;
      state.suppressed = 0;
      state.windowStart = now;
      this.suppressionMap.set(fingerprint, state);
    }
  }

  async maybeRunAutocure(definition, codexError, context, scope) {
    if (!definition || typeof definition.autocure !== 'function') return;

    const hasLedger = context && context.healingLedger instanceof Set;
    if (!hasLedger) return;

    const cureKey = `${codexError.code}_CURE_ATTEMPT`;
    if (context.healingLedger.has(cureKey)) {
      const fatal = new CodexError('SYS-900', {
        code: codexError.code,
        scope,
        traceId: context.traceId || null,
        cureKey
      });
      await this.dispatch(fatal, { scope: `${scope}.autocure.loop` });
      return;
    }

    if (Number(context.cureDepth || 0) >= this.maxCureDepth) {
      const fatal = new CodexError('SYS-901', {
        code: codexError.code,
        scope,
        traceId: context.traceId || null,
        maxCureDepth: this.maxCureDepth
      });
      await this.dispatch(fatal, { scope: `${scope}.autocure.depth` });
      return;
    }

    context.healingLedger.add(cureKey);
    context.cureDepth = Number(context.cureDepth || 0) + 1;

    try {
      await definition.autocure(codexError.meta || {}, getContextView(context));
    } catch (error) {
      const wrapped = CodexError.fromUnknown(error, codexError.code, {
        scope,
        phase: 'autocure',
        originalCode: codexError.code
      });
      await this.dispatch(wrapped, { scope: `${scope}.autocure` });
    }
  }

  async maybeSendWebhook(record) {
    if (!record || !this.telemetryAdapter || typeof this.telemetryAdapter.send !== 'function') return;
    try {
      await this.telemetryAdapter.send(record);
    } catch (error) {
      // AECS Hardening: Suppress 429 feedback loops definitively
      const errMsg = error && error.message ? String(error.message) : '';
      if (errMsg.includes('429') || errMsg.includes('Too Many Requests')) {
        return;
      }
      console.error('AECS telemetry webhook failed:', error);
    }
  }

  async dispatch(error, options = {}) {
    const scope = options.scope || 'runtime';
    const codexError = error instanceof CodexError
      ? error
      : CodexError.fromUnknown(error, options.code || 'SYS-500', options.meta || { scope });

    const definition = codexError.definition || dictionaries.getDefinition(codexError.code) || dictionaries.getDefinition('SYS-001');
    const context = this.getContext ? this.getContext() : null;
    const traceContext = getContextView(context);

    const sanitizedMeta = sanitizeMeta({ ...(codexError.meta || {}), ...(options.meta || {}) }, definition);

    const impact = this.computeImpact(definition, sanitizedMeta, traceContext);
    let severity = normalizeSeverity(definition && definition.severity ? definition.severity : 'ERROR');
    if (impact >= this.fatalImpactThreshold) severity = 'FATAL';

    const message = codexError.message || (definition && definition.title) || 'Codex error';
    const supportId = createSupportId(traceContext.traceId || codexError.code);
    const fingerprint = createFingerprint(scope, codexError.code, message);
    const hashId = hashIdFromFingerprint(fingerprint);

    const record = {
      version: definition && definition.version ? definition.version : '6.1.0',
      timestamp: Date.now(),
      traceId: traceContext.traceId || null,
      supportId,
      code: codexError.code,
      title: definition && definition.title ? definition.title : 'Codex Error',
      severity,
      impact,
      domain: getDomainForCode(codexError.code),
      scope,
      message,
      tags: definition && Array.isArray(definition.tags) ? definition.tags : [],
      recoveryHint: definition && definition.recoveryHint ? definition.recoveryHint : null,
      meta: sanitizedMeta,
      stack: codexError.frozenStack || codexError.stack || null,
      hash: fingerprint,
      hashId
    };

    const suppressed = this.shouldSuppress(fingerprint, codexError.code, scope, severity);
    if (!suppressed && this.vault) {
      this.vault.queue(record);
    }

    if (severity === 'FATAL' && this.vault) {
      this.vault.forceWriteSync(record);
    }

    if (severity === 'ERROR' || severity === 'FATAL') {
      if (!suppressed) {
        console.error('[AECS]', record.code, record.scope, record.meta);
      }
    } else if (severity === 'WARN' && !suppressed) {
      console.warn('[AECS]', record.code, record.scope, record.meta);
    }

    await this.maybeRunAutocure(definition, codexError, context, scope);
    await this.maybeSendWebhook(record);

    if (severity === 'FATAL' && this.exitOnFatal) {
      setImmediate(() => {
        process.exit(1);
      });
    }

    return {
      record,
      supportId,
      suppressed
    };
  }

  getSuppressionSnapshot() {
    const entries = [];
    for (const [fingerprint, state] of this.suppressionMap.entries()) {
      if (!state) continue;
      entries.push({
        fingerprint,
        code: state.code,
        scope: state.scope,
        count: state.count,
        suppressed: state.suppressed,
        windowStart: state.windowStart
      });
    }
    return {
      threshold: this.suppressionThreshold,
      windowMs: this.suppressionWindowMs,
      activeFingerprints: entries.length,
      entries
    };
  }
}

module.exports = {
  Dispatcher,
  createSupportId,
  createFingerprint,
  hashIdFromFingerprint
};

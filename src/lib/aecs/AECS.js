const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');

const AecsVault = require('./vault');
const CodexError = require('./CodexError');
const { Dispatcher, createSupportId } = require('./Dispatcher');

function isHex32(value) {
  if (!value || value.length !== 32) return false;
  for (let i = 0; i < value.length; i += 1) {
    const code = value.charCodeAt(i);
    const isDigit = code >= 48 && code <= 57;
    const isLower = code >= 97 && code <= 102;
    const isUpper = code >= 65 && code <= 70;
    if (!isDigit && !isLower && !isUpper) return false;
  }
  return true;
}

function toHexTraceId(rawTraceId) {
  const source = String(rawTraceId || '').toLowerCase();
  let hex = '';
  for (let i = 0; i < source.length; i += 1) {
    const ch = source.charCodeAt(i);
    const isDigit = ch >= 48 && ch <= 57;
    const isLower = ch >= 97 && ch <= 102;
    if (isDigit || isLower) hex += source[i];
    if (hex.length >= 32) break;
  }
  if (hex.length >= 32) return hex.slice(0, 32);
  const digest = crypto.createHash('sha256').update(source || crypto.randomUUID()).digest('hex');
  return digest.slice(0, 32);
}

class AECSCore {
  constructor() {
    this.als = new AsyncLocalStorage();
    this.initialized = false;
    this.config = {};
    this.vault = null;
    this.dispatcher = null;

    this.configure({});
  }

  configure(options = {}) {
    this.config = {
      logDir: path.resolve(options.logDir || process.env.AECS_LOG_DIR || path.join(process.cwd(), 'data', 'aecs')),
      flushIntervalMs: Number.parseInt(options.flushIntervalMs || process.env.AECS_FLUSH_INTERVAL_MS || '2000', 10),
      suppressionThreshold: Number.parseInt(options.suppressionThreshold || process.env.AECS_SUPPRESSION_THRESHOLD || '50', 10),
      suppressionWindowMs: Number.parseInt(options.suppressionWindowMs || process.env.AECS_SUPPRESSION_WINDOW_MS || '60000', 10),
      fatalImpactThreshold: Number.parseInt(options.fatalImpactThreshold || process.env.AECS_FATAL_IMPACT_THRESHOLD || '90', 10),
      maxCureDepth: Number.parseInt(options.maxCureDepth || process.env.AECS_MAX_CURE_DEPTH || '3', 10),
      traceTtlMs: Number.parseInt(options.traceTtlMs || process.env.AECS_TRACE_TTL_MS || String(6 * 60 * 60 * 1000), 10),
      handshakeSecret: String(options.handshakeSecret || process.env.AECS_HANDSHAKE_SECRET || ''),
      webhookImpactThreshold: Number.parseInt(options.webhookImpactThreshold || process.env.AECS_WEBHOOK_IMPACT_THRESHOLD || '90', 10),
      telemetryWebhookUrl: options.telemetryWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL || '',
      telemetryFatalWebhookUrl: options.telemetryFatalWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL || '',
      telemetryHighImpactWebhookUrl: options.telemetryHighImpactWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH || '',
      telemetryChannelId: options.telemetryChannelId || process.env.AECS_TELEMETRY_CHANNEL_ID || '',
      supportLookupTemplate: options.supportLookupTemplate || process.env.AECS_SUPPORT_LOOKUP_TEMPLATE || '',
      telemetryTimeoutMs: Number.parseInt(options.telemetryTimeoutMs || process.env.AECS_TELEMETRY_TIMEOUT_MS || '5000', 10),
      exitOnFatal: options.exitOnFatal === true || process.env.AECS_EXIT_ON_FATAL === '1'
    };

    this.vault = new AecsVault({
      logDir: this.config.logDir,
      flushIntervalMs: this.config.flushIntervalMs
    });

    this.dispatcher = new Dispatcher({
      vault: this.vault,
      getContext: () => this.getContext(),
      runWithContext: (context, fn) => this.runWithContext(context, fn),
      suppressionThreshold: this.config.suppressionThreshold,
      suppressionWindowMs: this.config.suppressionWindowMs,
      fatalImpactThreshold: this.config.fatalImpactThreshold,
      maxCureDepth: this.config.maxCureDepth,
      telemetryWebhookUrl: this.config.telemetryWebhookUrl,
      telemetryFatalWebhookUrl: this.config.telemetryFatalWebhookUrl,
      telemetryHighImpactWebhookUrl: this.config.telemetryHighImpactWebhookUrl,
      telemetryChannelId: this.config.telemetryChannelId,
      supportLookupTemplate: this.config.supportLookupTemplate,
      telemetryTimeoutMs: this.config.telemetryTimeoutMs,
      webhookImpactThreshold: this.config.webhookImpactThreshold,
      exitOnFatal: this.config.exitOnFatal
    });
  }

  init(options = {}) {
    if (this.initialized) return;
    if (Object.keys(options).length > 0) {
      this.configure(options);
    }

    this.vault.start();
    this.dispatcher.start();
    this.initialized = true;
  }

  async reinitialize(options = {}) {
    await this.shutdown();
    this.configure(options);
    this.vault.start();
    this.dispatcher.start();
    this.initialized = true;
  }

  async shutdown() {
    if (!this.initialized) return;
    if (this.dispatcher) await this.dispatcher.stop();
    if (this.vault) await this.vault.stop();
    this.initialized = false;
  }

  createTraceId() {
    return `tx-${crypto.randomUUID()}`;
  }

  createTraceContext(seed = {}) {
    const traceId = seed.traceId || this.createTraceId();
    const startedAt = Number(seed.startedAt || Date.now());
    const ageMs = Date.now() - startedAt;
    const isExpired = Number.isFinite(ageMs) && ageMs > this.config.traceTtlMs;

    return {
      traceId: isExpired ? this.createTraceId() : traceId,
      parentTraceId: isExpired ? traceId : (seed.parentTraceId || null),
      startedAt: isExpired ? Date.now() : startedAt,
      source: seed.source || 'runtime',
      command: seed.command || null,
      subcommand: seed.subcommand || null,
      userId: seed.userId || null,
      guildId: seed.guildId || null,
      channelId: seed.channelId || null,
      supportId: seed.supportId || createSupportId(traceId),
      healingLedger: seed.healingLedger instanceof Set ? seed.healingLedger : new Set(),
      cureDepth: Number(seed.cureDepth || 0),
      metadata: seed.metadata && typeof seed.metadata === 'object' ? { ...seed.metadata } : {}
    };
  }

  runWithTrace(seed, callback) {
    this.init();
    const context = this.createTraceContext(seed || {});
    return this.als.run(context, callback);
  }

  runWithContext(context, callback) {
    this.init();
    const nextContext = this.createTraceContext(context || {});
    return this.als.run(nextContext, callback);
  }

  withInteraction(interaction, callback) {
    const command = interaction && interaction.commandName ? interaction.commandName : null;
    let subcommand = null;
    try {
      if (interaction && interaction.options && typeof interaction.options.getSubcommand === 'function') {
        subcommand = interaction.options.getSubcommand(false);
      }
    } catch (_error) {
      subcommand = null;
    }

    return this.runWithTrace({
      source: 'interaction',
      command,
      subcommand,
      userId: interaction && interaction.user ? interaction.user.id : null,
      guildId: interaction && interaction.guild ? interaction.guild.id : null,
      channelId: interaction && interaction.channelId ? interaction.channelId : null
    }, callback);
  }

  getContext() {
    return this.als.getStore() || null;
  }

  getSupportId(traceId) {
    if (traceId) return createSupportId(traceId);
    const context = this.getContext();
    if (context && context.traceId) return createSupportId(context.traceId);
    return createSupportId('aecs');
  }

  signPayload(body) {
    if (!this.config.handshakeSecret) return null;
    return crypto.createHmac('sha256', this.config.handshakeSecret).update(body).digest('hex');
  }

  verifyPayload(body, signature) {
    if (!this.config.handshakeSecret) return true;
    if (!signature) return false;
    const expected = this.signPayload(body);
    const expectedBuffer = Buffer.from(expected, 'utf8');
    const signatureBuffer = Buffer.from(String(signature), 'utf8');
    if (expectedBuffer.length !== signatureBuffer.length) return false;
    return crypto.timingSafeEqual(expectedBuffer, signatureBuffer);
  }

  packHandshake() {
    const context = this.getContext();
    if (!context) return null;

    const payload = {
      traceId: context.traceId,
      parentTraceId: context.parentTraceId || null,
      startedAt: context.startedAt,
      source: context.source || null,
      command: context.command || null,
      subcommand: context.subcommand || null,
      userId: context.userId || null,
      guildId: context.guildId || null,
      channelId: context.channelId || null,
      cureDepth: Number(context.cureDepth || 0)
    };

    const body = JSON.stringify(payload);
    const packed = {
      v: 1,
      payload,
      sig: this.signPayload(body)
    };

    return Buffer.from(JSON.stringify(packed), 'utf8').toString('base64url');
  }

  unpackHandshake(token, callback) {
    if (!token) {
      return this.runWithTrace({ source: 'handshake.missing' }, callback);
    }

    let parsed = null;
    try {
      parsed = JSON.parse(Buffer.from(String(token), 'base64url').toString('utf8'));
    } catch (_error) {
      return this.runWithTrace({ source: 'handshake.invalid' }, callback);
    }

    const payload = parsed && parsed.payload ? parsed.payload : null;
    if (!payload || typeof payload !== 'object') {
      return this.runWithTrace({ source: 'handshake.invalid_payload' }, callback);
    }

    const body = JSON.stringify(payload);
    if (!this.verifyPayload(body, parsed.sig)) {
      return this.runWithTrace({ source: 'handshake.signature_mismatch' }, callback);
    }

    const nextContext = this.createTraceContext({
      ...payload,
      source: payload.source || 'handshake',
      parentTraceId: payload.parentTraceId || null,
      metadata: { handshakeVersion: parsed.v || 1 }
    });

    return this.runWithContext(nextContext, callback);
  }

  getTraceparent() {
    const context = this.getContext();
    const traceHex = toHexTraceId(context && context.traceId ? context.traceId : this.createTraceId());
    const span = crypto.randomBytes(8).toString('hex');
    return `00-${traceHex}-${span}-01`;
  }

  adoptTraceparent(traceparent, seed = {}, callback = null) {
    const header = String(traceparent || '');
    const parts = header.split('-');
    let traceId = null;
    if (parts.length >= 4 && isHex32(parts[1])) {
      traceId = parts[1];
    }

    const contextSeed = {
      ...seed,
      traceId: traceId || seed.traceId || this.createTraceId(),
      source: seed.source || 'traceparent'
    };

    if (typeof callback === 'function') {
      return this.runWithTrace(contextSeed, callback);
    }
    return this.createTraceContext(contextSeed);
  }

  dispatch(error, options = {}) {
    this.init();
    return this.dispatcher.dispatch(error, options);
  }

  setTelemetryRouting(options = {}) {
    if (!options || typeof options !== 'object') return;
    this.config = {
      ...this.config,
      telemetryWebhookUrl: options.telemetryWebhookUrl !== undefined ? options.telemetryWebhookUrl : this.config.telemetryWebhookUrl,
      telemetryFatalWebhookUrl: options.telemetryFatalWebhookUrl !== undefined ? options.telemetryFatalWebhookUrl : this.config.telemetryFatalWebhookUrl,
      telemetryHighImpactWebhookUrl: options.telemetryHighImpactWebhookUrl !== undefined ? options.telemetryHighImpactWebhookUrl : this.config.telemetryHighImpactWebhookUrl,
      telemetryChannelId: options.telemetryChannelId !== undefined ? options.telemetryChannelId : this.config.telemetryChannelId,
      supportLookupTemplate: options.supportLookupTemplate !== undefined ? options.supportLookupTemplate : this.config.supportLookupTemplate,
      webhookImpactThreshold: options.webhookImpactThreshold !== undefined ? options.webhookImpactThreshold : this.config.webhookImpactThreshold,
      telemetryTimeoutMs: options.telemetryTimeoutMs !== undefined ? options.telemetryTimeoutMs : this.config.telemetryTimeoutMs
    };

    if (this.dispatcher && typeof this.dispatcher.setTelemetryOptions === 'function') {
      this.dispatcher.setTelemetryOptions({
        telemetryWebhookUrl: this.config.telemetryWebhookUrl,
        telemetryFatalWebhookUrl: this.config.telemetryFatalWebhookUrl,
        telemetryHighImpactWebhookUrl: this.config.telemetryHighImpactWebhookUrl,
        telemetryChannelId: this.config.telemetryChannelId,
        supportLookupTemplate: this.config.supportLookupTemplate,
        webhookImpactThreshold: this.config.webhookImpactThreshold,
        telemetryTimeoutMs: this.config.telemetryTimeoutMs
      });
    }
  }

  wrapUnknown(error, code = 'SYS-500', meta = {}) {
    return CodexError.fromUnknown(error, code, meta);
  }

  getMetrics() {
    this.init();
    return {
      vault: this.vault.getMetricsSnapshot(),
      suppression: this.dispatcher.getSuppressionSnapshot()
    };
  }
}

module.exports = new AECSCore();

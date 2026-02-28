const crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const path = require('path');
const os = require('os');

const AecsVault = require('./vault');
const ProcessVault = require('./ProcessVault');
const CodexError = require('./CodexError');
const { Dispatcher, createSupportId } = require('./Dispatcher');
const { RetentionManager } = require('./retention-manager');

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

function normalizeNullableString(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  return text ? text : null;
}

function sanitizePathSegment(value, fallback = 'instance') {
  const raw = normalizeNullableString(value) || fallback;
  return raw.replace(/[^a-zA-Z0-9._-]/g, '_');
}

function toBoolean(value, fallback) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

class AECSCore {
  constructor() {
    this.als = new AsyncLocalStorage();
    this.initialized = false;
    this.config = {};
    this.vault = null;
    this.dispatcher = null;
    this.retentionManager = null;

    this.configure({});
  }

  configure(options = {}) {
    const baseLogDir = path.resolve(options.logDir || process.env.AECS_LOG_DIR || path.join(process.cwd(), 'data', 'aecs'));
    const partitionByInstance = toBoolean(options.partitionByInstance, toBoolean(process.env.AECS_PARTITION_BY_INSTANCE, false));
    const configuredInstanceId = options.instanceId || process.env.AECS_INSTANCE_ID || `${os.hostname()}-${process.pid}`;
    const instanceId = sanitizePathSegment(configuredInstanceId, `node-${process.pid}`);
    const resolvedLogDir = partitionByInstance ? path.join(baseLogDir, instanceId) : baseLogDir;

    this.config = {
      baseLogDir,
      logDir: resolvedLogDir,
      partitionByInstance,
      instanceId,
      storageMode: String(options.storageMode || process.env.AECS_STORAGE_MODE || 'inline').toLowerCase(),
      storageProcessPath: options.storageProcessPath || process.env.AECS_STORAGE_PROCESS_PATH || '',
      flushIntervalMs: Number.parseInt(options.flushIntervalMs || process.env.AECS_FLUSH_INTERVAL_MS || '2000', 10),
      queueMaxEvents: Number.parseInt(options.queueMaxEvents || process.env.AECS_QUEUE_MAX_EVENTS || '10000', 10),
      queueMaxBytes: Number.parseInt(options.queueMaxBytes || process.env.AECS_QUEUE_MAX_BYTES || String(32 * 1024 * 1024), 10),
      queueDropPolicy: String(options.queueDropPolicy || process.env.AECS_QUEUE_DROP_POLICY || 'drop_oldest'),
      suppressionThreshold: Number.parseInt(options.suppressionThreshold || process.env.AECS_SUPPRESSION_THRESHOLD || '50', 10),
      suppressionWindowMs: Number.parseInt(options.suppressionWindowMs || process.env.AECS_SUPPRESSION_WINDOW_MS || '60000', 10),
      alertThreshold: Number.parseInt(options.alertThreshold || process.env.AECS_ALERT_THRESHOLD || '20', 10),
      maxLatencySamples: Number.parseInt(options.maxLatencySamples || process.env.AECS_DISPATCH_LATENCY_SAMPLES || '2048', 10),
      fatalImpactThreshold: Number.parseInt(options.fatalImpactThreshold || process.env.AECS_FATAL_IMPACT_THRESHOLD || '90', 10),
      maxCureDepth: Number.parseInt(options.maxCureDepth || process.env.AECS_MAX_CURE_DEPTH || '3', 10),
      traceTtlMs: Number.parseInt(options.traceTtlMs || process.env.AECS_TRACE_TTL_MS || String(6 * 60 * 60 * 1000), 10),
      handshakeSecret: String(options.handshakeSecret || process.env.AECS_HANDSHAKE_SECRET || ''),
      webhookImpactThreshold: Number.parseInt(options.webhookImpactThreshold || process.env.AECS_WEBHOOK_IMPACT_THRESHOLD || '70', 10),
      telemetryWebhookUrl: options.telemetryWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL || '',
      telemetryFatalWebhookUrl: options.telemetryFatalWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL || '',
      telemetryHighImpactWebhookUrl: options.telemetryHighImpactWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH || '',
      telemetryChannelId: options.telemetryChannelId || process.env.AECS_TELEMETRY_CHANNEL_ID || '',
      supportLookupTemplate: options.supportLookupTemplate || process.env.AECS_SUPPORT_LOOKUP_TEMPLATE || '',
      telemetryTimeoutMs: Number.parseInt(options.telemetryTimeoutMs || process.env.AECS_TELEMETRY_TIMEOUT_MS || '5000', 10),
      alertWorkerMode: String(options.alertWorkerMode || process.env.AECS_ALERT_WORKER_MODE || 'inline').toLowerCase(),
      alertWorkerProcessPath: options.alertWorkerProcessPath || process.env.AECS_ALERT_WORKER_PROCESS_PATH || '',
      alertWorkerMaxRetries: Number.parseInt(options.alertWorkerMaxRetries || process.env.AECS_ALERT_MAX_RETRIES || '3', 10),
      alertWorkerBaseDelayMs: Number.parseInt(options.alertWorkerBaseDelayMs || process.env.AECS_ALERT_BASE_DELAY_MS || '500', 10),
      alertWorkerMaxDelayMs: Number.parseInt(options.alertWorkerMaxDelayMs || process.env.AECS_ALERT_MAX_DELAY_MS || '30000', 10),
      alertWorkerDeadLetterLimit: Number.parseInt(options.alertWorkerDeadLetterLimit || process.env.AECS_ALERT_DLQ_LIMIT || '500', 10),
      alertWorkerQueueMaxEvents: Number.parseInt(options.alertWorkerQueueMaxEvents || process.env.AECS_ALERT_QUEUE_MAX_EVENTS || '2000', 10),
      alertWorkerQueueMaxBytes: Number.parseInt(
        options.alertWorkerQueueMaxBytes || process.env.AECS_ALERT_QUEUE_MAX_BYTES || String(4 * 1024 * 1024),
        10
      ),
      alertWorkerQueueDropPolicy: String(options.alertWorkerQueueDropPolicy || process.env.AECS_ALERT_QUEUE_DROP_POLICY || 'drop_oldest_non_fatal').toLowerCase(),
      alertWorkerRetryJitterRatio: Number(options.alertWorkerRetryJitterRatio || process.env.AECS_ALERT_RETRY_JITTER_RATIO || 0.2),
      alertWorkerCircuitFailureThreshold: Number.parseInt(
        options.alertWorkerCircuitFailureThreshold || process.env.AECS_ALERT_CIRCUIT_FAILURE_THRESHOLD || '5',
        10
      ),
      alertWorkerCircuitOpenMs: Number.parseInt(options.alertWorkerCircuitOpenMs || process.env.AECS_ALERT_CIRCUIT_OPEN_MS || '15000', 10),
      alertWorkerCircuitSuccessThreshold: Number.parseInt(
        options.alertWorkerCircuitSuccessThreshold || process.env.AECS_ALERT_CIRCUIT_SUCCESS_THRESHOLD || '2',
        10
      ),
      retentionEnabled: toBoolean(options.retentionEnabled, toBoolean(process.env.AECS_RETENTION_ENABLED, false)),
      retentionDryRun: toBoolean(options.retentionDryRun, toBoolean(process.env.AECS_RETENTION_DRY_RUN, true)),
      retentionMaxAgeDays: Number.parseInt(options.retentionMaxAgeDays || process.env.AECS_RETENTION_MAX_AGE_DAYS || '30', 10),
      retentionIntervalMs: Number.parseInt(options.retentionIntervalMs || process.env.AECS_RETENTION_INTERVAL_MS || String(24 * 60 * 60 * 1000), 10),
      retentionArchiveEnabled: toBoolean(options.retentionArchiveEnabled, toBoolean(process.env.AECS_RETENTION_ARCHIVE_ENABLED, false)),
      retentionArchiveDir: options.retentionArchiveDir || process.env.AECS_RETENTION_ARCHIVE_DIR || '',
      retentionArchiveCompress: toBoolean(options.retentionArchiveCompress, toBoolean(process.env.AECS_RETENTION_ARCHIVE_COMPRESS, false)),
      exitOnFatal: options.exitOnFatal === true || process.env.AECS_EXIT_ON_FATAL === '1'
    };

    const vaultOptions = {
      logDir: this.config.logDir,
      flushIntervalMs: this.config.flushIntervalMs,
      queueMaxEvents: this.config.queueMaxEvents,
      queueMaxBytes: this.config.queueMaxBytes,
      queueDropPolicy: this.config.queueDropPolicy
    };
    if (this.config.storageMode === 'process') {
      this.vault = new ProcessVault({
        ...vaultOptions,
        workerPath: this.config.storageProcessPath || undefined
      });
    } else {
      this.vault = new AecsVault(vaultOptions);
    }

    this.dispatcher = new Dispatcher({
      vault: this.vault,
      getContext: () => this.getContext(),
      runWithContext: (context, fn) => this.runWithContext(context, fn),
      suppressionThreshold: this.config.suppressionThreshold,
      suppressionWindowMs: this.config.suppressionWindowMs,
      alertThreshold: this.config.alertThreshold,
      maxLatencySamples: this.config.maxLatencySamples,
      fatalImpactThreshold: this.config.fatalImpactThreshold,
      maxCureDepth: this.config.maxCureDepth,
      telemetryWebhookUrl: this.config.telemetryWebhookUrl,
      telemetryFatalWebhookUrl: this.config.telemetryFatalWebhookUrl,
      telemetryHighImpactWebhookUrl: this.config.telemetryHighImpactWebhookUrl,
      telemetryChannelId: this.config.telemetryChannelId,
      supportLookupTemplate: this.config.supportLookupTemplate,
      telemetryTimeoutMs: this.config.telemetryTimeoutMs,
      alertWorkerMode: this.config.alertWorkerMode,
      alertWorkerProcessPath: this.config.alertWorkerProcessPath || undefined,
      webhookImpactThreshold: this.config.webhookImpactThreshold,
      alertWorkerMaxRetries: this.config.alertWorkerMaxRetries,
      alertWorkerBaseDelayMs: this.config.alertWorkerBaseDelayMs,
      alertWorkerMaxDelayMs: this.config.alertWorkerMaxDelayMs,
      alertWorkerDeadLetterLimit: this.config.alertWorkerDeadLetterLimit,
      alertWorkerQueueMaxEvents: this.config.alertWorkerQueueMaxEvents,
      alertWorkerQueueMaxBytes: this.config.alertWorkerQueueMaxBytes,
      alertWorkerQueueDropPolicy: this.config.alertWorkerQueueDropPolicy,
      alertWorkerRetryJitterRatio: this.config.alertWorkerRetryJitterRatio,
      alertWorkerCircuitFailureThreshold: this.config.alertWorkerCircuitFailureThreshold,
      alertWorkerCircuitOpenMs: this.config.alertWorkerCircuitOpenMs,
      alertWorkerCircuitSuccessThreshold: this.config.alertWorkerCircuitSuccessThreshold,
      exitOnFatal: this.config.exitOnFatal
    });

    this.retentionManager = new RetentionManager({
      logDir: this.config.logDir,
      enabled: this.config.retentionEnabled,
      dryRun: this.config.retentionDryRun,
      maxAgeDays: this.config.retentionMaxAgeDays,
      intervalMs: this.config.retentionIntervalMs,
      archiveEnabled: this.config.retentionArchiveEnabled,
      archiveDir: this.config.retentionArchiveDir,
      archiveCompress: this.config.retentionArchiveCompress,
      onError: (error) => {
        console.error('AECS retention manager failed:', error);
      }
    });
  }

  init(options = {}) {
    if (this.initialized) return;
    if (Object.keys(options).length > 0) {
      this.configure(options);
    }

    this.vault.start();
    this.dispatcher.start();
    if (this.retentionManager) this.retentionManager.start();
    this.initialized = true;
  }

  async reinitialize(options = {}) {
    await this.shutdown();
    this.configure(options);
    this.vault.start();
    this.dispatcher.start();
    if (this.retentionManager) this.retentionManager.start();
    this.initialized = true;
  }

  async shutdown() {
    if (!this.initialized) return;
    if (this.retentionManager) this.retentionManager.stop();
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
      eventType: seed.eventType || null,
      command: seed.command || null,
      subcommand: seed.subcommand || null,
      userId: seed.userId || null,
      guildId: seed.guildId || null,
      channelId: seed.channelId || null,
      shardId: normalizeNullableString(seed.shardId || process.env.SHARD_ID),
      clusterId: normalizeNullableString(seed.clusterId || process.env.CLUSTER_ID),
      processId: Number.isFinite(Number(seed.processId)) ? Number(seed.processId) : process.pid,
      instanceId: normalizeNullableString(seed.instanceId || this.config.instanceId),
      hostname: normalizeNullableString(seed.hostname || process.env.HOSTNAME || os.hostname()),
      release: normalizeNullableString(seed.release || process.env.RELEASE || process.env.npm_package_version),
      environment: normalizeNullableString(seed.environment || process.env.NODE_ENV),
      sessionId: normalizeNullableString(seed.sessionId),
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
      eventType: 'interactionCreate',
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

  getPlaneSnapshot(vaultMetrics, dispatchMetrics, alertMetrics, retentionMetrics) {
    const storageHealthy = !(vaultMetrics && vaultMetrics.streamHealthy === false);
    const alertReady = Boolean(alertMetrics && alertMetrics.running);
    const retentionHealthy = !(
      retentionMetrics
      && retentionMetrics.lastSummary
      && Number(retentionMetrics.lastSummary.failedCount || 0) > 0
    );

    const planes = {
      capture: {
        ready: this.initialized,
        healthy: this.initialized
      },
      route: {
        ready: Boolean(this.dispatcher),
        healthy: Boolean(dispatchMetrics)
      },
      storage: {
        ready: Boolean(this.vault),
        healthy: storageHealthy
      },
      alert: {
        ready: alertReady,
        healthy: Boolean(alertMetrics)
      },
      retention: {
        ready: Boolean(this.retentionManager),
        healthy: retentionHealthy
      }
    };

    const allReady = Object.values(planes).every((plane) => plane.ready);
    const allHealthy = Object.values(planes).every((plane) => plane.healthy);

    return {
      status: allReady && allHealthy ? 'ok' : (allHealthy ? 'degraded' : 'error'),
      ready: allReady,
      healthy: allHealthy,
      planes
    };
  }

  getMetrics() {
    this.init();
    const vaultMetrics = this.vault.getMetricsSnapshot();
    const suppressionMetrics = this.dispatcher.getSuppressionSnapshot();
    const dispatchMetrics = this.dispatcher.getDispatchMetricsSnapshot();
    const alertMetrics = this.dispatcher.getAlertWorkerSnapshot();
    const retentionMetrics = this.retentionManager ? this.retentionManager.getSnapshot() : null;
    const readiness = this.getPlaneSnapshot(vaultMetrics, dispatchMetrics, alertMetrics, retentionMetrics);

    return {
      config: {
        logDir: this.config.logDir,
        baseLogDir: this.config.baseLogDir,
        partitionByInstance: this.config.partitionByInstance,
        instanceId: this.config.instanceId,
        storageMode: this.config.storageMode,
        queueMaxEvents: this.config.queueMaxEvents,
        queueMaxBytes: this.config.queueMaxBytes,
        queueDropPolicy: this.config.queueDropPolicy,
        alertWorkerMode: this.config.alertWorkerMode,
        alertWorkerQueueMaxEvents: this.config.alertWorkerQueueMaxEvents,
        alertWorkerQueueMaxBytes: this.config.alertWorkerQueueMaxBytes,
        alertWorkerQueueDropPolicy: this.config.alertWorkerQueueDropPolicy,
        retentionArchiveEnabled: this.config.retentionArchiveEnabled,
        retentionArchiveDir: this.config.retentionArchiveDir || null,
        retentionArchiveCompress: this.config.retentionArchiveCompress,
        maxLatencySamples: this.config.maxLatencySamples
      },
      vault: vaultMetrics,
      suppression: suppressionMetrics,
      dispatch: dispatchMetrics,
      alerts: alertMetrics,
      retention: retentionMetrics,
      readiness
    };
  }

  runRetentionNow(overrides = {}) {
    this.init();
    if (!this.retentionManager) return Promise.resolve(null);
    return this.retentionManager.runOnce(overrides);
  }
}

module.exports = new AECSCore();

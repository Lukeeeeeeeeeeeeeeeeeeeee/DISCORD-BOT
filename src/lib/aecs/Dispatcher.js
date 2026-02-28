const crypto = require('crypto');
const os = require('os');
const CodexError = require('./CodexError');
const dictionaries = require('./dictionaries');
const { sanitizeMeta, normalizeSeverity, clampImpact } = require('./sanitize');
const { TelemetryAdapter } = require('./telemetry-adapter');
const { AlertWorker } = require('./AlertWorker');
const { ProcessAlertWorker } = require('./ProcessAlertWorker');
const { classifyError, maxSeverity } = require('./classification-policy');

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

function createFingerprint(scope, code) {
  return crypto.createHash('md5').update(`${scope || 'global'}|${code}`).digest('hex');
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

function firstNonNull(...values) {
  for (const value of values) {
    if (value !== undefined && value !== null && value !== '') return value;
  }
  return null;
}

function toContextEnvelope(context, traceId, eventId, options = {}) {
  const sourceContext = context && typeof context === 'object' ? context : {};
  const meta = options.meta && typeof options.meta === 'object' ? options.meta : {};

  const runtime = {
    instanceId: firstNonNull(sourceContext.instanceId, meta.instanceId, process.env.AECS_INSTANCE_ID),
    shardId: firstNonNull(sourceContext.shardId, meta.shardId, process.env.SHARD_ID),
    clusterId: firstNonNull(sourceContext.clusterId, meta.clusterId, process.env.CLUSTER_ID),
    processId: firstNonNull(sourceContext.processId, process.pid),
    hostname: firstNonNull(sourceContext.hostname, process.env.HOSTNAME, os.hostname()),
    release: firstNonNull(sourceContext.release, process.env.RELEASE, process.env.npm_package_version),
    environment: firstNonNull(sourceContext.environment, process.env.NODE_ENV)
  };

  const discord = {
    guildId: firstNonNull(sourceContext.guildId, meta.guildId),
    channelId: firstNonNull(sourceContext.channelId, meta.channelId),
    userId: firstNonNull(sourceContext.userId, meta.userId)
  };

  const session = {
    source: firstNonNull(sourceContext.source, meta.source),
    eventType: firstNonNull(sourceContext.eventType, options.eventType, meta.eventType),
    command: firstNonNull(sourceContext.command, meta.command),
    subcommand: firstNonNull(sourceContext.subcommand, meta.subcommand),
    sessionId: firstNonNull(sourceContext.sessionId, meta.sessionId)
  };

  const correlation = {
    traceId,
    parentTraceId: firstNonNull(sourceContext.parentTraceId, meta.parentTraceId),
    eventId
  };

  return {
    version: 2,
    runtime,
    discord,
    session,
    correlation
  };
}

function createTraceId() {
  return `tx-${crypto.randomUUID()}`;
}

function createEventId() {
  return `ev-${crypto.randomUUID()}`;
}

class Dispatcher {
  constructor(options = {}) {
    this.vault = options.vault;
    this.getContext = typeof options.getContext === 'function' ? options.getContext : () => null;
    this.runWithContext = typeof options.runWithContext === 'function' ? options.runWithContext : async (_context, fn) => fn();

    this.suppressionThreshold = Number.parseInt(options.suppressionThreshold || '50', 10);
    this.suppressionWindowMs = Number.parseInt(options.suppressionWindowMs || '60000', 10);
    this.alertThreshold = Number.parseInt(options.alertThreshold || process.env.AECS_ALERT_THRESHOLD || '20', 10);
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
    this.alertWorkerMode = String(options.alertWorkerMode || process.env.AECS_ALERT_WORKER_MODE || 'inline').toLowerCase();
    this.alertWorker = options.alertWorker || this.createAlertWorker(options);

    this.suppressionMap = new Map();
    this.alertThrottleMap = new Map();
    this.suppressionTimer = null;
    this.maxLatencySamples = Number.parseInt(options.maxLatencySamples || process.env.AECS_DISPATCH_LATENCY_SAMPLES || '2048', 10);
    this.dispatchMetrics = {
      total: 0,
      failed: 0,
      suppressed: 0,
      throttled: 0,
      alertsEnqueued: 0,
      prunedSuppression: 0,
      prunedThrottle: 0,
      bySeverity: {
        INFO: 0,
        WARN: 0,
        ERROR: 0,
        FATAL: 0
      },
      latencySamplesMs: [],
      lastLatencyMs: null
    };
  }

  createTelemetryAdapter(telemetryOptions = {}) {
    return new TelemetryAdapter({
      defaultWebhookUrl: telemetryOptions.telemetryWebhookUrl || '',
      fatalWebhookUrl: telemetryOptions.telemetryFatalWebhookUrl || '',
      highImpactWebhookUrl: telemetryOptions.telemetryHighImpactWebhookUrl || '',
      channelId: telemetryOptions.telemetryChannelId || '',
      supportLookupTemplate: telemetryOptions.supportLookupTemplate || '',
      impactThreshold: telemetryOptions.webhookImpactThreshold || '90',
      timeoutMs: telemetryOptions.telemetryTimeoutMs || '5000',
      fetchImpl: telemetryOptions.fetchImpl
    });
  }

  setTelemetryOptions(partial = {}) {
    if (!partial || typeof partial !== 'object') return;
    if (partial.telemetryAdapter && typeof partial.telemetryAdapter.send === 'function') {
      this.telemetryAdapter = partial.telemetryAdapter;
      if (this.alertWorker && typeof this.alertWorker.setSendFn === 'function') {
        this.alertWorker.setSendFn((record) => this.maybeSendWebhook(record));
      }
      return;
    }
    this.telemetryOptions = { ...this.telemetryOptions, ...partial };
    this.telemetryAdapter = this.createTelemetryAdapter(this.telemetryOptions);
    if (this.alertWorker && typeof this.alertWorker.setSendFn === 'function') {
      this.alertWorker.setSendFn((record) => this.maybeSendWebhook(record));
    }
    if (this.alertWorker && typeof this.alertWorker.setTelemetryOptions === 'function') {
      this.alertWorker.setTelemetryOptions(this.telemetryOptions);
    }
  }

  createAlertWorker(options = {}) {
    const workerConfig = {
      maxRetries: Number.parseInt(options.alertWorkerMaxRetries || process.env.AECS_ALERT_MAX_RETRIES || '3', 10),
      baseDelayMs: Number.parseInt(options.alertWorkerBaseDelayMs || process.env.AECS_ALERT_BASE_DELAY_MS || '500', 10),
      maxDelayMs: Number.parseInt(options.alertWorkerMaxDelayMs || process.env.AECS_ALERT_MAX_DELAY_MS || '30000', 10),
      deadLetterLimit: Number.parseInt(options.alertWorkerDeadLetterLimit || process.env.AECS_ALERT_DLQ_LIMIT || '500', 10),
      queueMaxEvents: Number.parseInt(options.alertWorkerQueueMaxEvents || process.env.AECS_ALERT_QUEUE_MAX_EVENTS || '2000', 10),
      queueMaxBytes: Number.parseInt(options.alertWorkerQueueMaxBytes || process.env.AECS_ALERT_QUEUE_MAX_BYTES || String(4 * 1024 * 1024), 10),
      queueDropPolicy: String(options.alertWorkerQueueDropPolicy || process.env.AECS_ALERT_QUEUE_DROP_POLICY || 'drop_oldest_non_fatal').toLowerCase(),
      retryJitterRatio: Number(options.alertWorkerRetryJitterRatio || process.env.AECS_ALERT_RETRY_JITTER_RATIO || 0.2),
      circuitFailureThreshold: Number.parseInt(
        options.alertWorkerCircuitFailureThreshold || process.env.AECS_ALERT_CIRCUIT_FAILURE_THRESHOLD || '5',
        10
      ),
      circuitOpenMs: Number.parseInt(options.alertWorkerCircuitOpenMs || process.env.AECS_ALERT_CIRCUIT_OPEN_MS || '15000', 10),
      circuitSuccessThreshold: Number.parseInt(
        options.alertWorkerCircuitSuccessThreshold || process.env.AECS_ALERT_CIRCUIT_SUCCESS_THRESHOLD || '2',
        10
      ),
      onDeadLetter: (entry) => this.handleAlertDeadLetter(entry)
    };

    if (this.alertWorkerMode === 'process') {
      return new ProcessAlertWorker({
        workerPath: options.alertWorkerProcessPath,
        telemetryWebhookUrl: this.telemetryOptions.telemetryWebhookUrl,
        telemetryFatalWebhookUrl: this.telemetryOptions.telemetryFatalWebhookUrl,
        telemetryHighImpactWebhookUrl: this.telemetryOptions.telemetryHighImpactWebhookUrl,
        telemetryChannelId: this.telemetryOptions.telemetryChannelId,
        supportLookupTemplate: this.telemetryOptions.supportLookupTemplate,
        webhookImpactThreshold: this.telemetryOptions.webhookImpactThreshold,
        telemetryTimeoutMs: this.telemetryOptions.telemetryTimeoutMs,
        ...workerConfig
      });
    }

    return new AlertWorker({
      sendFn: (record) => this.maybeSendWebhook(record),
      ...workerConfig
    });
  }

  start() {
    if (this.suppressionTimer) return;
    if (this.alertWorker && typeof this.alertWorker.start === 'function') {
      this.alertWorker.start();
    }
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
    if (this.alertWorker && typeof this.alertWorker.stop === 'function') {
      await this.alertWorker.stop();
    }
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
          this.suppressionMap.delete(fingerprint);
          this.dispatchMetrics.prunedSuppression += 1;
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
        hash: createFingerprint('aecs.circuit_breaker', state.code),
        hashId: hashIdFromFingerprint(createFingerprint('aecs.circuit_breaker', state.code))
      };

      if (this.vault) this.vault.queue(summaryRecord);
      console.warn('[AECS]', summaryRecord.message);

      this.suppressionMap.delete(fingerprint);
      this.dispatchMetrics.prunedSuppression += 1;
    }
    this.pruneAlertThrottleMap(now);
  }

  pruneAlertThrottleMap(now = Date.now()) {
    for (const [fingerprint, state] of this.alertThrottleMap.entries()) {
      if (!state) {
        this.alertThrottleMap.delete(fingerprint);
        this.dispatchMetrics.prunedThrottle += 1;
        continue;
      }
      if (now - state.windowStart >= this.suppressionWindowMs) {
        this.alertThrottleMap.delete(fingerprint);
        this.dispatchMetrics.prunedThrottle += 1;
      }
    }
  }

  shouldThrottleAlert(fingerprint, severity) {
    if (severity === 'FATAL') return false;
    if (!Number.isFinite(this.alertThreshold) || this.alertThreshold <= 0) return false;

    const now = Date.now();
    let state = this.alertThrottleMap.get(fingerprint);
    if (!state) {
      state = { count: 0, windowStart: now };
      this.alertThrottleMap.set(fingerprint, state);
    }

    if (now - state.windowStart >= this.suppressionWindowMs) {
      state.count = 0;
      state.windowStart = now;
    }

    state.count += 1;
    return state.count > this.alertThreshold;
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
    if (!record || !this.telemetryAdapter || typeof this.telemetryAdapter.send !== 'function') {
      return { sent: false, reason: 'disabled' };
    }
    return this.telemetryAdapter.send(record);
  }

  enqueueAlert(record) {
    if (!record || !this.alertWorker || typeof this.alertWorker.enqueue !== 'function') {
      return { enqueued: false, reason: 'worker_unavailable' };
    }
    return this.alertWorker.enqueue(record);
  }

  handleAlertDeadLetter(entry) {
    if (!entry || !entry.record || !this.vault) return;
    const record = entry.record;
    const code = 'SYS-720';
    const scope = 'aecs.alert.dead_letter';
    const fingerprint = createFingerprint(scope, code);
    const deadLetterRecord = {
      version: '6.1.0',
      timestamp: Date.now(),
      traceId: record.traceId || null,
      eventId: createEventId(),
      supportId: createSupportId(record.traceId || record.eventId || code),
      code,
      title: 'AECS Alert Delivery Dead Letter',
      severity: 'WARN',
      impact: 45,
      domain: 'SYS',
      scope,
      message: 'Telemetry alert delivery failed after max retries',
      meta: {
        alertCode: record.code || null,
        alertScope: record.scope || null,
        attempts: Number(entry.attempts || 0),
        error: entry.error || null
      },
      hash: fingerprint,
      hashId: hashIdFromFingerprint(fingerprint)
    };
    this.vault.queue(deadLetterRecord);
  }

  recordDispatchMetrics(sample = {}) {
    const severity = String(sample.severity || 'ERROR').toUpperCase();
    this.dispatchMetrics.total += 1;
    if (sample.failed) this.dispatchMetrics.failed += 1;
    if (sample.suppressed) this.dispatchMetrics.suppressed += 1;
    if (sample.alertThrottled) this.dispatchMetrics.throttled += 1;
    if (sample.alertEnqueued) this.dispatchMetrics.alertsEnqueued += 1;
    if (Object.prototype.hasOwnProperty.call(this.dispatchMetrics.bySeverity, severity)) {
      this.dispatchMetrics.bySeverity[severity] += 1;
    } else {
      this.dispatchMetrics.bySeverity.ERROR += 1;
    }

    const latencyMs = Number(sample.latencyMs || 0);
    if (Number.isFinite(latencyMs) && latencyMs >= 0) {
      this.dispatchMetrics.lastLatencyMs = latencyMs;
      this.dispatchMetrics.latencySamplesMs.push(latencyMs);
      if (this.dispatchMetrics.latencySamplesMs.length > this.maxLatencySamples) {
        this.dispatchMetrics.latencySamplesMs.splice(
          0,
          this.dispatchMetrics.latencySamplesMs.length - this.maxLatencySamples
        );
      }
    }
  }

  computePercentile(values, percentile) {
    if (!Array.isArray(values) || values.length === 0) return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const p = Math.min(100, Math.max(0, Number(percentile || 0)));
    const rank = Math.ceil((p / 100) * sorted.length) - 1;
    const index = Math.min(sorted.length - 1, Math.max(0, rank));
    return sorted[index];
  }

  async dispatch(error, options = {}) {
    const dispatchStartedAt = Date.now();
    const scope = options.scope || 'runtime';
    const codexError = error instanceof CodexError
      ? error
      : CodexError.fromUnknown(error, options.code || 'SYS-500', options.meta || { scope });

    const resolvedDefinition = codexError.definition || dictionaries.getDefinition(codexError.code);
    const definitionFound = Boolean(resolvedDefinition);
    const definition = resolvedDefinition || dictionaries.getDefinition('SYS-001');
    const context = this.getContext ? this.getContext() : null;
    const traceContext = getContextView(context);

    const rawMetaForPolicy = { ...(codexError.meta || {}), ...(options.meta || {}) };
    const sanitizedMeta = sanitizeMeta(rawMetaForPolicy, definition);

    const impact = this.computeImpact(definition, sanitizedMeta, traceContext);
    let severity = normalizeSeverity(definition && definition.severity ? definition.severity : 'ERROR');
    if (impact >= this.fatalImpactThreshold) severity = 'FATAL';
    const classification = classifyError({
      code: codexError.code,
      domain: getDomainForCode(codexError.code),
      severity,
      impact,
      meta: rawMetaForPolicy,
      hasAutocure: Boolean(definition && typeof definition.autocure === 'function'),
      definitionFound
    });
    if (classification && classification.severityOverride) {
      severity = maxSeverity(severity, classification.severityOverride);
    }

    const traceId = traceContext.traceId || createTraceId();
    const eventId = createEventId();
    const supportId = createSupportId(eventId);
    const fingerprint = createFingerprint(scope, codexError.code);
    const hashId = hashIdFromFingerprint(fingerprint);

    const message = codexError.message || (definition && definition.title) || 'Codex error';

    const record = {
      version: definition && definition.version ? definition.version : '6.1.0',
      timestamp: Date.now(),
      traceId,
      eventId,
      supportId,
      context: toContextEnvelope(context, traceId, eventId, options),
      code: codexError.code,
      title: definition && definition.title ? definition.title : 'Codex Error',
      severity,
      impact,
      domain: getDomainForCode(codexError.code),
      classification: {
        domain: classification.domain,
        failureClass: classification.failureClass,
        recoverability: classification.recoverability,
        customerImpact: classification.customerImpact,
        securityImpact: classification.securityImpact
      },
      confidence: classification.confidence,
      actionability: classification.actionability,
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
    const alertThrottled = !suppressed && this.shouldThrottleAlert(fingerprint, severity);
    if (!suppressed && this.vault) {
      if (severity === 'FATAL') {
        this.vault.forceWriteSync(record);
      } else {
        this.vault.queue(record);
      }
    }

    if (severity === 'ERROR' || severity === 'FATAL') {
      if (!suppressed) {
        console.error('[AECS]', record.code, record.scope, record.meta);
      }
    } else if (severity === 'WARN' && !suppressed) {
      console.warn('[AECS]', record.code, record.scope, record.meta);
    }

    let alertEnqueued = false;
    await this.maybeRunAutocure(definition, codexError, context, scope);
    if (!suppressed && !alertThrottled) {
      const enqueueResult = this.enqueueAlert(record);
      alertEnqueued = Boolean(enqueueResult && enqueueResult.enqueued);
    }

    if (severity === 'FATAL' && this.exitOnFatal) {
      setImmediate(() => {
        process.exit(1);
      });
    }

    const latencyMs = Date.now() - dispatchStartedAt;
    this.recordDispatchMetrics({
      severity,
      suppressed,
      alertThrottled,
      alertEnqueued,
      latencyMs
    });

    return {
      record,
      supportId,
      suppressed,
      alertThrottled,
      alertEnqueued
    };
  }

  getAlertWorkerSnapshot() {
    if (!this.alertWorker || typeof this.alertWorker.getSnapshot !== 'function') {
      return null;
    }
    const snapshot = this.alertWorker.getSnapshot() || {};
    if (!snapshot.mode) {
      snapshot.mode = this.alertWorkerMode === 'process' ? 'process' : 'inline';
    }
    return snapshot;
  }

  getDispatchMetricsSnapshot() {
    const total = this.dispatchMetrics.total;
    const failed = this.dispatchMetrics.failed;
    const dropped = 0;
    return {
      total,
      failed,
      suppressed: this.dispatchMetrics.suppressed,
      throttled: this.dispatchMetrics.throttled,
      alertsEnqueued: this.dispatchMetrics.alertsEnqueued,
      bySeverity: { ...this.dispatchMetrics.bySeverity },
      latency: {
        samples: this.dispatchMetrics.latencySamplesMs.length,
        lastMs: this.dispatchMetrics.lastLatencyMs,
        p95Ms: this.computePercentile(this.dispatchMetrics.latencySamplesMs, 95)
      },
      state: {
        suppressionFingerprints: this.suppressionMap.size,
        throttleFingerprints: this.alertThrottleMap.size,
        prunedSuppression: this.dispatchMetrics.prunedSuppression,
        prunedThrottle: this.dispatchMetrics.prunedThrottle
      },
      rates: {
        failedRate: total > 0 ? failed / total : 0,
        droppedRate: total > 0 ? dropped / total : 0
      }
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
      alertThreshold: this.alertThreshold,
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

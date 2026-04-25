const path = require('path');
const { fork } = require('child_process');

function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

const SEVERITY_RANK = {
  INFO: 1,
  WARN: 2,
  ERROR: 3,
  FATAL: 4
};

function getSeverityRank(record) {
  const severity = String(record && record.severity ? record.severity : 'ERROR').toUpperCase();
  return SEVERITY_RANK[severity] || SEVERITY_RANK.ERROR;
}

function estimateRecordBytes(record) {
  try {
    return Buffer.byteLength(JSON.stringify(record), 'utf8');
  } catch (_error) {
    return 1024;
  }
}

class ProcessAlertWorker {
  constructor(options = {}) {
    this.telemetry = {
      telemetryWebhookUrl: options.telemetryWebhookUrl || '',
      telemetryFatalWebhookUrl: options.telemetryFatalWebhookUrl || '',
      telemetryHighImpactWebhookUrl: options.telemetryHighImpactWebhookUrl || '',
      telemetryChannelId: options.telemetryChannelId || '',
      supportLookupTemplate: options.supportLookupTemplate || '',
      webhookImpactThreshold: options.webhookImpactThreshold || '90',
      telemetryTimeoutMs: options.telemetryTimeoutMs || '5000'
    };
    this.workerConfig = {
      maxRetries: asPositiveInt(options.maxRetries, 3),
      baseDelayMs: asPositiveInt(options.baseDelayMs, 500),
      maxDelayMs: asPositiveInt(options.maxDelayMs, 30000),
      deadLetterLimit: asPositiveInt(options.deadLetterLimit, 500),
      queueMaxEvents: asPositiveInt(options.queueMaxEvents, 2000),
      queueMaxBytes: asPositiveInt(options.queueMaxBytes, 4 * 1024 * 1024),
      queueDropPolicy: String(options.queueDropPolicy || 'drop_oldest_non_fatal').toLowerCase(),
      retryJitterRatio: Number.isFinite(Number(options.retryJitterRatio)) ? Number(options.retryJitterRatio) : 0.2,
      circuitFailureThreshold: asPositiveInt(options.circuitFailureThreshold, 5),
      circuitOpenMs: asPositiveInt(options.circuitOpenMs, 15000),
      circuitSuccessThreshold: asPositiveInt(options.circuitSuccessThreshold, 2)
    };
    this.onDeadLetter = typeof options.onDeadLetter === 'function' ? options.onDeadLetter : null;
    this.workerPath = options.workerPath || path.join(__dirname, 'alert-worker-process.js');
    this.snapshotRequestTimeoutMs = Number.parseInt(options.snapshotRequestTimeoutMs || '250', 10);
    this.pendingMaxEvents = asPositiveInt(options.pendingMaxEvents || this.workerConfig.queueMaxEvents, this.workerConfig.queueMaxEvents);
    this.pendingMaxBytes = asPositiveInt(options.pendingMaxBytes || this.workerConfig.queueMaxBytes, this.workerConfig.queueMaxBytes);
    this.pendingDropPolicy = String(options.pendingDropPolicy || this.workerConfig.queueDropPolicy || 'drop_oldest_non_fatal').toLowerCase();

    this.child = null;
    this.running = false;
    this.ready = false;
    this.pending = [];
    this.pendingBytes = 0;
    this.lastSnapshot = null;
    this.lastError = null;
    this.requestSeq = 0;
    this.pendingSnapshotRequests = new Map();
    this.metrics = {
      enqueued: 0,
      dropped: 0,
      restarts: 0,
      droppedByPolicy: {
        drop_oldest_non_fatal: 0,
        drop_low_severity: 0,
        reject: 0
      }
    };
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.spawnChild();
  }

  spawnChild() {
    this.child = fork(this.workerPath, [], {
      stdio: ['ignore', 'ignore', 'ignore', 'ipc']
    });
    this.ready = false;

    this.child.on('message', (message) => this.handleMessage(message));
    this.child.on('error', (error) => {
      this.lastError = error || new Error('alert_worker_process_error');
    });
    this.child.on('exit', () => {
      this.resolveAllSnapshotRequests(null);
      this.child = null;
      this.ready = false;
      if (this.running) {
        this.metrics.restarts += 1;
        this.spawnChild();
      }
    });

    this.send({
      type: 'init',
      config: { telemetry: this.telemetry },
      worker: this.workerConfig
    });
  }

  send(message) {
    if (!this.child || typeof this.child.send !== 'function') return false;
    try {
      this.child.send(message);
      return true;
    } catch (error) {
      this.lastError = error;
      return false;
    }
  }

  handleMessage(message) {
    const type = message && message.type ? message.type : '';
    if (type === 'ready') {
      this.ready = true;
      this.flushPending();
      return;
    }
    if (type === 'dead_letter' && this.onDeadLetter) {
      this.onDeadLetter(message.entry);
      return;
    }
    if (type === 'snapshot') {
      this.lastSnapshot = message.snapshot || null;
      const requestId = message.requestId || null;
      if (requestId && this.pendingSnapshotRequests.has(requestId)) {
        const resolver = this.pendingSnapshotRequests.get(requestId);
        this.pendingSnapshotRequests.delete(requestId);
        resolver(this.lastSnapshot);
      }
    }
  }

  pushPending(item) {
    this.pending.push(item);
    this.pendingBytes += Number(item && item.sizeBytes ? item.sizeBytes : 0);
  }

  unshiftPending(item) {
    this.pending.unshift(item);
    this.pendingBytes += Number(item && item.sizeBytes ? item.sizeBytes : 0);
  }

  shiftPending() {
    if (this.pending.length === 0) return null;
    const item = this.pending.shift();
    this.pendingBytes -= Number(item && item.sizeBytes ? item.sizeBytes : 0);
    if (this.pendingBytes < 0) this.pendingBytes = 0;
    return item;
  }

  removePendingAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.pending.length) return null;
    const [item] = this.pending.splice(index, 1);
    this.pendingBytes -= Number(item && item.sizeBytes ? item.sizeBytes : 0);
    if (this.pendingBytes < 0) this.pendingBytes = 0;
    return item || null;
  }

  canBufferPending(item) {
    if (!item) return false;
    if (this.pending.length + 1 > this.pendingMaxEvents) return false;
    if (this.pendingBytes + Number(item.sizeBytes || 0) > this.pendingMaxBytes) return false;
    return true;
  }

  trackDrop(policyName) {
    this.metrics.dropped += 1;
    if (!Object.prototype.hasOwnProperty.call(this.metrics.droppedByPolicy, policyName)) {
      this.metrics.droppedByPolicy[policyName] = 0;
    }
    this.metrics.droppedByPolicy[policyName] += 1;
  }

  createPendingItem(record) {
    return {
      record,
      sizeBytes: estimateRecordBytes(record),
      severityRank: getSeverityRank(record),
      enqueuedAt: Date.now()
    };
  }

  enforcePendingCapacity(item) {
    if (this.canBufferPending(item)) return { accepted: true };

    if (this.pendingDropPolicy === 'reject') {
      this.trackDrop('reject');
      return { accepted: false, reason: 'queue_full' };
    }

    if (this.pendingDropPolicy === 'drop_low_severity') {
      while (!this.canBufferPending(item) && this.pending.length > 0) {
        let candidateIndex = -1;
        let lowestRank = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this.pending.length; i += 1) {
          const rank = Number(this.pending[i] && this.pending[i].severityRank ? this.pending[i].severityRank : SEVERITY_RANK.ERROR);
          if (rank >= SEVERITY_RANK.FATAL) continue;
          if (rank < lowestRank) {
            lowestRank = rank;
            candidateIndex = i;
          }
        }
        if (candidateIndex < 0) break;
        if (this.removePendingAt(candidateIndex)) {
          this.trackDrop('drop_low_severity');
        } else {
          break;
        }
      }
      if (this.canBufferPending(item)) return { accepted: true };
      this.trackDrop('drop_low_severity');
      return { accepted: false, reason: 'queue_full' };
    }

    while (!this.canBufferPending(item) && this.pending.length > 0) {
      const candidateIndex = this.pending.findIndex((entry) => Number(entry && entry.severityRank ? entry.severityRank : 0) < SEVERITY_RANK.FATAL);
      if (candidateIndex < 0) break;
      if (this.removePendingAt(candidateIndex)) {
        this.trackDrop('drop_oldest_non_fatal');
      } else {
        break;
      }
    }
    if (this.canBufferPending(item)) return { accepted: true };
    this.trackDrop('drop_oldest_non_fatal');
    return { accepted: false, reason: 'queue_full' };
  }

  flushPending() {
    if (!this.ready) return;
    while (this.pending.length > 0) {
      const next = this.shiftPending();
      if (!next) continue;
      const sent = this.send({ type: 'enqueue', record: next.record });
      if (!sent) {
        this.unshiftPending(next);
        break;
      }
    }
  }

  enqueue(record) {
    if (!record || typeof record !== 'object') return { enqueued: false, reason: 'invalid_record' };
    this.metrics.enqueued += 1;
    if (!this.running) {
      this.trackDrop('reject');
      return { enqueued: false, reason: 'worker_stopped' };
    }

    if (!this.ready) {
      const item = this.createPendingItem(record);
      const capacity = this.enforcePendingCapacity(item);
      if (!capacity.accepted) {
        return { enqueued: false, reason: capacity.reason, queueSize: this.pending.length };
      }
      this.pushPending(item);
      return { enqueued: true, queueSize: this.pending.length, reason: 'buffered_until_ready' };
    }

    const sent = this.send({ type: 'enqueue', record });
    if (!sent) {
      this.trackDrop('reject');
      return { enqueued: false, reason: 'ipc_send_failed' };
    }
    return { enqueued: true, queueSize: this.pending.length };
  }

  setTelemetryOptions(telemetry = {}) {
    this.telemetry = { ...this.telemetry, ...(telemetry || {}) };
    this.send({ type: 'set_telemetry', telemetry: this.telemetry });
  }

  async requestSnapshot() {
    if (!this.running || !this.ready || !this.child) return this.lastSnapshot;
    const requestId = `snap-${Date.now()}-${++this.requestSeq}`;
    const timeoutMs = Math.max(50, this.snapshotRequestTimeoutMs);
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pendingSnapshotRequests.delete(requestId);
        resolve(this.lastSnapshot);
      }, timeoutMs);
      this.pendingSnapshotRequests.set(requestId, (snapshot) => {
        clearTimeout(timer);
        resolve(snapshot);
      });
      this.send({ type: 'snapshot_request', requestId });
    });
  }

  resolveAllSnapshotRequests(snapshot) {
    for (const resolver of this.pendingSnapshotRequests.values()) {
      try {
        resolver(snapshot);
      } catch (_error) {
        // ignore resolver errors
      }
    }
    this.pendingSnapshotRequests.clear();
  }

  async stop() {
    this.running = false;
    this.ready = false;
    this.pending = [];
    this.pendingBytes = 0;
    if (!this.child) return;
    this.send({ type: 'shutdown' });
    const childRef = this.child;
    await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        try {
          childRef.kill('SIGKILL');
        } catch (_error) {
          // ignore kill failures
        }
        resolve();
      }, 1000);
      childRef.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
  }

  getSnapshot() {
    const snapshot = this.lastSnapshot || {};
    return {
      mode: 'process',
      running: this.running,
      ready: this.ready,
      childConnected: Boolean(this.child && this.child.connected),
      pendingQueueSize: this.pending.length,
      pendingQueueBytes: this.pendingBytes,
      pendingMaxEvents: this.pendingMaxEvents,
      pendingMaxBytes: this.pendingMaxBytes,
      pendingDropPolicy: this.pendingDropPolicy,
      metrics: {
        ...this.metrics,
        worker: snapshot.metrics || null
      },
      rates: snapshot.rates || null,
      deadLetterSize: Number(snapshot.deadLetterSize || 0),
      queueSize: Number(snapshot.queueSize || 0),
      queueBytes: Number(snapshot.queueBytes || 0),
      queueMaxEvents: Number(snapshot.queueMaxEvents || this.workerConfig.queueMaxEvents),
      queueMaxBytes: Number(snapshot.queueMaxBytes || this.workerConfig.queueMaxBytes),
      queueDropPolicy: snapshot.queueDropPolicy || this.workerConfig.queueDropPolicy,
      circuit: snapshot.circuit || null,
      lastError: this.lastError ? {
        name: this.lastError.name || 'Error',
        message: this.lastError.message || String(this.lastError)
      } : null
    };
  }
}

module.exports = { ProcessAlertWorker };

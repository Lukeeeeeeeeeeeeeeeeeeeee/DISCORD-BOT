function asPositiveInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}

function asBoundedFloat(value, fallback, min, max) {
  const parsed = Number.parseFloat(value);
  if (!Number.isFinite(parsed)) return fallback;
  return Math.min(max, Math.max(min, parsed));
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

class AlertWorker {
  constructor(options = {}) {
    this.sendFn = typeof options.sendFn === 'function' ? options.sendFn : async () => ({ sent: false, reason: 'noop' });
    this.onDeadLetter = typeof options.onDeadLetter === 'function' ? options.onDeadLetter : null;

    this.maxRetries = asPositiveInt(options.maxRetries, 3);
    this.baseDelayMs = asPositiveInt(options.baseDelayMs, 500);
    this.maxDelayMs = asPositiveInt(options.maxDelayMs, 30000);
    this.deadLetterLimit = asPositiveInt(options.deadLetterLimit, 500);
    this.queueMaxEvents = asPositiveInt(options.queueMaxEvents, 2000);
    this.queueMaxBytes = asPositiveInt(options.queueMaxBytes, 4 * 1024 * 1024);
    this.queueDropPolicy = String(options.queueDropPolicy || 'drop_oldest_non_fatal').toLowerCase();
    this.retryJitterRatio = asBoundedFloat(options.retryJitterRatio, 0.2, 0, 1);
    this.delayRandFn = typeof options.delayRandFn === 'function' ? options.delayRandFn : Math.random;
    this.circuitFailureThreshold = asPositiveInt(options.circuitFailureThreshold, 5);
    this.circuitOpenMs = asPositiveInt(options.circuitOpenMs, 15000);
    this.circuitSuccessThreshold = asPositiveInt(options.circuitSuccessThreshold, 2);

    this.queue = [];
    this.queueBytes = 0;
    this.deadLetters = [];
    this.metrics = {
      enqueued: 0,
      dropped: 0,
      droppedBytes: 0,
      sent: 0,
      retried: 0,
      failed: 0,
      deadLettered: 0,
      circuitOpened: 0,
      circuitSkipped: 0,
      droppedByPolicy: {
        drop_oldest_non_fatal: 0,
        drop_low_severity: 0,
        reject: 0
      }
    };
    this.circuit = {
      state: 'closed',
      openedAt: 0,
      consecutiveFailures: 0,
      halfOpenSuccesses: 0
    };

    this.running = false;
    this.processing = false;
    this.pumpTimer = null;
  }

  setSendFn(fn) {
    if (typeof fn === 'function') {
      this.sendFn = fn;
    }
  }

  start() {
    if (this.running) return;
    this.running = true;
    this.schedulePump(0);
  }

  async stop() {
    this.running = false;
    if (this.pumpTimer) {
      clearTimeout(this.pumpTimer);
      this.pumpTimer = null;
    }

    while (this.processing) {
      // Wait for in-flight send to finish before stopping.
      // eslint-disable-next-line no-await-in-loop
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }

  createQueueItem(record, overrides = {}) {
    const sizeBytes = estimateRecordBytes(record);
    return {
      record,
      attempts: Number(overrides.attempts || 0),
      enqueuedAt: Number(overrides.enqueuedAt || Date.now()),
      nextAttemptAt: Number(overrides.nextAttemptAt || Date.now()),
      sizeBytes,
      severityRank: getSeverityRank(record)
    };
  }

  pushItem(item) {
    this.queue.push(item);
    this.queueBytes += Number(item && item.sizeBytes ? item.sizeBytes : 0);
  }

  shiftItem() {
    if (this.queue.length === 0) return null;
    const item = this.queue.shift();
    this.queueBytes -= Number(item && item.sizeBytes ? item.sizeBytes : 0);
    if (this.queueBytes < 0) this.queueBytes = 0;
    return item;
  }

  removeItemAt(index) {
    if (!Number.isInteger(index) || index < 0 || index >= this.queue.length) return null;
    const [item] = this.queue.splice(index, 1);
    this.queueBytes -= Number(item && item.sizeBytes ? item.sizeBytes : 0);
    if (this.queueBytes < 0) this.queueBytes = 0;
    return item || null;
  }

  canQueue(item) {
    if (!item) return false;
    if (this.queue.length + 1 > this.queueMaxEvents) return false;
    if (this.queueBytes + Number(item.sizeBytes || 0) > this.queueMaxBytes) return false;
    return true;
  }

  trackDrop(item, policyName) {
    this.metrics.dropped += 1;
    this.metrics.droppedBytes += Number(item && item.sizeBytes ? item.sizeBytes : 0);
    if (!Object.prototype.hasOwnProperty.call(this.metrics.droppedByPolicy, policyName)) {
      this.metrics.droppedByPolicy[policyName] = 0;
    }
    this.metrics.droppedByPolicy[policyName] += 1;
  }

  dropExistingItem(index, policyName) {
    const removed = this.removeItemAt(index);
    if (!removed) return false;
    this.trackDrop(removed, policyName);
    return true;
  }

  enforceQueueCapacity(item) {
    if (this.canQueue(item)) return { accepted: true };

    if (this.queueDropPolicy === 'reject') {
      this.trackDrop(item, 'reject');
      return { accepted: false, reason: 'queue_full' };
    }

    if (this.queueDropPolicy === 'drop_low_severity') {
      while (!this.canQueue(item) && this.queue.length > 0) {
        let candidateIndex = -1;
        let lowestRank = Number.POSITIVE_INFINITY;
        for (let i = 0; i < this.queue.length; i += 1) {
          const rank = Number(this.queue[i] && this.queue[i].severityRank ? this.queue[i].severityRank : SEVERITY_RANK.ERROR);
          if (rank >= SEVERITY_RANK.FATAL) continue;
          if (rank < lowestRank) {
            lowestRank = rank;
            candidateIndex = i;
          }
        }
        if (candidateIndex < 0) break;
        if (!this.dropExistingItem(candidateIndex, 'drop_low_severity')) break;
      }
      if (this.canQueue(item)) return { accepted: true };
      this.trackDrop(item, 'drop_low_severity');
      return { accepted: false, reason: 'queue_full' };
    }

    while (!this.canQueue(item) && this.queue.length > 0) {
      const candidateIndex = this.queue.findIndex((entry) => Number(entry && entry.severityRank ? entry.severityRank : 0) < SEVERITY_RANK.FATAL);
      if (candidateIndex < 0) break;
      if (!this.dropExistingItem(candidateIndex, 'drop_oldest_non_fatal')) break;
    }
    if (this.canQueue(item)) return { accepted: true };
    this.trackDrop(item, 'drop_oldest_non_fatal');
    return { accepted: false, reason: 'queue_full' };
  }

  enqueuePrepared(item) {
    const capacity = this.enforceQueueCapacity(item);
    if (!capacity.accepted) {
      return { enqueued: false, reason: capacity.reason, queueSize: this.queue.length };
    }
    this.pushItem(item);
    this.schedulePump(0);
    return { enqueued: true, queueSize: this.queue.length };
  }

  enqueue(record) {
    if (!record || typeof record !== 'object') return { enqueued: false, reason: 'invalid_record' };
    const item = this.createQueueItem(record);
    const result = this.enqueuePrepared(item);
    if (!result.enqueued) return result;
    this.metrics.enqueued += 1;
    return result;
  }

  computeDelayMs(attempts) {
    const exponent = Math.max(0, Number(attempts || 0) - 1);
    const raw = this.baseDelayMs * (2 ** exponent);
    const bounded = Math.min(this.maxDelayMs, Math.max(this.baseDelayMs, raw));
    if (this.retryJitterRatio <= 0) return bounded;
    const randomRaw = Number(this.delayRandFn());
    const random = Number.isFinite(randomRaw) ? randomRaw : 0.5;
    const normalized = Math.max(0, Math.min(1, random));
    const jitter = ((normalized * 2) - 1) * this.retryJitterRatio;
    const value = bounded * (1 + jitter);
    return Math.max(this.baseDelayMs, Math.min(this.maxDelayMs, Math.round(value)));
  }

  getCircuitState(now = Date.now()) {
    if (this.circuit.state === 'open') {
      const elapsed = now - this.circuit.openedAt;
      if (elapsed >= this.circuitOpenMs) {
        this.circuit.state = 'half_open';
        this.circuit.halfOpenSuccesses = 0;
      }
    }
    return this.circuit.state;
  }

  registerCircuitSuccess() {
    if (this.circuit.state === 'half_open') {
      this.circuit.halfOpenSuccesses += 1;
      if (this.circuit.halfOpenSuccesses >= this.circuitSuccessThreshold) {
        this.circuit.state = 'closed';
        this.circuit.openedAt = 0;
        this.circuit.consecutiveFailures = 0;
        this.circuit.halfOpenSuccesses = 0;
      }
      return;
    }
    this.circuit.consecutiveFailures = 0;
  }

  registerCircuitFailure(now = Date.now()) {
    if (this.circuit.state === 'half_open') {
      this.circuit.state = 'open';
      this.circuit.openedAt = now;
      this.circuit.halfOpenSuccesses = 0;
      this.circuit.consecutiveFailures = this.circuitFailureThreshold;
      this.metrics.circuitOpened += 1;
      return;
    }

    this.circuit.consecutiveFailures += 1;
    if (this.circuit.consecutiveFailures >= this.circuitFailureThreshold) {
      this.circuit.state = 'open';
      this.circuit.openedAt = now;
      this.circuit.halfOpenSuccesses = 0;
      this.metrics.circuitOpened += 1;
    }
  }

  getCircuitWaitMs(now = Date.now()) {
    if (this.circuit.state !== 'open') return 0;
    const remaining = (this.circuit.openedAt + this.circuitOpenMs) - now;
    return Math.max(0, remaining);
  }

  schedulePump(delayMs) {
    if (!this.running) return;
    if (this.pumpTimer) return;

    const delay = Math.max(0, Number(delayMs || 0));
    this.pumpTimer = setTimeout(() => {
      this.pumpTimer = null;
      this.pump().catch((error) => {
        console.error('AECS alert worker pump failure:', error);
      });
    }, delay);
    if (typeof this.pumpTimer.unref === 'function') this.pumpTimer.unref();
  }

  async pump() {
    if (!this.running || this.processing) return;
    this.processing = true;

    try {
      while (this.running && this.queue.length > 0) {
        const item = this.queue[0];
        const now = Date.now();
        if (!item || item.nextAttemptAt > now) {
          const waitMs = item ? Math.max(5, item.nextAttemptAt - now) : 25;
          this.schedulePump(waitMs);
          break;
        }

        const circuitState = this.getCircuitState(now);
        if (circuitState === 'open') {
          const waitMs = this.getCircuitWaitMs(now);
          item.nextAttemptAt = now + Math.max(5, waitMs);
          this.metrics.circuitSkipped += 1;
          this.schedulePump(waitMs);
          break;
        }

        const dequeued = this.shiftItem();
        if (!dequeued) continue;

        try {
          await this.sendFn(dequeued.record);
          this.metrics.sent += 1;
          this.registerCircuitSuccess();
        } catch (error) {
          this.metrics.failed += 1;
          this.registerCircuitFailure();

          if (dequeued.attempts < this.maxRetries) {
            const nextAttempts = dequeued.attempts + 1;
            const delayMs = this.computeDelayMs(nextAttempts);
            this.metrics.retried += 1;

            const waitMs = this.getCircuitWaitMs();
            const retryItem = this.createQueueItem(dequeued.record, {
              ...dequeued,
              attempts: nextAttempts,
              nextAttemptAt: Date.now() + Math.max(delayMs, waitMs)
            });
            const retryResult = this.enqueuePrepared(retryItem);
            if (retryResult.enqueued) {
              continue;
            }

            const queueError = new Error(`retry_queue_${retryResult.reason || 'full'}`);
            queueError.code = 'ALERT_RETRY_QUEUE_FULL';
            const deadLetter = {
              failedAt: Date.now(),
              attempts: retryItem.attempts,
              error: {
                name: queueError.name,
                message: queueError.message
              },
              record: retryItem.record
            };
            this.metrics.deadLettered += 1;
            this.deadLetters.push(deadLetter);
            if (this.deadLetters.length > this.deadLetterLimit) {
              this.deadLetters.shift();
            }
            if (this.onDeadLetter) {
              try {
                await this.onDeadLetter(deadLetter);
              } catch (sinkError) {
                console.error('AECS alert worker dead-letter sink failed:', sinkError);
              }
            }
            continue;
          }

          const deadLetter = {
            failedAt: Date.now(),
            attempts: dequeued.attempts,
            error: {
              name: error && error.name ? error.name : 'Error',
              message: error && error.message ? error.message : String(error)
            },
            record: dequeued.record
          };
          this.metrics.deadLettered += 1;
          this.deadLetters.push(deadLetter);
          if (this.deadLetters.length > this.deadLetterLimit) {
            this.deadLetters.shift();
          }
          if (this.onDeadLetter) {
            try {
              await this.onDeadLetter(deadLetter);
            } catch (sinkError) {
              console.error('AECS alert worker dead-letter sink failed:', sinkError);
            }
          }
        }
      }
    } finally {
      this.processing = false;
      if (this.running && this.queue.length > 0) {
        this.schedulePump(0);
      }
    }
  }

  getSnapshot() {
    const metrics = { ...this.metrics };
    const attempts = metrics.sent + metrics.failed;
    return {
      running: this.running,
      processing: this.processing,
      queueSize: this.queue.length,
      queueBytes: this.queueBytes,
      queueMaxEvents: this.queueMaxEvents,
      queueMaxBytes: this.queueMaxBytes,
      queueDropPolicy: this.queueDropPolicy,
      deadLetterSize: this.deadLetters.length,
      maxRetries: this.maxRetries,
      baseDelayMs: this.baseDelayMs,
      maxDelayMs: this.maxDelayMs,
      retryJitterRatio: this.retryJitterRatio,
      circuit: {
        state: this.getCircuitState(),
        openedAt: this.circuit.openedAt || 0,
        consecutiveFailures: this.circuit.consecutiveFailures,
        halfOpenSuccesses: this.circuit.halfOpenSuccesses,
        failureThreshold: this.circuitFailureThreshold,
        openMs: this.circuitOpenMs,
        successThreshold: this.circuitSuccessThreshold
      },
      metrics,
      rates: {
        deliverySuccessRate: attempts > 0 ? metrics.sent / attempts : 0,
        retryRate: attempts > 0 ? metrics.retried / attempts : 0,
        deadLetterRate: metrics.failed > 0 ? metrics.deadLettered / metrics.failed : 0,
        droppedRate: metrics.enqueued > 0 ? metrics.dropped / metrics.enqueued : 0
      }
    };
  }
}

module.exports = { AlertWorker };

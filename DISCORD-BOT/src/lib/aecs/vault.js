const fs = require('fs');
const path = require('path');

function toDateKey(timestamp) {
  const date = new Date(Number(timestamp || Date.now()));
  return date.toISOString().slice(0, 10);
}

function ensureDir(dirPath) {
  fs.mkdirSync(dirPath, { recursive: true });
}

function makeIdxEntry(timestamp, hashId, offset) {
  const entry = Buffer.allocUnsafe(16);
  entry.writeBigUInt64BE(BigInt(Math.max(0, Number(timestamp || 0))), 0);
  entry.writeUInt32BE((Number(hashId) >>> 0), 8);
  entry.writeUInt32BE((Number(offset) >>> 0), 12);
  return entry;
}

class AecsVault {
  constructor(options = {}) {
    this.logDir = path.resolve(options.logDir || path.join(process.cwd(), 'data', 'aecs'));
    this.flushIntervalMs = Number.parseInt(options.flushIntervalMs || '2000', 10);
    this.maxBufferSize = Number.isFinite(options.maxBufferSize) ? options.maxBufferSize : 10000;
    this.buffer = [];
    this.timer = null;
    this.isFlushing = false;

    this.currentDateKey = null;
    this.currentJsonlPath = null;
    this.currentIdxPath = null;
    this.currentOffset = 0;
    this.logStream = null;
    this.idxStream = null;
    this.persistenceDisabled = false;
    this.persistenceError = null;
    this.persistenceDisabledAt = null;
    this.droppedRecords = 0;

    this.metricBuckets = new Map();
  }

  start() {
    if (!this.ensurePersistenceReady()) return;
    if (this.timer) return;
    this.timer = setInterval(() => {
      this.flush().catch((error) => {
        console.error('AECS vault flush failed:', error);
      });
    }, this.flushIntervalMs);
    if (typeof this.timer.unref === 'function') this.timer.unref();
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    await this.flush();
    await this.closeStreams();
  }

  async closeStreams() {
    const closes = [];
    if (this.logStream) {
      closes.push(new Promise((resolve) => {
        this.logStream.end(() => resolve());
      }));
      this.logStream = null;
    }
    if (this.idxStream) {
      closes.push(new Promise((resolve) => {
        this.idxStream.end(() => resolve());
      }));
      this.idxStream = null;
    }
    this.currentDateKey = null;
    this.currentJsonlPath = null;
    this.currentIdxPath = null;
    this.currentOffset = 0;
    if (closes.length) {
      await Promise.all(closes);
    }
  }

  queue(record) {
    if (!record || typeof record !== 'object') return;

    if (this.buffer.length >= this.maxBufferSize) {
      this.buffer.shift();
      this.droppedRecords += 1;
      if (this.droppedRecords === 1 || this.droppedRecords % 100 === 0) {
        console.error('[AECS] Vault buffer full; dropping oldest record (total dropped:', this.droppedRecords + ')');
      }
    }

    this.buffer.push(record);
    this.updateMetrics(record);
  }

  updateMetrics(record) {
    const timestamp = Number(record.timestamp || Date.now());
    const minuteKey = Math.floor(timestamp / 60000);
    const severity = String(record.severity || 'ERROR').toUpperCase();
    const impact = Number(record.impact || 0);

    if (!this.metricBuckets.has(minuteKey)) {
      this.metricBuckets.set(minuteKey, {
        minuteKey,
        errors: 0,
        impact: 0,
        bySeverity: {
          INFO: 0,
          WARN: 0,
          ERROR: 0,
          FATAL: 0
        }
      });
    }

    const bucket = this.metricBuckets.get(minuteKey);
    bucket.errors += 1;
    bucket.impact += Number.isFinite(impact) ? impact : 0;
    if (Object.prototype.hasOwnProperty.call(bucket.bySeverity, severity)) {
      bucket.bySeverity[severity] += 1;
    } else {
      bucket.bySeverity.ERROR += 1;
    }

    const oldestAllowed = minuteKey - 59;
    for (const key of this.metricBuckets.keys()) {
      if (key < oldestAllowed) this.metricBuckets.delete(key);
    }
  }

  getMetricsSnapshot() {
    const now = Date.now();
    const nowMinute = Math.floor(now / 60000);
    const oldestAllowed = nowMinute - 59;

    let totalErrors = 0;
    let totalImpact = 0;
    const bySeverity = { INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 };

    for (const [minuteKey, bucket] of this.metricBuckets.entries()) {
      if (minuteKey < oldestAllowed) continue;
      totalErrors += bucket.errors;
      totalImpact += bucket.impact;
      bySeverity.INFO += bucket.bySeverity.INFO;
      bySeverity.WARN += bucket.bySeverity.WARN;
      bySeverity.ERROR += bucket.bySeverity.ERROR;
      bySeverity.FATAL += bucket.bySeverity.FATAL;
    }

    const latest = this.metricBuckets.get(nowMinute) || {
      errors: 0,
      impact: 0,
      bySeverity: { INFO: 0, WARN: 0, ERROR: 0, FATAL: 0 }
    };

    return {
      timestamp: now,
      windowMinutes: 60,
      totalErrors,
      totalImpact,
      bySeverity,
      latestMinute: {
        minuteEpoch: nowMinute * 60000,
        errors: latest.errors,
        impact: latest.impact,
        bySeverity: latest.bySeverity
      },
      logDir: this.logDir,
      currentLogFile: this.currentJsonlPath,
      currentIdxFile: this.currentIdxPath,
      queued: this.buffer.length,
      maxBufferSize: this.maxBufferSize,
      persistenceDisabled: this.persistenceDisabled,
      persistenceError: this.persistenceError,
      persistenceDisabledAt: this.persistenceDisabledAt,
      droppedRecords: this.droppedRecords
    };
  }

  ensurePersistenceReady() {
    if (this.persistenceDisabled) return false;
    try {
      ensureDir(this.logDir);
      return true;
    } catch (error) {
      this.disablePersistence(error, 'mkdir');
      return false;
    }
  }

  formatError(error) {
    if (!error) return null;
    if (error instanceof Error) {
      return {
        name: error.name,
        code: error.code || null,
        message: error.message || String(error)
      };
    }
    return {
      name: null,
      code: error && error.code ? error.code : null,
      message: String(error)
    };
  }

  disablePersistence(error, phase = 'runtime') {
    if (this.persistenceDisabled) return;
    this.persistenceDisabled = true;
    this.persistenceDisabledAt = Date.now();
    this.persistenceError = {
      phase,
      ...this.formatError(error)
    };

    const streams = [this.logStream, this.idxStream].filter(Boolean);
    this.logStream = null;
    this.idxStream = null;
    for (const stream of streams) {
      try {
        stream.destroy();
      } catch (_error) {
        // ignored
      }
    }

    const code = error && error.code ? String(error.code) : 'UNKNOWN';
    const message = error && error.message ? String(error.message) : String(error || 'Unknown AECS vault error');
    console.error(`AECS vault persistence disabled (${phase}): ${code} ${message}`);
  }

  handleStreamError(error, streamType) {
    this.disablePersistence(error, `stream:${streamType}`);
  }

  ensureOpenForDate(dateKey) {
    if (!this.ensurePersistenceReady()) return;
    if (this.currentDateKey === dateKey && this.logStream && this.idxStream) {
      return;
    }

    if (this.logStream) {
      this.logStream.end();
      this.logStream = null;
    }
    if (this.idxStream) {
      this.idxStream.end();
      this.idxStream = null;
    }

    this.currentDateKey = dateKey;
    this.currentJsonlPath = path.join(this.logDir, `aecs-${dateKey}.jsonl`);
    this.currentIdxPath = path.join(this.logDir, `aecs-${dateKey}.idx`);

    try {
      const stat = fs.statSync(this.currentJsonlPath);
      this.currentOffset = Number(stat.size || 0);
    } catch (_error) {
      this.currentOffset = 0;
    }

    this.logStream = fs.createWriteStream(this.currentJsonlPath, { flags: 'a' });
    this.idxStream = fs.createWriteStream(this.currentIdxPath, { flags: 'a' });
    this.logStream.on('error', (error) => this.handleStreamError(error, 'jsonl'));
    this.idxStream.on('error', (error) => this.handleStreamError(error, 'idx'));
  }

  async flush() {
    if (this.isFlushing) return;
    if (this.buffer.length === 0) return;
    if (this.persistenceDisabled) {
      this.droppedRecords += this.buffer.length;
      this.buffer.length = 0;
      return;
    }

    this.isFlushing = true;
    try {
      const records = this.buffer.splice(0, this.buffer.length);
      for (const record of records) {
        const timestamp = Number(record.timestamp || Date.now());
        const dateKey = toDateKey(timestamp);
        this.ensureOpenForDate(dateKey);
        if (this.persistenceDisabled || !this.logStream || !this.idxStream) {
          this.droppedRecords += 1;
          continue;
        }

        const line = `${JSON.stringify(record)}\n`;
        const lineBuffer = Buffer.from(line, 'utf8');
        const startOffset = this.currentOffset;
        this.currentOffset += lineBuffer.length;

        if (this.logStream) this.logStream.write(lineBuffer);

        const idxEntry = makeIdxEntry(timestamp, Number(record.hashId || 0), startOffset);
        if (this.idxStream) this.idxStream.write(idxEntry);
      }
    } finally {
      this.isFlushing = false;
    }
  }

  forceWriteSync(record) {
    if (!record || typeof record !== 'object') return;
    if (!this.ensurePersistenceReady()) {
      this.droppedRecords += 1;
      return;
    }

    // FIX (BUG-01): Close async streams before sync write to prevent interleaving
    if (this.isFlushing || this.logStream || this.idxStream) {
      if (this.logStream) { this.logStream.destroy(); this.logStream = null; }
      if (this.idxStream) { this.idxStream.destroy(); this.idxStream = null; }
      this.currentDateKey = null;
      this.currentJsonlPath = null;
      this.currentIdxPath = null;
      this.currentOffset = 0;
    }

    const timestamp = Number(record.timestamp || Date.now());
    const dateKey = toDateKey(timestamp);
    const jsonlPath = path.join(this.logDir, `aecs-${dateKey}.jsonl`);
    const idxPath = path.join(this.logDir, `aecs-${dateKey}.idx`);
    const lineBuffer = Buffer.from(`${JSON.stringify(record)}\n`, 'utf8');

    let startOffset = 0;
    try {
      startOffset = Number(fs.statSync(jsonlPath).size || 0);
    } catch (_error) {
      startOffset = 0;
    }

    try {
      fs.appendFileSync(jsonlPath, lineBuffer);
      fs.appendFileSync(idxPath, makeIdxEntry(timestamp, Number(record.hashId || 0), startOffset));
    } catch (error) {
      this.droppedRecords += 1;
      this.disablePersistence(error, 'forceWriteSync');
    }
  }

  listLogFiles() {
    ensureDir(this.logDir);
    const names = fs.readdirSync(this.logDir);
    return names
      .filter((name) => name.startsWith('aecs-') && name.endsWith('.jsonl'))
      .sort()
      .map((name) => path.join(this.logDir, name));
  }

  cleanupOldFiles(maxAgeDays = 90) {
    if (!this.ensurePersistenceReady()) return 0;
    const cutoffMs = Date.now() - (Number(maxAgeDays) * 24 * 60 * 60 * 1000);
    const names = fs.readdirSync(this.logDir);
    let removed = 0;
    for (const name of names) {
      if (!name.startsWith('aecs-')) continue;
      const fullPath = path.join(this.logDir, name);
      try {
        const stat = fs.statSync(fullPath);
        if (stat.mtimeMs <= cutoffMs) {
          fs.unlinkSync(fullPath);
          removed += 1;
        }
      } catch (_error) {
        // skip files we can't stat or remove
      }
    }
    return removed;
  }
}

module.exports = AecsVault;

const { AlertWorker } = require('./AlertWorker');
const { TelemetryAdapter } = require('./telemetry-adapter');

function buildTelemetryAdapter(options = {}) {
  return new TelemetryAdapter({
    defaultWebhookUrl: options.telemetryWebhookUrl || '',
    fatalWebhookUrl: options.telemetryFatalWebhookUrl || '',
    highImpactWebhookUrl: options.telemetryHighImpactWebhookUrl || '',
    channelId: options.telemetryChannelId || '',
    supportLookupTemplate: options.supportLookupTemplate || '',
    impactThreshold: options.webhookImpactThreshold || '90',
    timeoutMs: options.telemetryTimeoutMs || '5000'
  });
}

let telemetryAdapter = buildTelemetryAdapter({});
let worker = new AlertWorker({
  sendFn: (record) => telemetryAdapter.send(record),
  maxRetries: 3,
  baseDelayMs: 500,
  maxDelayMs: 30000,
  deadLetterLimit: 500,
  onDeadLetter: (entry) => {
    if (typeof process.send === 'function') {
      process.send({ type: 'dead_letter', entry });
    }
  }
});

function applyConfig(config = {}) {
  telemetryAdapter = buildTelemetryAdapter(config.telemetry || {});
  if (worker && typeof worker.setSendFn === 'function') {
    worker.setSendFn((record) => telemetryAdapter.send(record));
  }
}

function restartWorker(workerOptions = {}) {
  const nextWorker = new AlertWorker({
    sendFn: (record) => telemetryAdapter.send(record),
    maxRetries: Number.parseInt(workerOptions.maxRetries || '3', 10),
    baseDelayMs: Number.parseInt(workerOptions.baseDelayMs || '500', 10),
    maxDelayMs: Number.parseInt(workerOptions.maxDelayMs || '30000', 10),
    deadLetterLimit: Number.parseInt(workerOptions.deadLetterLimit || '500', 10),
    queueMaxEvents: Number.parseInt(workerOptions.queueMaxEvents || '2000', 10),
    queueMaxBytes: Number.parseInt(workerOptions.queueMaxBytes || String(4 * 1024 * 1024), 10),
    queueDropPolicy: String(workerOptions.queueDropPolicy || 'drop_oldest_non_fatal').toLowerCase(),
    retryJitterRatio: Number(workerOptions.retryJitterRatio || 0.2),
    circuitFailureThreshold: Number.parseInt(workerOptions.circuitFailureThreshold || '5', 10),
    circuitOpenMs: Number.parseInt(workerOptions.circuitOpenMs || '15000', 10),
    circuitSuccessThreshold: Number.parseInt(workerOptions.circuitSuccessThreshold || '2', 10),
    onDeadLetter: (entry) => {
      if (typeof process.send === 'function') {
        process.send({ type: 'dead_letter', entry });
      }
    }
  });

  if (worker && typeof worker.stop === 'function') {
    worker.stop().catch(() => {});
  }
  worker = nextWorker;
  worker.start();
}

function sendSnapshot(requestId) {
  if (typeof process.send !== 'function') return;
  process.send({
    type: 'snapshot',
    requestId: requestId || null,
    snapshot: {
      ...(worker && typeof worker.getSnapshot === 'function' ? worker.getSnapshot() : {}),
      mode: 'process'
    }
  });
}

process.on('message', async (message) => {
  const type = message && message.type ? message.type : '';
  if (type === 'init') {
    applyConfig(message.config || {});
    restartWorker(message.worker || {});
    if (typeof process.send === 'function') {
      process.send({ type: 'ready' });
    }
    return;
  }
  if (type === 'enqueue') {
    if (worker && typeof worker.enqueue === 'function') {
      worker.enqueue(message.record);
    }
    return;
  }
  if (type === 'set_telemetry') {
    applyConfig({ telemetry: message.telemetry || {} });
    return;
  }
  if (type === 'snapshot_request') {
    sendSnapshot(message.requestId);
    return;
  }
  if (type === 'shutdown') {
    try {
      if (worker && typeof worker.stop === 'function') {
        await worker.stop();
      }
    } finally {
      process.exit(0);
    }
  }
});

if (typeof process.send === 'function') {
  process.send({ type: 'boot' });
}

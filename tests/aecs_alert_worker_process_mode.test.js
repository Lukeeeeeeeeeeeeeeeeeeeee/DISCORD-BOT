const fs = require('fs');
const os = require('os');
const path = require('path');

const { AECS, CodexError } = require('../src/lib/aecs');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AECS process alert worker mode', () => {
  let logDir;

  beforeEach(async () => {
    logDir = path.join(os.tmpdir(), `aecs-alert-process-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    await AECS.reinitialize({
      logDir,
      flushIntervalMs: 20,
      suppressionThreshold: 1000,
      suppressionWindowMs: 60000,
      alertThreshold: 1000,
      telemetryWebhookUrl: '',
      telemetryFatalWebhookUrl: '',
      telemetryHighImpactWebhookUrl: '',
      alertWorkerMode: 'process',
      alertWorkerProcessPath: path.join(process.cwd(), 'src', 'lib', 'aecs', 'alert-worker-process.js'),
      alertWorkerBaseDelayMs: 5,
      alertWorkerMaxDelayMs: 25,
      alertWorkerMaxRetries: 1,
      alertWorkerQueueMaxEvents: 10,
      alertWorkerQueueMaxBytes: 8192,
      alertWorkerQueueDropPolicy: 'drop_oldest_non_fatal',
      alertWorkerRetryJitterRatio: 0.15,
      alertWorkerCircuitFailureThreshold: 3,
      alertWorkerCircuitOpenMs: 100,
      alertWorkerCircuitSuccessThreshold: 1,
      exitOnFatal: false
    });
  });

  afterEach(async () => {
    await AECS.shutdown();
    if (logDir && fs.existsSync(logDir)) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  test('dispatch remains non-blocking when alert worker runs in a child process', async () => {
    const startedAt = Date.now();
    const result = await AECS.dispatch(new CodexError('CMD-500', { scope: 'unit.alert.process' }), {
      scope: 'unit.alert.process'
    });
    const elapsedMs = Date.now() - startedAt;

    expect(result.alertEnqueued).toBe(true);
    expect(elapsedMs).toBeLessThan(80);

    await sleep(120);
    const snapshot = AECS.dispatcher.getAlertWorkerSnapshot();
    expect(snapshot).toBeTruthy();
    expect(snapshot.mode).toBe('process');
    expect(snapshot.running).toBe(true);
    expect(snapshot.metrics.enqueued).toBeGreaterThanOrEqual(1);
  });

  test('setTelemetryRouting keeps process worker healthy', async () => {
    const telemetryChannelId = process.env.AECS_TELEMETRY_CHANNEL_ID || '';
    AECS.setTelemetryRouting({
      telemetryChannelId,
      supportLookupTemplate: 'Search telemetry logs for {{supportId}} in {{channelId}}'
    });

    await AECS.dispatch(new CodexError('CMD-500', { scope: 'unit.alert.process.routing' }), {
      scope: 'unit.alert.process.routing'
    });
    await sleep(120);

    const snapshot = AECS.dispatcher.getAlertWorkerSnapshot();
    expect(snapshot.mode).toBe('process');
    expect(snapshot.running).toBe(true);
    expect(snapshot.childConnected).toBe(true);
    expect(snapshot.queueMaxEvents).toBe(10);
    expect(snapshot.queueMaxBytes).toBe(8192);
    expect(snapshot.queueDropPolicy).toBe('drop_oldest_non_fatal');
  });
});

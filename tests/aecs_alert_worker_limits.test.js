const { AlertWorker } = require('../src/lib/aecs/AlertWorker');

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe('AECS alert worker queue controls and circuit policy', () => {
  test('drops oldest non-fatal events when queue is full and policy allows eviction', () => {
    const worker = new AlertWorker({
      queueMaxEvents: 2,
      queueMaxBytes: 4096,
      queueDropPolicy: 'drop_oldest_non_fatal'
    });

    expect(worker.enqueue({ code: 'A', severity: 'WARN' }).enqueued).toBe(true);
    expect(worker.enqueue({ code: 'B', severity: 'ERROR' }).enqueued).toBe(true);
    expect(worker.enqueue({ code: 'C', severity: 'INFO' }).enqueued).toBe(true);

    expect(worker.queue.map((entry) => entry.record.code)).toEqual(['B', 'C']);
    const snapshot = worker.getSnapshot();
    expect(snapshot.queueSize).toBe(2);
    expect(snapshot.metrics.dropped).toBe(1);
    expect(snapshot.metrics.droppedByPolicy.drop_oldest_non_fatal).toBe(1);
  });

  test('rejects new events when queue is full and reject policy is configured', () => {
    const worker = new AlertWorker({
      queueMaxEvents: 1,
      queueMaxBytes: 4096,
      queueDropPolicy: 'reject'
    });

    expect(worker.enqueue({ code: 'A', severity: 'ERROR' }).enqueued).toBe(true);
    const result = worker.enqueue({ code: 'B', severity: 'ERROR' });

    expect(result.enqueued).toBe(false);
    expect(result.reason).toBe('queue_full');

    const snapshot = worker.getSnapshot();
    expect(snapshot.queueSize).toBe(1);
    expect(snapshot.metrics.dropped).toBe(1);
    expect(snapshot.metrics.droppedByPolicy.reject).toBe(1);
  });

  test('applies retry jitter for backoff delay', () => {
    const highJitter = new AlertWorker({
      baseDelayMs: 100,
      maxDelayMs: 500,
      retryJitterRatio: 0.5,
      delayRandFn: () => 1
    });
    const lowJitter = new AlertWorker({
      baseDelayMs: 100,
      maxDelayMs: 500,
      retryJitterRatio: 0.5,
      delayRandFn: () => 0
    });

    expect(highJitter.computeDelayMs(1)).toBe(150);
    expect(lowJitter.computeDelayMs(1)).toBe(100);
  });

  test('opens and closes circuit around repeated telemetry failures', async () => {
    let shouldFail = true;
    const sendMock = jest.fn(async () => {
      if (shouldFail) {
        throw new Error('telemetry down');
      }
      return { sent: true, reason: 'ok' };
    });

    const worker = new AlertWorker({
      sendFn: sendMock,
      maxRetries: 0,
      baseDelayMs: 5,
      maxDelayMs: 15,
      circuitFailureThreshold: 2,
      circuitOpenMs: 80,
      circuitSuccessThreshold: 1
    });

    worker.start();
    worker.enqueue({ code: 'A', severity: 'ERROR' });
    worker.enqueue({ code: 'B', severity: 'ERROR' });
    worker.enqueue({ code: 'C', severity: 'ERROR' });

    await sleep(40);
    let snapshot = worker.getSnapshot();

    expect(snapshot.circuit.state).toBe('open');
    expect(snapshot.metrics.circuitOpened).toBeGreaterThanOrEqual(1);
    expect(snapshot.metrics.circuitSkipped).toBeGreaterThanOrEqual(1);
    expect(sendMock).toHaveBeenCalledTimes(2);

    shouldFail = false;
    await sleep(140);
    snapshot = worker.getSnapshot();

    expect(snapshot.circuit.state).toBe('closed');
    expect(sendMock.mock.calls.length).toBeGreaterThanOrEqual(3);

    await worker.stop();
  });
});

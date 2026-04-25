const { ProcessAlertWorker } = require('../src/lib/aecs/ProcessAlertWorker');

describe('AECS process alert worker pending buffer controls', () => {
  test('buffers until ready and rejects when pending queue is full with reject policy', () => {
    const worker = new ProcessAlertWorker({
      pendingMaxEvents: 2,
      pendingMaxBytes: 4096,
      pendingDropPolicy: 'reject'
    });

    worker.running = true;
    worker.ready = false;

    expect(worker.enqueue({ code: 'A', severity: 'WARN' }).enqueued).toBe(true);
    expect(worker.enqueue({ code: 'B', severity: 'WARN' }).enqueued).toBe(true);

    const result = worker.enqueue({ code: 'C', severity: 'WARN' });
    expect(result.enqueued).toBe(false);
    expect(result.reason).toBe('queue_full');

    const snapshot = worker.getSnapshot();
    expect(snapshot.pendingQueueSize).toBe(2);
    expect(snapshot.metrics.dropped).toBe(1);
    expect(snapshot.metrics.droppedByPolicy.reject).toBe(1);
  });

  test('drops oldest non-fatal buffered event when pending queue is full', () => {
    const worker = new ProcessAlertWorker({
      pendingMaxEvents: 2,
      pendingMaxBytes: 4096,
      pendingDropPolicy: 'drop_oldest_non_fatal'
    });

    worker.running = true;
    worker.ready = false;

    expect(worker.enqueue({ code: 'A', severity: 'WARN' }).enqueued).toBe(true);
    expect(worker.enqueue({ code: 'B', severity: 'ERROR' }).enqueued).toBe(true);
    expect(worker.enqueue({ code: 'C', severity: 'INFO' }).enqueued).toBe(true);

    expect(worker.pending.map((entry) => entry.record.code)).toEqual(['B', 'C']);

    const snapshot = worker.getSnapshot();
    expect(snapshot.pendingQueueSize).toBe(2);
    expect(snapshot.metrics.dropped).toBe(1);
    expect(snapshot.metrics.droppedByPolicy.drop_oldest_non_fatal).toBe(1);
  });
});

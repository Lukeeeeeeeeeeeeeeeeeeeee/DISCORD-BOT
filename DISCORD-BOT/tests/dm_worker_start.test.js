'use strict';

const mockRun = jest.fn();
const mockLogUnexpectedError = jest.fn();
const mockLogRuntimeEvent = jest.fn();

jest.mock('../src/db_async', () => ({
  run: (...args) => mockRun(...args),
  get: jest.fn(async () => null),
  all: jest.fn(async () => [])
}));

jest.mock('../src/lib/logger', () => ({
  logUnexpectedError: (...args) => mockLogUnexpectedError(...args),
  logRuntimeEvent: (...args) => mockLogRuntimeEvent(...args)
}));

const { DMWorker } = require('../src/services/dm/dm-worker');

describe('dm-worker startup heartbeat', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockRun.mockReset();
    mockRun
      .mockRejectedValueOnce(new Error('heartbeat write failed'))
      .mockResolvedValue({ changes: 1 });
  });

  test('captures initial heartbeat failures without surfacing an unhandled rejection', async () => {
    const worker = new DMWorker({}, 'worker-1', 'Worker 1');

    worker.start();
    await Promise.resolve();
    await Promise.resolve();

    expect(mockLogUnexpectedError).toHaveBeenCalledWith(
      'dm.worker.heartbeat',
      expect.any(Error),
      { workerId: 'worker-1', phase: 'startup' }
    );

    await worker.stop();
  });
});

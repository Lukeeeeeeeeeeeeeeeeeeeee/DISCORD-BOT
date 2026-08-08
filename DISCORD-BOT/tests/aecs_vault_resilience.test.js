const fs = require('fs');
const os = require('os');
const path = require('path');
const { EventEmitter } = require('events');

const AecsVault = require('../src/lib/aecs/vault');

function makeEnotsupError() {
  const error = new Error('ENOTSUP: operation not supported on socket, write');
  error.code = 'ENOTSUP';
  return error;
}

describe('AECS vault resilience', () => {
  let logDir;

  beforeEach(() => {
    logDir = path.join(os.tmpdir(), `aecs-vault-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
  });

  afterEach(() => {
    jest.restoreAllMocks();
    if (logDir && fs.existsSync(logDir)) {
      fs.rmSync(logDir, { recursive: true, force: true });
    }
  });

  test('disables persistence after stream ENOTSUP instead of crashing', async () => {
    const createWriteStream = jest.spyOn(fs, 'createWriteStream').mockImplementation(() => {
      const stream = new EventEmitter();
      stream.write = jest.fn(() => true);
      stream.end = jest.fn((callback) => {
        if (typeof callback === 'function') callback();
      });
      stream.destroy = jest.fn();
      process.nextTick(() => {
        stream.emit('error', makeEnotsupError());
      });
      return stream;
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const vault = new AecsVault({ logDir, flushIntervalMs: 20 });
    vault.queue({ timestamp: Date.now(), hashId: 1, severity: 'INFO', scope: 'test.one' });

    await vault.flush();
    await new Promise((resolve) => setImmediate(resolve));

    expect(createWriteStream).toHaveBeenCalled();
    expect(vault.persistenceDisabled).toBe(true);
    expect(vault.persistenceError).toMatchObject({
      phase: 'stream:jsonl',
      code: 'ENOTSUP'
    });

    vault.queue({ timestamp: Date.now(), hashId: 2, severity: 'INFO', scope: 'test.two' });
    await vault.flush();

    expect(vault.droppedRecords).toBe(1);
  });

  test('forceWriteSync disables persistence on ENOTSUP', () => {
    jest.spyOn(fs, 'appendFileSync').mockImplementation(() => {
      throw makeEnotsupError();
    });
    jest.spyOn(console, 'error').mockImplementation(() => {});

    const vault = new AecsVault({ logDir, flushIntervalMs: 20 });

    expect(() => {
      vault.forceWriteSync({ timestamp: Date.now(), hashId: 3, severity: 'FATAL', scope: 'test.force' });
    }).not.toThrow();

    expect(vault.persistenceDisabled).toBe(true);
    expect(vault.persistenceError).toMatchObject({
      phase: 'forceWriteSync',
      code: 'ENOTSUP'
    });
    expect(vault.droppedRecords).toBe(1);
  });
});

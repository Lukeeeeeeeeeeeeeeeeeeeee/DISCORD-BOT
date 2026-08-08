const fs = require('fs');
const os = require('os');
const path = require('path');

const { parseArgs, syncToLocal } = require('../utils/aecs-sync');

describe('aecs-sync utility', () => {
  test('parses arguments and syncs changed files to local target', () => {
    const args = parseArgs(['--source', 'c:/src', '--target', 'c:/dest', '--interval', '5000', '--once']);
    expect(args.source).toBe('c:/src');
    expect(args.target).toBe('c:/dest');
    expect(args.intervalMs).toBe(5000);
    expect(args.once).toBe(true);

    const root = path.join(os.tmpdir(), `aecs-sync-test-${Date.now()}-${Math.random().toString(16).slice(2)}`);
    const source = path.join(root, 'source');
    const target = path.join(root, 'target');
    fs.mkdirSync(source, { recursive: true });

    const jsonl = path.join(source, 'aecs-2026-02-22.jsonl');
    const idx = path.join(source, 'aecs-2026-02-22.idx');
    fs.writeFileSync(jsonl, '{"ok":true}\n', 'utf8');
    fs.writeFileSync(idx, Buffer.alloc(16));

    const state = { lastFingerprint: new Map() };
    const copiedFirst = syncToLocal(source, target, state);
    expect(copiedFirst).toBe(2);
    expect(fs.existsSync(path.join(target, 'aecs-2026-02-22.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(target, 'aecs-2026-02-22.idx'))).toBe(true);

    const copiedSecond = syncToLocal(source, target, state);
    expect(copiedSecond).toBe(0);

    fs.rmSync(root, { recursive: true, force: true });
  });
});

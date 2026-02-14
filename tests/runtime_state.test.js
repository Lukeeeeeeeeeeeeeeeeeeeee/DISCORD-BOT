const runtime = require('../src/lib/runtime');

describe('runtime singleton hardening', () => {
  beforeEach(() => {
    runtime.resetForTests();
  });

  afterEach(() => {
    runtime.resetForTests();
  });

  test('ignores null/undefined overwrite attempts', () => {
    const fakeDb = { id: 'db1' };
    runtime.setDb(fakeDb);
    expect(runtime.getDb()).toBe(fakeDb);

    runtime.setDb(null);
    expect(runtime.getDb()).toBe(fakeDb);

    runtime.setDb(undefined);
    expect(runtime.getDb()).toBe(fakeDb);
  });

  test('explicit clear methods reset values', () => {
    const fakeClient = { id: 'c1' };
    const fakeAntiNuke = { id: 'a1' };
    runtime.setClient(fakeClient);
    runtime.setAntiNuke(fakeAntiNuke);

    expect(runtime.getClient()).toBe(fakeClient);
    expect(runtime.getAntiNuke()).toBe(fakeAntiNuke);

    runtime.clearClient();
    runtime.clearAntiNuke();

    expect(runtime.getClient()).toBeNull();
    expect(runtime.getAntiNuke()).toBeNull();
  });
});

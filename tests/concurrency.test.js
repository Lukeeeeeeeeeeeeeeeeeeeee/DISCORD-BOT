const { runWithConcurrency } = require('../src/lib/concurrency');

describe('runWithConcurrency', () => {
  test('preserves input ordering in results', async () => {
    const items = [1, 2, 3, 4, 5];
    const results = await runWithConcurrency(items, 3, async (value) => {
      await new Promise(resolve => setTimeout(resolve, (6 - value) * 5));
      return value * 10;
    });

    expect(results).toEqual([10, 20, 30, 40, 50]);
  });

  test('captures worker failures without aborting remaining tasks', async () => {
    const items = ['a', 'b', 'c'];
    const results = await runWithConcurrency(items, 2, async (value) => {
      if (value === 'b') throw new Error('boom');
      return value.toUpperCase();
    });

    expect(results[0]).toBe('A');
    expect(results[2]).toBe('C');
    expect(results[1]).toBeTruthy();
    expect(results[1].ok).toBe(false);
    expect(results[1].error).toBeInstanceOf(Error);
    expect(results[1].error.message).toBe('boom');
  });
});


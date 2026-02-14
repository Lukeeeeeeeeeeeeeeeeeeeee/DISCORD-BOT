/**
 * Run a list of items with a concurrency limit using a worker function.
 * @param {Array} items - Array of items to process.
 * @param {number} limit - Max number of concurrent tasks.
 * @param {Function} worker - Async function to process each item.
 * @returns {Promise<Array>} - Array of results preserving input order.
 */
async function runWithConcurrency(items, limit, worker) {
  const list = Array.isArray(items) ? items : [];
  const maxConcurrency = Math.max(1, Number(limit) || 1);
  const results = new Array(list.length);
  let index = 0;

  const runners = Array.from({ length: Math.min(maxConcurrency, list.length || 1) }, async () => {
    while (index < list.length) {
      const currentIndex = index;
      index += 1;
      if (currentIndex >= list.length) break;

      try {
        results[currentIndex] = await worker(list[currentIndex], currentIndex);
      } catch (e) {
        results[currentIndex] = { ok: false, error: e };
      }
    }
  });

  await Promise.all(runners);
  return results;
}

module.exports = { runWithConcurrency };

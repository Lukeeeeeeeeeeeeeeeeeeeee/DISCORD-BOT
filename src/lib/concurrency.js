/**
 * Run a list of items with a concurrency limit using a worker function.
 * @param {Array} items - Array of items to process.
 * @param {number} limit - Max number of concurrent tasks.
 * @param {Function} worker - Async function to process each item.
 * @returns {Promise<Array>} - Array of results (order not guaranteed if using push, but here we can try to preserve it or just match existing behavior).
 */
async function runWithConcurrency(items, limit, worker) {
    const results = [];
    let index = 0;
    const runners = Array.from({ length: Math.max(1, limit) }, async () => {
        while (index < items.length) {
            const current = items[index++];
            try {
                results.push(await worker(current));
            } catch (e) {
                results.push({ ok: false, error: e });
            }
        }
    });
    await Promise.all(runners);
    return results;
}

module.exports = { runWithConcurrency };

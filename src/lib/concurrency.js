/**
 * Run a list of items with a concurrency limit using a worker function.
 * @param {Array} items - Array of items to process.
 * @param {number} limit - Max number of concurrent tasks.
 * @param {Function} worker - Async function to process each item.
 * @returns {Promise<Array>} - Array of results (order not guaranteed if using push, but here we can try to preserve it or just match existing behavior).
 */
async function runWithConcurrency(items, limit, worker) {
    const queue = Array.isArray(items) ? items : [];
    if (!queue.length) return [];

    const maxWorkersRaw = Number.isFinite(limit) ? Math.floor(limit) : 1;
    const maxWorkers = Math.max(1, Math.min(queue.length, maxWorkersRaw));
    const results = new Array(queue.length);
    let cursor = 0;

    const runners = Array.from({ length: maxWorkers }, async () => {
        while (cursor < queue.length) {
            const currentIndex = cursor;
            cursor += 1;
            if (currentIndex >= queue.length) break;

            try {
                results[currentIndex] = await worker(queue[currentIndex], currentIndex);
            } catch (e) {
                results[currentIndex] = { ok: false, error: e };
            }
        }
    });

    await Promise.all(runners);
    return results;
}

module.exports = { runWithConcurrency };

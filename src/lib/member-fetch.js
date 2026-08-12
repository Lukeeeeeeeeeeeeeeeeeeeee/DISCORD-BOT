const DEFAULT_CHUNK_SIZE = Number.parseInt(process.env.MEMBER_FETCH_CHUNK || '50', 10); // Reduced from 100 to avoid timeouts
const DEFAULT_CONCURRENCY = Number.parseInt(process.env.MEMBER_FETCH_CONCURRENCY || '2', 10); // Reduced from 3 to be gentler on API
const DEFAULT_MAX_RETRIES = Number.parseInt(process.env.MEMBER_FETCH_MAX_RETRIES || '3', 10); // Increased from 2 to give more chances

function chunkArray(items, size = DEFAULT_CHUNK_SIZE) {
  const out = [];
  if (!items || !items.length) return out;
  const safeSize = Math.max(1, size || DEFAULT_CHUNK_SIZE);
  for (let i = 0; i < items.length; i += safeSize) {
    out.push(items.slice(i, i + safeSize));
  }
  return out;
}
const { runWithConcurrency } = require('./concurrency');
function getRetryAfterMs(error, fallbackMs) {
  const retryAfter = error && (error.retryAfter ?? error.retry_after ?? error.data?.retry_after ?? error.rawError?.retry_after);
  if (Number.isFinite(retryAfter)) {
    const value = Number(retryAfter);
    return value < 1000 ? Math.ceil(value * 1000) : Math.ceil(value);
  }
  return fallbackMs;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function fetchMembersByIds(guild, ids, opts = {}) {
  const members = new Map();
  if (!guild || !ids || !ids.length) return members;

  const cache = guild.members && guild.members.cache ? guild.members.cache : null;
  const missing = [];
  for (const id of ids) {
    const cached = cache ? cache.get(id) : null;
    if (cached) {
      members.set(id, cached);
    } else {
      missing.push(id);
    }
  }

  if (!missing.length) return members;
  if (!guild.members || typeof guild.members.fetch !== 'function') return members;

  const chunkSize = Number.isFinite(opts.chunkSize) ? opts.chunkSize : DEFAULT_CHUNK_SIZE;
  const concurrency = Number.isFinite(opts.concurrency) ? opts.concurrency : DEFAULT_CONCURRENCY;
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : DEFAULT_MAX_RETRIES;
  const chunks = chunkArray(missing, chunkSize);

  await runWithConcurrency(chunks, concurrency, async (chunk) => {
    let lastError = null;
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      try {
        const fetched = await guild.members.fetch({ user: chunk, time: 15000 }); // Add 15s timeout
        if (fetched && typeof fetched.values === 'function') {
          for (const member of fetched.values()) {
            if (member && member.id) members.set(member.id, member);
          }
        }
        return null;
      } catch (error) {
        lastError = error;
        const hardFail = error && (error.code === 50007 || error.code === 50013 || error.code === 50001);
        if (hardFail || attempt >= maxRetries) break;
        const rateLimited = error && (error.status === 429 || error.code === 429);
        const baseDelayMs = 2000 * (attempt + 1); // Increased from 1000 to 2000 for longer backoff
        const delayMs = rateLimited ? getRetryAfterMs(error, baseDelayMs) : baseDelayMs;
        await sleep(delayMs);
      }
    }
    if (lastError) {
      // Only log if it's not a timeout error to reduce noise
      const isTimeout = lastError && lastError.message && lastError.message.includes("didn't arrive");
      if (!isTimeout) {
        console.warn('Member fetch failed after retries', { count: chunk.length, error: lastError.message || lastError });
      }
    }
    return null;
  });

  return members;
}

module.exports = { fetchMembersByIds };

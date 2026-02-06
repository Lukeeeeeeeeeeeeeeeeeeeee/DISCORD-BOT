const DEFAULT_CHUNK_SIZE = Number.parseInt(process.env.MEMBER_FETCH_CHUNK || '100', 10);
const DEFAULT_CONCURRENCY = Number.parseInt(process.env.MEMBER_FETCH_CONCURRENCY || '3', 10);

function chunkArray(items, size = DEFAULT_CHUNK_SIZE) {
  const out = [];
  if (!items || !items.length) return out;
  const safeSize = Math.max(1, size || DEFAULT_CHUNK_SIZE);
  for (let i = 0; i < items.length; i += safeSize) {
    out.push(items.slice(i, i + safeSize));
  }
  return out;
}

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
  const chunks = chunkArray(missing, chunkSize);

  await runWithConcurrency(chunks, concurrency, async (chunk) => {
    const fetched = await guild.members.fetch({ user: chunk }).catch(() => null);
    if (!fetched) return null;
    if (typeof fetched.values === 'function') {
      for (const member of fetched.values()) {
        if (member && member.id) members.set(member.id, member);
      }
    }
    return null;
  });

  return members;
}

module.exports = { fetchMembersByIds };

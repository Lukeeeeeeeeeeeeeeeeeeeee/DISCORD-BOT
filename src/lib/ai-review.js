const fs = require('fs');
const path = require('path');
const https = require('https');
const crypto = require('crypto');
const db = require('../db_async');
const { ROLE_IDS, RECRUITER_ROLE_IDS, CHANNELS } = require('../constants');
const { toDayKey } = require('./analytics');

const REVIEW_INTERVAL_MS = 72 * 60 * 60 * 1000;
const REVIEW_MAX_RUNTIME_MS = parseEnvNumber(process.env.AI_REVIEW_MAX_RUNTIME_MS, 15 * 60 * 1000); // Reduced to 15m
const GEMINI_REQUEST_TIMEOUT_MS = parseEnvNumber(process.env.GEMINI_REQUEST_TIMEOUT_MS, 120 * 1000);
let reviewRunning = false;
let reviewStartedAt = 0;
let reviewSource = null; // Track who started the review
const GUIDE_MAX_CHARS = parseEnvNumber(process.env.AI_REVIEW_GUIDE_MAX_CHARS, 4200);
const GUIDE_MAX_CHUNKS = parseEnvNumber(process.env.AI_REVIEW_GUIDE_MAX_CHUNKS, 8);
const GUIDE_CHUNK_SIZE = parseEnvNumber(process.env.AI_REVIEW_GUIDE_CHUNK_SIZE, 1600);
const GUIDE_QUERY_MAX_CHARS = parseEnvNumber(process.env.AI_REVIEW_GUIDE_QUERY_MAX_CHARS, 5000);
const GUIDE_EMBEDDING_MODEL = process.env.AI_REVIEW_EMBEDDING_MODEL || 'text-embedding-004';
const GUIDE_USE_EMBEDDINGS = parseEnvBoolean(process.env.AI_REVIEW_USE_EMBEDDINGS, true);
const GUIDE_EMBEDDING_PRUNE = parseEnvBoolean(process.env.AI_REVIEW_EMBEDDING_PRUNE, true);
const COHORT_WINDOW_DAYS = 30;
const COHORT_RETENTION_DAYS = 7;
const COHORT_MIN_INVITES = 3;
const STOPWORDS = new Set([
  'the', 'and', 'that', 'with', 'from', 'this', 'have', 'has', 'were', 'your', 'their', 'they', 'them', 'about',
  'into', 'for', 'are', 'but', 'not', 'you', 'our', 'was', 'will', 'just', 'been', 'when', 'then', 'than', 'over',
  'last', 'days', 'vs', 'per', 'only', 'more', 'less', 'within', 'between', 'members', 'member', 'server', 'guild'
]);
const DOMAIN_KEYWORDS = [
  'recruit', 'recruiter', 'verification', 'verify', 'inactive', 'activity', 'morale', 'event', 'poll', 'voice',
  'welcome', 'onboarding', 'demotion', 'promotion', 'warning', 'leader', 'staff', 'engagement', 'retention',
  'invite', 'loyalty', 'hype', 'team', 'balance', 'channel', 'private', 'public', 'absence', 'absent'
];

function parseEnvNumber(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function parseEnvBoolean(value, fallback) {
  if (value == null) return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (['1', 'true', 'yes', 'y', 'on'].includes(normalized)) return true;
  if (['0', 'false', 'no', 'n', 'off'].includes(normalized)) return false;
  return fallback;
}

function isReviewStale(now = Date.now()) {
  return reviewRunning && reviewStartedAt && now - reviewStartedAt > REVIEW_MAX_RUNTIME_MS;
}

function clearStaleReview(now = Date.now()) {
  if (!isReviewStale(now)) return false;
  reviewRunning = false;
  reviewStartedAt = 0;
  return true;
}

function dayKeyFromOffset(days) {
  return toDayKey(Date.now() - days * 24 * 60 * 60 * 1000);
}

function sumRows(rows = [], fields = []) {
  const totals = {};
  for (const field of fields) totals[field] = 0;
  for (const row of rows) {
    for (const field of fields) totals[field] += Number(row[field] || 0);
  }
  return totals;
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

function pctChange(current, previous) {
  if (!previous && !current) return 0;
  if (!previous) return 100;
  return Math.round(((current - previous) / previous) * 100);
}

function formatPct(value) {
  if (!Number.isFinite(value)) return '0%';
  return `${Math.round(value * 100)}%`;
}

function formatRate(numerator, denominator) {
  if (!denominator) return 'n/a';
  return `${Math.round((numerator / denominator) * 100)}%`;
}

function escapeRegex(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function extractKeywords(facts = []) {
  const text = facts.join(' ').toLowerCase();
  const tokens = text.match(/[a-z]{4,}/g) || [];
  const counts = new Map();
  for (const token of tokens) {
    if (STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) || 0) + 1);
  }
  const topTokens = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([token]) => token);
  const keywords = new Set(topTokens);
  DOMAIN_KEYWORDS.forEach(keyword => {
    if (text.includes(keyword)) keywords.add(keyword);
  });
  return Array.from(keywords);
}

function splitGuideChunks(rawGuides = '') {
  if (!rawGuides) return [];
  const lines = rawGuides.split(/\r?\n/);
  const chunks = [];
  let current = { title: '## Guide Overview', lines: [] };

  const pushChunk = () => {
    const body = current.lines.join('\n').trim();
    if (!body) return;
    const baseText = `${current.title}\n${body}`.trim();
    if (baseText.length <= GUIDE_CHUNK_SIZE) {
      chunks.push({ title: current.title, text: baseText });
      return;
    }
    const paragraphs = baseText.split(/\n{2,}/);
    let buffer = '';
    for (const paragraph of paragraphs) {
      const next = buffer ? `${buffer}\n\n${paragraph}` : paragraph;
      if (next.length > GUIDE_CHUNK_SIZE && buffer) {
        chunks.push({ title: current.title, text: buffer.trim() });
        buffer = paragraph;
      } else {
        buffer = next;
      }
    }
    if (buffer.trim()) chunks.push({ title: current.title, text: buffer.trim() });
  };

  for (const line of lines) {
    const headingMatch = line.match(/^(#{2,3})\s+(.*)/);
    if (headingMatch) {
      pushChunk();
      current = { title: `${headingMatch[1]} ${headingMatch[2]}`.trim(), lines: [line] };
      continue;
    }
    current.lines.push(line);
  }
  pushChunk();
  return chunks;
}

function scoreGuideChunk(chunk, keywords) {
  const text = chunk.text.toLowerCase();
  let score = 0;
  for (const keyword of keywords) {
    const regex = new RegExp(`\\b${escapeRegex(keyword)}\\b`, 'g');
    const matches = text.match(regex);
    if (matches) score += matches.length;
    if (chunk.title.toLowerCase().includes(keyword)) score += 2;
  }
  return score;
}

function selectGuideChunks({ guideText, facts }) {
  if (!guideText) return '';
  const chunks = splitGuideChunks(guideText);
  if (!chunks.length) return guideText.slice(0, GUIDE_MAX_CHARS);
  const keywords = extractKeywords(facts);
  const scored = chunks.map(chunk => ({ ...chunk, score: scoreGuideChunk(chunk, keywords) }));
  scored.sort((a, b) => b.score - a.score);
  let selected = scored.filter(chunk => chunk.score > 0).slice(0, GUIDE_MAX_CHUNKS);
  if (!selected.length) selected = scored.slice(0, Math.min(2, scored.length));

  const output = [];
  let totalChars = 0;
  for (const chunk of selected) {
    if (totalChars + chunk.text.length > GUIDE_MAX_CHARS && output.length) break;
    output.push(chunk.text.trim());
    totalChars += chunk.text.length;
  }
  return output.join('\n\n---\n\n');
}

function buildGuideQuery(facts = []) {
  if (!facts.length) return DOMAIN_KEYWORDS.join(' ');
  const trimmed = facts.join(' ').slice(0, GUIDE_QUERY_MAX_CHARS);
  return `Guide relevance query: ${trimmed}`;
}

function cosineSimilarity(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0;
  const len = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < len; i += 1) {
    const av = Number(a[i] || 0);
    const bv = Number(b[i] || 0);
    dot += av * bv;
    normA += av * av;
    normB += bv * bv;
  }
  if (!normA || !normB) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

function getGuideChunkId(chunk) {
  return crypto.createHash('sha256').update(`${chunk.title}::${chunk.text}`).digest('hex');
}

async function callGeminiEmbedding({ apiKey, text, model = GUIDE_EMBEDDING_MODEL }) {
  const payload = JSON.stringify({
    content: {
      parts: [{ text }]
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:embedContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini embedding error: ${res.statusCode} ${data}`));
        }
        try {
          const json = JSON.parse(data);
          const values = json && json.embedding && Array.isArray(json.embedding.values)
            ? json.embedding.values
            : null;
          if (!values) return reject(new Error('Gemini embedding returned no values.'));
          return resolve(values);
        } catch (e) {
          return reject(e);
        }
      });
    });
    req.setTimeout(GEMINI_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Gemini embedding request timed out.'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function getGuideEmbeddings({ chunks, apiKey }) {
  const idMap = new Map();
  const ids = chunks.map(chunk => {
    const id = getGuideChunkId(chunk);
    idMap.set(id, chunk);
    return id;
  });

  const embeddingMap = new Map();
  if (!ids.length) return embeddingMap;

  for (const batch of chunkArray(ids, 450)) {
    const placeholders = batch.map(() => '?').join(',');
    const rows = await db.all(
      `SELECT id, embedding_json FROM analytics_guide_embeddings WHERE id IN (${placeholders})`,
      ...batch
    );
    for (const row of rows || []) {
      try {
        const parsed = JSON.parse(row.embedding_json);
        if (Array.isArray(parsed)) embeddingMap.set(row.id, parsed);
      } catch (e) {
        void e;
      }
    }
  }

  const missing = ids.filter(id => !embeddingMap.has(id));
  for (const id of missing) {
    const chunk = idMap.get(id);
    if (!chunk) continue;
    try {
      const embedding = await callGeminiEmbedding({ apiKey, text: chunk.text });
      embeddingMap.set(id, embedding);
      await db.run(
        'INSERT OR REPLACE INTO analytics_guide_embeddings (id, chunk_title, chunk_text, embedding_json, updated_at) VALUES (?, ?, ?, ?, ?)',
        id,
        chunk.title,
        chunk.text,
        JSON.stringify(embedding),
        Date.now()
      );
    } catch (e) {
      void e;
    }
  }

  return embeddingMap;
}

async function pruneGuideEmbeddings({ currentIds }) {
  if (!GUIDE_EMBEDDING_PRUNE) return;
  if (!currentIds || !currentIds.size) return;
  try {
    const rows = await db.all('SELECT id FROM analytics_guide_embeddings');
    const staleIds = (rows || []).map(row => row.id).filter(id => !currentIds.has(id));
    for (const batch of chunkArray(staleIds, 450)) {
      const placeholders = batch.map(() => '?').join(',');
      await db.run(`DELETE FROM analytics_guide_embeddings WHERE id IN (${placeholders})`, ...batch);
    }
  } catch (e) {
    void e;
  }
}

async function selectGuideChunksSemantic({ guideText, facts, apiKey }) {
  const fallback = selectGuideChunks({ guideText, facts });
  if (!guideText) return '';
  if (!GUIDE_USE_EMBEDDINGS) return fallback;
  if (!apiKey) return fallback;
  const chunks = splitGuideChunks(guideText);
  if (!chunks.length) return fallback;

  const currentIds = new Set(chunks.map(chunk => getGuideChunkId(chunk)));
  await pruneGuideEmbeddings({ currentIds });

  let queryEmbedding;
  try {
    const query = buildGuideQuery(facts);
    queryEmbedding = await callGeminiEmbedding({ apiKey, text: query });
  } catch (e) {
    return fallback;
  }

  const embeddingMap = await getGuideEmbeddings({ chunks, apiKey });
  if (!embeddingMap.size) return fallback;

  const scored = [];
  for (const chunk of chunks) {
    const id = getGuideChunkId(chunk);
    const embedding = embeddingMap.get(id);
    if (!embedding) continue;
    scored.push({ chunk, score: cosineSimilarity(queryEmbedding, embedding) });
  }

  if (!scored.length) return fallback;
  scored.sort((a, b) => b.score - a.score);

  const output = [];
  let totalChars = 0;
  for (const item of scored.slice(0, GUIDE_MAX_CHUNKS)) {
    if (totalChars + item.chunk.text.length > GUIDE_MAX_CHARS && output.length) break;
    output.push(item.chunk.text.trim());
    totalChars += item.chunk.text.length;
  }

  return output.length ? output.join('\n\n---\n\n') : fallback;
}

function classifyChannel(name, category) {
  const base = `${name || ''} ${category || ''}`.toLowerCase();
  if (base.includes('announce')) return 'announcement';
  if (base.includes('recruit')) return 'recruitment';
  if (base.includes('invite')) return 'invite';
  if (base.includes('event') || base.includes('war')) return 'event';
  if (base.includes('staff') || base.includes('leader')) return 'staff';
  if (base.includes('general') || base.includes('chat')) return 'general';
  return 'other';
}

function detectTeamFromChannel(name, category) {
  const base = `${name || ''} ${category || ''}`.toLowerCase();
  if (base.includes('fire') || base.includes('🔥')) return 'EU';
  if (base.includes('water') || base.includes('💧')) return 'NA';
  if (base.includes('air') || base.includes('🌬')) return 'AS';
  if (/\beu\b/.test(base)) return 'EU';
  if (/\bna\b/.test(base)) return 'NA';
  return null;
}

function splitMessage(text, maxLen = 1900) {
  const chunks = [];
  let remaining = text || '';
  while (remaining.length > maxLen) {
    let splitAt = remaining.lastIndexOf('\n', maxLen);
    if (splitAt < 0) splitAt = maxLen;
    chunks.push(remaining.slice(0, splitAt));
    remaining = remaining.slice(splitAt).trimStart();
  }
  if (remaining.length) chunks.push(remaining);
  return chunks;
}

async function loadGuides() {
  const guidesPath = path.join(__dirname, '..', 'data', 'ai-guides.md');
  try {
    const content = fs.readFileSync(guidesPath, 'utf8');
    const maxLength = 50000;
    return content.length > maxLength ? content.slice(0, maxLength) : content;
  } catch (e) {
    return '';
  }
}

async function collectFacts({ guild }) {
  const guildId = guild.id;
  const now = Date.now();
  const day7 = dayKeyFromOffset(7);
  const day14 = dayKeyFromOffset(14);


  await guild.members.fetch().catch(() => null);

  const members = guild.members.cache ? Array.from(guild.members.cache.values()) : [];
  const humans = members.filter(m => !m.user.bot);
  const bots = members.filter(m => m.user.bot);
  const humanCount = humans.length || guild.memberCount || members.length;

  const dailyRows = await db.all(
    'SELECT day, message_count, unique_speakers, joins, leaves, invites_created, invites_used FROM analytics_daily_guild WHERE guild_id = ? AND day >= ? ORDER BY day ASC',
    guildId,
    day14
  );

  const last7Rows = dailyRows.filter(r => r.day >= day7);
  const prev7Rows = dailyRows.filter(r => r.day < day7);
  const last7 = sumRows(last7Rows, ['message_count', 'unique_speakers', 'joins', 'leaves', 'invites_created', 'invites_used']);
  const prev7 = sumRows(prev7Rows, ['message_count', 'unique_speakers', 'joins', 'leaves', 'invites_created', 'invites_used']);

  const messagesDelta = pctChange(last7.message_count, prev7.message_count);
  const speakersDelta = pctChange(last7.unique_speakers, prev7.unique_speakers);
  const joinsDelta = pctChange(last7.joins, prev7.joins);
  const invitesDelta = pctChange(last7.invites_used, prev7.invites_used);

  const channelRows = await db.all(
    'SELECT channel_id, SUM(message_count) as messages, SUM(unique_speakers) as speakers, MAX(last_message_at) as last_message_at FROM analytics_daily_channels WHERE guild_id = ? AND day >= ? GROUP BY channel_id',
    guildId,
    day7
  );

  const channelStats = channelRows.map(row => {
    const ch = guild.channels.cache.get(row.channel_id);
    const categoryName = ch && ch.parent ? ch.parent.name : '';
    const channelName = ch ? ch.name : row.channel_id;
    const isPublic = ch && ch.permissionsFor && guild.roles && guild.roles.everyone
      ? !!ch.permissionsFor(guild.roles.everyone)?.has('ViewChannel')
      : false;
    return {
      id: row.channel_id,
      name: channelName,
      category: categoryName,
      messages: Number(row.messages || 0),
      speakers: Number(row.speakers || 0),
      isPublic,
      type: classifyChannel(channelName, categoryName),
      team: detectTeamFromChannel(channelName, categoryName)
    };
  });

  channelStats.sort((a, b) => b.messages - a.messages);
  const topChannels = channelStats.slice(0, 6);
  const privateInactive = channelStats.filter(c => !c.isPublic && c.messages === 0).length;
  const channelTypeTotals = channelStats.reduce((acc, cur) => {
    acc[cur.type] = (acc[cur.type] || 0) + cur.messages;
    return acc;
  }, {});
  const eventChannelsActive = channelStats.filter(c => c.type === 'event' && c.messages > 0).length;
  const eventMessages = channelTypeTotals.event || 0;

  const teamChannelTotals = channelStats.reduce((acc, cur) => {
    if (cur.team) acc[cur.team] = (acc[cur.team] || 0) + cur.messages;
    return acc;
  }, {});

  const totalChannels = guild.channels.cache ? guild.channels.cache.size : 0;
  const publicChannels = guild.channels.cache
    ? Array.from(guild.channels.cache.values()).filter(ch => ch.permissionsFor && guild.roles && guild.roles.everyone
      ? !!ch.permissionsFor(guild.roles.everyone)?.has('ViewChannel')
      : false).length
    : 0;
  const privateChannels = totalChannels - publicChannels;

  const recruits7 = await db.get('SELECT COUNT(*) as c FROM recruits WHERE valid = 1 AND created_at >= ?', now - 7 * 24 * 60 * 60 * 1000);
  const recruits14 = await db.get('SELECT COUNT(*) as c FROM recruits WHERE valid = 1 AND created_at >= ?', now - 14 * 24 * 60 * 60 * 1000);
  const verifications7 = await db.get('SELECT COUNT(*) as c FROM verifications WHERE verified_at >= ?', now - 7 * 24 * 60 * 60 * 1000);
  const recruitCount7 = recruits7 ? recruits7.c : 0;
  const recruitCount14 = recruits14 ? recruits14.c : 0;
  const verifyCount7 = verifications7 ? verifications7.c : 0;
  const verifyRate7 = recruitCount7 > 0 ? verifyCount7 / recruitCount7 : 0;

  const warningCount = await db.get('SELECT COUNT(*) as c FROM warnings WHERE revoked = 0 AND (expired_at IS NULL OR expired_at > ?)', now);
  const absences = await db.all('SELECT recruiter_id FROM absences WHERE active = 1 AND end_date >= date("now")');
  const absentSet = new Set((absences || []).map(r => r.recruiter_id));

  const activityRows = await db.all('SELECT user_id, last_active_at FROM analytics_user_activity');
  const activityMap = new Map(activityRows.map(r => [r.user_id, r.last_active_at]));

  const active14 = activityRows.filter(r => r.last_active_at && r.last_active_at >= now - 14 * 24 * 60 * 60 * 1000).length;
  const active7 = activityRows.filter(r => r.last_active_at && r.last_active_at >= now - 7 * 24 * 60 * 60 * 1000).length;
  const active7Pct = humanCount ? active7 / humanCount : 0;
  const active14Pct = humanCount ? active14 / humanCount : 0;

  const unverifiedMembers = members.filter(m => m.roles?.cache?.has(ROLE_IDS.UNVERIFIED));
  const unverifiedOver48h = unverifiedMembers.filter(m => m.joinedAt && now - m.joinedAt.getTime() >= 48 * 60 * 60 * 1000).length;

  const staffRoleIds = [
    ROLE_IDS.HELPER,
    ROLE_IDS.HELPER_PLUS,
    ROLE_IDS.HIGH_STAFF,
    ROLE_IDS.MOD,
    ROLE_IDS.CHIEF,
    ROLE_IDS.CHIEF_OF_WAR,
    ROLE_IDS.CHIEF_OF_COMMUNITY,
    ROLE_IDS.CHIEF_OF_RECRUITMENT,
    ROLE_IDS.CO_LEADER,
    ROLE_IDS.LEADER
  ].filter(Boolean);

  const recruiterRoleIds = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...(RECRUITER_ROLE_IDS ? Object.values(RECRUITER_ROLE_IDS) : [])
  ].filter(Boolean);

  const roleActivity = [];
  for (const roleId of staffRoleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role) continue;
    const total = role.members ? role.members.size : 0;
    const active = role.members ? role.members.filter(m => {
      const ts = activityMap.get(m.id);
      return ts && ts >= now - 14 * 24 * 60 * 60 * 1000;
    }).size : 0;
    roleActivity.push({ role: role.name, total, active });
  }

  const recruiterMembers = new Map();
  for (const roleId of recruiterRoleIds) {
    const role = guild.roles.cache.get(roleId);
    if (!role || !role.members) continue;
    role.members.forEach(m => recruiterMembers.set(m.id, m));
  }
  const totalRecruiters = recruiterMembers.size;

  const recruiterTeamCounts = {
    EU: RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.EU ? (guild.roles.cache.get(RECRUITER_ROLE_IDS.EU)?.members.size || 0) : 0,
    NA: RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.NA ? (guild.roles.cache.get(RECRUITER_ROLE_IDS.NA)?.members.size || 0) : 0,
    AS: RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.AS ? (guild.roles.cache.get(RECRUITER_ROLE_IDS.AS)?.members.size || 0) : 0
  };
  const recruiterTeamActive = {
    EU: RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.EU ? (guild.roles.cache.get(RECRUITER_ROLE_IDS.EU)?.members.filter(m => {
      const ts = activityMap.get(m.id);
      return ts && ts >= now - 14 * 24 * 60 * 60 * 1000;
    }).size || 0) : 0,
    NA: RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.NA ? (guild.roles.cache.get(RECRUITER_ROLE_IDS.NA)?.members.filter(m => {
      const ts = activityMap.get(m.id);
      return ts && ts >= now - 14 * 24 * 60 * 60 * 1000;
    }).size || 0) : 0,
    AS: RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.AS ? (guild.roles.cache.get(RECRUITER_ROLE_IDS.AS)?.members.filter(m => {
      const ts = activityMap.get(m.id);
      return ts && ts >= now - 14 * 24 * 60 * 60 * 1000;
    }).size || 0) : 0
  };

  const inactiveRecruiters = Array.from(recruiterMembers.values()).filter(m => {
    if (absentSet.has(m.id)) return false;
    const lastActive = activityMap.get(m.id);
    return !lastActive || lastActive < now - 14 * 24 * 60 * 60 * 1000;
  });

  const teamCounts = {
    EU: ROLE_IDS.TEAM_MEMBER && ROLE_IDS.TEAM_MEMBER.EU ? (guild.roles.cache.get(ROLE_IDS.TEAM_MEMBER.EU)?.members.size || 0) : 0,
    NA: ROLE_IDS.TEAM_MEMBER && ROLE_IDS.TEAM_MEMBER.NA ? (guild.roles.cache.get(ROLE_IDS.TEAM_MEMBER.NA)?.members.size || 0) : 0,
    AS: ROLE_IDS.TEAM_MEMBER && ROLE_IDS.TEAM_MEMBER.AS ? (guild.roles.cache.get(ROLE_IDS.TEAM_MEMBER.AS)?.members.size || 0) : 0
  };

  const teamValues = Object.values(teamCounts).filter(v => v > 0);
  const teamImbalance = teamValues.length >= 2 ? Math.max(...teamValues) / Math.max(1, Math.min(...teamValues)) : 1;

  const teamRecruitRows = await db.all(
    'SELECT region, COUNT(*) as c FROM recruits WHERE valid = 1 AND created_at >= ? GROUP BY region',
    now - 7 * 24 * 60 * 60 * 1000
  );
  const teamRecruitCounts = { EU: 0, NA: 0, AS: 0 };
  for (const row of teamRecruitRows || []) {
    if (row.region && teamRecruitCounts[row.region] != null) teamRecruitCounts[row.region] = row.c;
  }

  const roleChangeRows = await db.all(
    'SELECT role_id, action, COUNT(*) as c FROM analytics_role_changes WHERE guild_id = ? AND created_at >= ? GROUP BY role_id, action',
    guildId,
    now - 7 * 24 * 60 * 60 * 1000
  );
  const roleChangeCounts = { staffAdds: 0, staffRemoves: 0, recruiterAdds: 0, recruiterRemoves: 0, teamAdds: 0, teamRemoves: 0 };
  for (const row of roleChangeRows || []) {
    const roleId = row.role_id;
    const action = row.action;
    const isStaff = staffRoleIds.includes(roleId);
    const isRecruiter = recruiterRoleIds.includes(roleId);
    const isTeam = ROLE_IDS.TEAM_MEMBER && Object.values(ROLE_IDS.TEAM_MEMBER).includes(roleId);
    if (isStaff) roleChangeCounts[action === 'added' ? 'staffAdds' : 'staffRemoves'] += row.c;
    if (isRecruiter) roleChangeCounts[action === 'added' ? 'recruiterAdds' : 'recruiterRemoves'] += row.c;
    if (isTeam) roleChangeCounts[action === 'added' ? 'teamAdds' : 'teamRemoves'] += row.c;
  }

  const voiceRows = await db.all(
    'SELECT user_id, SUM(minutes) as minutes FROM analytics_voice_daily WHERE guild_id = ? AND day >= ? GROUP BY user_id',
    guildId,
    day7
  );
  const voiceMinutes = voiceRows.reduce((sum, row) => sum + Number(row.minutes || 0), 0);
  const voiceActive = voiceRows.filter(row => Number(row.minutes || 0) > 0).length;

  const purchases7 = await db.get('SELECT COUNT(*) as c FROM purchases WHERE created_at >= ?', now - 7 * 24 * 60 * 60 * 1000);
  const purchasesCount7 = purchases7 ? purchases7.c : 0;

  const weeklySummary = await db.get(
    'SELECT AVG(calculated_min_req) as avg_min_req, AVG(recruits7d) as avg_recruits FROM weekly_calculations WHERE week_start = (SELECT MAX(week_start) FROM weekly_calculations)'
  );
  const avgMinReq = weeklySummary && weeklySummary.avg_min_req != null ? Number(weeklySummary.avg_min_req).toFixed(2) : 'n/a';
  const avgRecruits7d = weeklySummary && weeklySummary.avg_recruits != null ? Number(weeklySummary.avg_recruits).toFixed(2) : 'n/a';

  const recruits30 = await db.all(
    'SELECT recruited_id, created_at FROM recruits WHERE valid = 1 AND created_at >= ? ORDER BY created_at DESC',
    now - 30 * 24 * 60 * 60 * 1000
  );
  const retentionEligible = (recruits30 || []).filter(r => now - r.created_at >= 7 * 24 * 60 * 60 * 1000);
  const retentionSample = retentionEligible.length > 300 ? retentionEligible.slice(0, 300) : retentionEligible;
  const retainedCount = retentionSample.filter(r => guild.members.cache.has(r.recruited_id)).length;
  const retentionRate = retentionSample.length ? retainedCount / retentionSample.length : 0;
  const retentionSampled = retentionSample.length !== retentionEligible.length;

  const inviteCohortWindowMs = COHORT_WINDOW_DAYS * 24 * 60 * 60 * 1000;
  const inviteRetentionMs = COHORT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
  let inviteCohortFacts = null;
  let inviteCohortTop = null;
  let inviteCohortBottom = null;

  try {
    const inviteRows = await db.all(
      'SELECT recruiter_id, used_by, used_at FROM recruiter_invites WHERE used = 1 AND used_at >= ? AND used_by IS NOT NULL',
      now - inviteCohortWindowMs
    );

    if (inviteRows && inviteRows.length) {
      const usedByIds = Array.from(new Set(inviteRows.map(r => r.used_by).filter(Boolean)));
      const recruitMap = new Map();
      const verifyMap = new Map();

      for (const chunk of chunkArray(usedByIds, 450)) {
        const placeholders = chunk.map(() => '?').join(',');
        const recruitRows = await db.all(
          `SELECT recruited_id, created_at FROM recruits WHERE valid = 1 AND recruited_id IN (${placeholders})`,
          ...chunk
        );
        for (const row of recruitRows) recruitMap.set(row.recruited_id, row);

        const verifyRows = await db.all(
          `SELECT recruited_id, verified_at FROM verifications WHERE recruited_id IN (${placeholders})`,
          ...chunk
        );
        for (const row of verifyRows) verifyMap.set(row.recruited_id, row);
      }

      const cohortMap = new Map();
      const totals = { invites: 0, recruits: 0, verifies: 0, retentionEligible: 0, retained: 0 };

      for (const row of inviteRows) {
        if (!row.recruiter_id || !row.used_by) continue;
        const cohort = cohortMap.get(row.recruiter_id) || {
          invites: 0,
          recruits: 0,
          verifies: 0,
          retentionEligible: 0,
          retained: 0
        };
        cohort.invites += 1;
        totals.invites += 1;

        const recruit = recruitMap.get(row.used_by);
        if (recruit) {
          cohort.recruits += 1;
          totals.recruits += 1;
          if (verifyMap.has(row.used_by)) {
            cohort.verifies += 1;
            totals.verifies += 1;
          }

          const cohortTs = recruit.created_at || row.used_at || 0;
          if (cohortTs && now - cohortTs >= inviteRetentionMs) {
            cohort.retentionEligible += 1;
            totals.retentionEligible += 1;
            if (guild.members.cache.has(row.used_by)) {
              cohort.retained += 1;
              totals.retained += 1;
            }
          }
        }

        cohortMap.set(row.recruiter_id, cohort);
      }

      const cohortList = Array.from(cohortMap.entries())
        .map(([recruiterId, data]) => {
          const recruitRate = data.invites ? data.recruits / data.invites : 0;
          const verifyRate = data.recruits ? data.verifies / data.recruits : 0;
          const retentionRate = data.retentionEligible ? data.retained / data.retentionEligible : null;
          return { recruiterId, ...data, recruitRate, verifyRate, retentionRate };
        })
        .filter(item => item.invites >= COHORT_MIN_INVITES);

      if (cohortList.length) {
        const formatLine = item => {
          const retentionText = item.retentionRate == null ? 'n/a' : formatPct(item.retentionRate);
          return `${item.recruiterId} invite→recruit=${item.recruitRate.toFixed(2)} (${item.recruits}/${item.invites}), verify=${formatPct(item.verifyRate)}, retention=${retentionText}`;
        };

        const top = [...cohortList].sort((a, b) => b.recruitRate - a.recruitRate).slice(0, 3);
        const bottom = [...cohortList].sort((a, b) => a.recruitRate - b.recruitRate).slice(0, 3);
        inviteCohortTop = top.map(formatLine).join(' | ');
        inviteCohortBottom = bottom.map(formatLine).join(' | ');
      }

      if (totals.invites > 0) {
        const overallRecruitRate = totals.recruits ? (totals.recruits / totals.invites) : 0;
        const overallVerifyRate = totals.recruits ? (totals.verifies / totals.recruits) : 0;
        const overallRetentionRate = totals.retentionEligible ? (totals.retained / totals.retentionEligible) : null;
        const overallRetentionText = overallRetentionRate == null ? 'n/a' : formatPct(overallRetentionRate);
        inviteCohortFacts = `Invite cohorts last ${COHORT_WINDOW_DAYS}d (min ${COHORT_MIN_INVITES} invites used per recruiter). Overall invite→recruit=${overallRecruitRate.toFixed(2)} (${totals.recruits}/${totals.invites}), verify=${formatPct(overallVerifyRate)}, retention=${overallRetentionText}.`;
      }
    }
  } catch (e) {
    inviteCohortFacts = null;
  }

  const facts = [];
  facts.push(`F1: Members total=${guild.memberCount || members.length} (humans=${humans.length}, bots=${bots.length}).`);
  facts.push(`F2: Active users last 7d=${active7} (${formatPct(active7Pct)}), last 14d=${active14} (${formatPct(active14Pct)}).`);
  facts.push(`F3: Messages last 7d=${last7.message_count} vs previous 7d=${prev7.message_count} (${messagesDelta}%).`);
  facts.push(`F4: Unique speakers last 7d=${last7.unique_speakers} vs previous 7d=${prev7.unique_speakers} (${speakersDelta}%).`);
  facts.push(`F5: Joins last 7d=${last7.joins} vs previous 7d=${prev7.joins} (${joinsDelta}%).`);
  facts.push(`F6: Invites used last 7d=${last7.invites_used} vs previous 7d=${prev7.invites_used} (${invitesDelta}%). Invites created last 7d=${last7.invites_created}.`);
  const inviteRecruitRatio = last7.invites_used ? (recruitCount7 / last7.invites_used) : 0;
  facts.push(`F7: Recruits last 7d=${recruitCount7}, last 14d=${recruitCount14}. Verification rate last 7d=${formatPct(verifyRate7)}. Invite→recruit ratio=${inviteRecruitRatio.toFixed(2)}.`);
  facts.push(`F8: Unverified members >48h=${unverifiedOver48h}. Active absences=${absentSet.size}. Active warnings=${warningCount ? warningCount.c : 0}.`);
  facts.push(`F9: Recruiters total=${totalRecruiters}. Inactive recruiters (no 14d activity, not absent)=${inactiveRecruiters.length}.`);

  if (roleActivity.length) {
    const roleSummary = roleActivity.map(r => `${r.role} ${r.active}/${r.total}`).join(', ');
    facts.push(`F10: Staff role activity (active/total, 14d): ${roleSummary}.`);
  }

  facts.push(`F11: Team member counts EU=${teamCounts.EU}, NA=${teamCounts.NA}, AS=${teamCounts.AS}, imbalance ratio=${teamImbalance.toFixed(2)}.`);
  facts.push(`F11b: Recruiter team counts EU=${recruiterTeamCounts.EU}, NA=${recruiterTeamCounts.NA}, AS=${recruiterTeamCounts.AS}. Active recruiters (14d) EU=${recruiterTeamActive.EU}, NA=${recruiterTeamActive.NA}, AS=${recruiterTeamActive.AS}.`);
  facts.push(`F11c: Recruits last 7d by team EU=${teamRecruitCounts.EU}, NA=${teamRecruitCounts.NA}, AS=${teamRecruitCounts.AS}.`);

  if (topChannels.length) {
    const topText = topChannels.map(c => `${c.name} (${c.type})=${c.messages} msgs, ${c.speakers} speakers, ${c.isPublic ? 'public' : 'private'}`).join(' | ');
    facts.push(`F12: Top channels last 7d: ${topText}.`);
  }

  const channelTypeText = Object.entries(channelTypeTotals).map(([type, total]) => `${type}=${total}`).join(', ');
  facts.push(`F13: Channel totals last 7d by type: ${channelTypeText || 'n/a'}. Public channels=${publicChannels}, private channels=${privateChannels}, private inactive=${privateInactive}. Event channels active=${eventChannelsActive}, event messages=${eventMessages}.`);

  const teamChannelText = Object.entries(teamChannelTotals).map(([team, total]) => `${team}=${total}`).join(', ');
  if (teamChannelText) {
    facts.push(`F13b: Team channel messages last 7d: ${teamChannelText}.`);
  }

  facts.push(`F14: Voice activity last 7d: total minutes=${voiceMinutes}, active voice users=${voiceActive}. Purchases last 7d=${purchasesCount7}.`);
  facts.push(`F15: Weekly snapshot avg recruits7d=${avgRecruits7d}, avg minReq=${avgMinReq}.`);
  facts.push(`F15b: Recruit retention proxy (recruits >=7d old still in server)=${formatPct(retentionRate)} (${retainedCount}/${retentionSample.length}${retentionSampled ? ', sampled' : ''}).`);
  facts.push(`F15c: Role changes last 7d (adds/removes) staff=${roleChangeCounts.staffAdds}/${roleChangeCounts.staffRemoves}, recruiters=${roleChangeCounts.recruiterAdds}/${roleChangeCounts.recruiterRemoves}, teams=${roleChangeCounts.teamAdds}/${roleChangeCounts.teamRemoves}.`);
  if (inviteCohortFacts) {
    facts.push(`F15d: ${inviteCohortFacts}`);
  }
  if (inviteCohortTop) {
    facts.push(`F15e: Top invite cohorts by invite→recruit: ${inviteCohortTop}.`);
  }
  if (inviteCohortBottom) {
    facts.push(`F15f: Bottom invite cohorts by invite→recruit: ${inviteCohortBottom}.`);
  }

  const commandRows = await db.all(
    'SELECT command_name, SUM(count) as total FROM analytics_command_usage WHERE guild_id = ? AND day >= ? GROUP BY command_name ORDER BY total DESC LIMIT 8',
    guildId,
    day7
  );
  if (commandRows.length) {
    const cmdText = commandRows.map(r => `${r.command_name}=${r.total}`).join(', ');
    facts.push(`F16: Top command usage last 7d: ${cmdText}.`);
  }

  return {
    facts,
    meta: {
      guildName: guild.name,
      timeframe: `Last 14 days (focus: last 7d vs previous 7d)`
    }
  };
}

function buildPrompt({ facts, guides, meta }) {
  const factBlock = facts.map(f => `- ${f}`).join('\n');
  return `You are the clan analytics reviewer. Use ONLY the facts and guides provided.\n\nGOAL: Provide a deep, structured diagnosis of activity/inactivity, structural issues, recruitment/verification health, and role/team balance.\n\nRULES:\n- Issues only. Do NOT provide fixes, action steps, or suggestions.\n- Use common sense based on facts. If data is missing, say so.\n- Cite facts by their IDs (F1, F2, etc.) in each issue.\n- Consider private/public channel structure, role activity, and team balance.\n\nFACTS (${meta.timeframe}, ${meta.guildName}):\n${factBlock}\n\nGUIDES (selected excerpts):\n${guides}\n\nOUTPUT FORMAT (Markdown):\n# Executive Summary\n# Key Issues (bullets with severity and facts)\n# Structural & Role Risks\n# Recruitment & Verification Signals\n# Channel & Engagement Signals\n# Inactive Cohorts\n# Evidence (facts used)\n\nRemember: issues only, no recommendations.`;
}

async function callGemini({ apiKey, prompt, model = 'gemini-1.5-flash' }) {
  const payload = JSON.stringify({
    contents: [
      { role: 'user', parts: [{ text: prompt }] }
    ],
    generationConfig: {
      temperature: 0.3,
      maxOutputTokens: 4096
    }
  });

  const options = {
    hostname: 'generativelanguage.googleapis.com',
    path: `/v1beta/models/${model}:generateContent?key=${apiKey}`,
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(payload)
    }
  };

  return new Promise((resolve, reject) => {
    const req = https.request(options, res => {
      let data = '';
      res.on('data', chunk => { data += chunk; });
      res.on('end', () => {
        if (res.statusCode < 200 || res.statusCode >= 300) {
          return reject(new Error(`Gemini API error: ${res.statusCode} ${data}`));
        }
        try {
          const json = JSON.parse(data);
          const text = json.candidates && json.candidates[0] && json.candidates[0].content && json.candidates[0].content.parts
            ? json.candidates[0].content.parts.map(p => p.text || '').join('')
            : '';
          resolve(text || 'No response content.');
        } catch (e) {
          reject(e);
        }
      });
    });
    req.setTimeout(GEMINI_REQUEST_TIMEOUT_MS, () => {
      req.destroy(new Error('Gemini request timed out.'));
    });
    req.on('error', reject);
    req.write(payload);
    req.end();
  });
}

async function runReview({ guild, channelId, requesterId, force = false }) {
  clearStaleReview();
  if (reviewRunning) {
    if (reviewSource === 'scheduler' && requesterId !== 'scheduler') {
      return { ok: false, reason: 'A scheduled AI review is currently running in the background. Please try again in 10-15 minutes.' };
    }
    return { ok: false, reason: 'Review already running.' };
  }
  reviewRunning = true;
  reviewStartedAt = Date.now();
  reviewSource = requesterId || 'manual';
  try {
    const apiKey = process.env.GEMINI_API_KEY ? process.env.GEMINI_API_KEY.trim() : null;
    if (!apiKey) return { ok: false, reason: 'GEMINI_API_KEY missing.' };

    const rawGuides = await loadGuides();
    const { facts, meta } = await collectFacts({ guild });
    const guides = await selectGuideChunksSemantic({
      guideText: rawGuides,
      facts,
      apiKey
    });
    const prompt = buildPrompt({ facts, guides, meta });

    const model = process.env.AI_REVIEW_MODEL || 'gemini-1.5-flash';
    const reportText = await callGemini({ apiKey, prompt, model });

    const channel = channelId
      ? (guild.channels.cache.get(channelId) || await guild.channels.fetch(channelId).catch(() => null))
      : null;

    if (channel && channel.send) {
      const header = `**AI Review — ${new Date().toUTCString()}**\nAdvisory only. Issues listed without recommendations.`;
      const chunks = splitMessage(`${header}\n\n${reportText}`);
      for (const chunk of chunks) {
        await channel.send(chunk).catch(() => { });
      }
    }

    await db.run(
      'INSERT INTO analytics_ai_reports (created_at, guild_id, channel_id, summary, full_report, facts_json, model) VALUES (?, ?, ?, ?, ?, ?, ?)',
      Date.now(),
      guild.id,
      channelId || '',
      reportText.slice(0, 800),
      reportText,
      JSON.stringify(facts),
      model
    );

    await db.run('INSERT OR REPLACE INTO system_events (key, timestamp) VALUES (?, ?)', 'ai_review_last_run', Date.now());

    return { ok: true, reportText };
  } catch (e) {
    return { ok: false, reason: e.message || 'AI review failed.' };
  } finally {
    reviewRunning = false;
    reviewStartedAt = 0;
    reviewSource = null;
  }
}

async function maybeRunScheduledReview({ client }) {
  clearStaleReview();
  if (reviewRunning) return;
  const last = await db.get('SELECT timestamp FROM system_events WHERE key = ?', 'ai_review_last_run');
  const lastTs = last ? last.timestamp : 0;
  if (Date.now() - lastTs < REVIEW_INTERVAL_MS) return;

  const guildId = process.env.GUILD_ID || client.guilds.cache.first()?.id;
  const guild = guildId ? await client.guilds.fetch(guildId).catch(() => null) : null;
  if (!guild) return;

  const channelId = process.env.AI_REVIEW_CHANNEL_ID || (CHANNELS && CHANNELS.AI_REVIEW);
  if (!channelId) return;

  await runReview({ guild, channelId, requesterId: 'scheduler' });
}

module.exports = {
  runReview,
  maybeRunScheduledReview
};

const { ROLE_IDS } = require('../constants');
const { promoteMember } = require('./promote');
const { resolveGuildId } = require('./guild');
const { withTransaction } = require('./transactions');

function parseRookieNickname(rawName) {
  if (!rawName) return { base: null, points: null };
  const s = String(rawName);
  const trimmed = s.length > 128 ? s.slice(0, 128) : s;
  
  // Match pattern: "name 0/2" or "name | REGION 0/2"
  // The points pattern is always "X/2" at the end
  const pointsPattern = /\s+(\d+(?:\.\d+)?)\s*\/\s*2\s*$/;
  const match = trimmed.match(pointsPattern);
  
  if (!match) {
    // No valid points found
    // Check if this is a malformed nickname like "0/2 | wapberry 2/10" or "testing123 | EU 0/2 1/10"
    // Pattern: look for " | " and extract either:
    //   - What comes before the pipe if it looks like a name (no slashes)
    //   - What comes after the pipe and before any point patterns
    const pipeIndex = trimmed.indexOf(' | ');
    if (pipeIndex > 0) {
      const beforePipe = trimmed.slice(0, pipeIndex).trim();
      const afterPipe = trimmed.slice(pipeIndex + 3).trim(); // +3 for " | "
      
      // If the part before the pipe doesn't contain a slash, it's likely the actual name
      if (!beforePipe.includes('/')) {
        return { base: beforePipe, points: null };
      }
      
      // Otherwise, try to extract the name from after the pipe
      // Remove region tags (2-3 capital letters) and any point patterns
      let nameOnly = afterPipe
        .replace(/^[A-Z]{2,3}\s+/, '') // Remove leading region tag like "EU "
        .replace(/\s+\d+(?:\.\d+)?\/\d+.*$/, '').trim(); // Remove point patterns
      
      if (nameOnly) {
        return { base: nameOnly, points: null };
      }
    }
    
    return { base: trimmed.trim() || trimmed, points: null };
  }
  
  // Extract points value
  const pointsStr = match[1];
  const points = parseStrictPointToken(pointsStr);
  
  if (!Number.isFinite(points)) {
    return { base: trimmed.trim() || trimmed, points: null };
  }
  
  // Remove the points suffix to get the base name
  // Also strip any trailing " | REGION" pattern if present
  let base = trimmed.slice(0, match.index).trim();
  
  // If there's a " | REGION" pattern before the points, remove it too
  const regionPattern = /\s*\|\s*[A-Z]{2,3}\s*$/;
  base = base.replace(regionPattern, '').trim();
  
  return { base: base || trimmed.trim() || trimmed, points: points };
}

function parseStrictPointToken(token) {
  if (!token) return null;
  const raw = String(token).trim();
  // Accept only plain decimal forms (e.g. 9, 9.5, 10) and reject scientific notation.
  if (!/^\d{1,2}(?:\.\d{1,2})?$/.test(raw)) return null;
  const value = Number(raw);
  if (!Number.isFinite(value)) return null;
  if (value < 0 || value > 2) return null;
  return value;
}

function formatPoints(value) {
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded).replace(/\.0$/, '');
}

async function retrySetNickname(member, nickname, opts = {}) {
  if (!member || !nickname) return false;
  const delays = Array.isArray(opts.delaysMs) ? opts.delaysMs : [0, 1000, 2000];
  for (let i = 0; i < delays.length; i++) {
    const delay = delays[i];
    if (delay > 0) {
      await new Promise(resolve => setTimeout(resolve, delay));
    }
    try {
      await member.setNickname(nickname);
      return true;
    } catch (e) {
      if (i === delays.length - 1) {
        console.error('Failed to update rookie nickname', { memberId: member.id, error: e });
        return false;
      }
    }
  }
  return false;
}

async function getLinkedPoints({ db, member, guild, guildId }) {
  if (!db || !member) return { points: 0, updatedAt: null, baseName: null, source: 'none' };
  const resolvedGuildId = resolveGuildId(guildId || guild || member.guild);
  try {
    const row = await db.get(
      'SELECT points, updated_at FROM rookie_points WHERE guild_id = ? AND member_id = ?',
      resolvedGuildId,
      member.id
    );
    if (row && Number.isFinite(Number(row.points))) {
      const points = Number(row.points);
      const baseName = parseRookieNickname(member.nickname || member.user.username).base || member.user.username;

      return {
        points,
        updatedAt: row.updated_at || null,
        baseName,
        source: 'db'
      };
    }
  } catch (e) {
    console.error('Failed to load rookie points:', e);
  }

  const parsed = parseRookieNickname(member.nickname || member.user.username);
  return { points: 0, updatedAt: null, baseName: parsed.base || member.user.username, source: 'none' };
}

async function applyPostPointEffects({ db, member, guild, verifierId, points }) {
  const clamped = Math.max(0, Math.min(2, points));
  if (clamped >= 2) {
    const promotion = await promoteMember({ member, db, guild, verifierId });
    return {
      points: clamped,
      promoted: !!(promotion && promotion.promoted),
      teamName: promotion ? promotion.teamName : undefined,
      teamEmoji: promotion ? promotion.teamEmoji : undefined,
      promotionError: promotion && promotion.promoted === false ? promotion.error : null
    };
  }

  if (!member.manageable) {
    return { points: clamped, promoted: false, nicknameUpdated: false, skippedNickname: true };
  }

  // Try to parse the existing nickname to extract the base name
  const parsed = parseRookieNickname(member.nickname || member.user.username);
  // If we can't parse it (e.g., malformed), fall back to username
  const baseName = parsed.base || member.user.username;
  
  const nickname = `${baseName} ${formatPoints(clamped)}/2`;
  const nicknameUpdated = await retrySetNickname(member, nickname);

  return { points: clamped, promoted: false, nicknameUpdated };
}

async function setLinkedPoints({ db, member, points, guild, verifierId }) {
  if (!db || !member) return { points: 0, promoted: false };
  const resolvedGuildId = resolveGuildId(guild || member.guild);
  if (!member.roles || !member.roles.cache || !member.roles.cache.has(ROLE_IDS.ROOKIE)) {
    return { points: 0, promoted: false, skipped: true };
  }

  const clamped = Math.max(0, Math.min(2, points));
  const now = Date.now();

  await withTransaction(db, async (tx) => {
    await tx.run(
      'INSERT OR IGNORE INTO rookie_points (guild_id, member_id, points, updated_at) VALUES (?, ?, 0, ?)',
      resolvedGuildId,
      member.id,
      now
    );
    await tx.run(
      'UPDATE rookie_points SET points = ?, updated_at = ? WHERE guild_id = ? AND member_id = ?',
      clamped,
      now,
      resolvedGuildId,
      member.id
    );
  });

  return applyPostPointEffects({ db, member, guild, verifierId, points: clamped });
}

async function addRookiePoints({ db, member, delta, guild, verifierId }) {
  if (!db || !member) return { points: 0, promoted: false, previousPoints: 0 };
  const resolvedGuildId = resolveGuildId(guild || member.guild);
  const safeDelta = Number.isFinite(delta) ? delta : 0;
  let previousPoints = 0;
  let nextPoints = 0;
  await withTransaction(db, async (tx) => {
    const now = Date.now();
    await tx.run(
      'INSERT OR IGNORE INTO rookie_points (guild_id, member_id, points, updated_at) VALUES (?, ?, 0, ?)',
      resolvedGuildId,
      member.id,
      now
    );

    const prevRow = await tx.get(
      'SELECT points FROM rookie_points WHERE guild_id = ? AND member_id = ?',
      resolvedGuildId,
      member.id
    );
    previousPoints = prevRow && Number.isFinite(Number(prevRow.points)) ? Number(prevRow.points) : 0;

    await tx.run(
      'UPDATE rookie_points SET points = MIN(2, MAX(0, points + ?)), updated_at = ? WHERE guild_id = ? AND member_id = ?',
      safeDelta,
      now,
      resolvedGuildId,
      member.id
    );

    const nextRow = await tx.get(
      'SELECT points FROM rookie_points WHERE guild_id = ? AND member_id = ?',
      resolvedGuildId,
      member.id
    );
    nextPoints = nextRow && Number.isFinite(Number(nextRow.points)) ? Number(nextRow.points) : 0;
  });

  const result = await applyPostPointEffects({ db, member, guild, verifierId, points: nextPoints });
  return { ...result, previousPoints };
}

module.exports = {
  addRookiePoints,
  formatPoints,
  getLinkedPoints,
  parseRookieNickname,
  setLinkedPoints
};

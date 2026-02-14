const { ROLE_IDS } = require('../constants');
const { promoteMember } = require('./promote');
const { resolveGuildId } = require('./guild');

function parseRookieNickname(rawName) {
  if (!rawName) return { base: null, points: null };
  const s = String(rawName);
  const trimmed = s.length > 128 ? s.slice(0, 128) : s;
  const idx = trimmed.lastIndexOf('/');
  if (idx === -1) return { base: trimmed.trim() || trimmed, points: null };

  const right = trimmed.slice(idx + 1).trim();
  if (right !== '10') return { base: trimmed.trim() || trimmed, points: null };

  const left = trimmed.slice(0, idx).trim();
  const parts = left.split(/\s+/);
  if (!parts.length) return { base: trimmed.trim() || trimmed, points: null };
  const maybePoints = parts[parts.length - 1];
  if (!/^-?\d+(?:\.\d+)?$/.test(maybePoints)) {
    return { base: trimmed.trim() || trimmed, points: null };
  }
  const points = Number(maybePoints);
  if (!Number.isFinite(points)) return { base: trimmed.trim() || trimmed, points: null };
  const base = parts.slice(0, -1).join(' ').trim();
  return { base: base || trimmed.trim() || trimmed, points: points };
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

async function setLinkedPoints({ db, member, points, guild, verifierId }) {
  if (!db || !member) return { points: 0, promoted: false };
  const resolvedGuildId = resolveGuildId(guild || member.guild);
  if (!member.roles || !member.roles.cache || !member.roles.cache.has(ROLE_IDS.ROOKIE)) {
    return { points: 0, promoted: false, skipped: true };
  }

  const clamped = Math.max(0, Math.min(10, points));
  const now = Date.now();

  try {
    await db.run(
      `INSERT INTO rookie_points (guild_id, member_id, points, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, member_id) DO UPDATE SET
         points = excluded.points,
         updated_at = excluded.updated_at`,
      resolvedGuildId,
      member.id,
      clamped,
      now
    );
  } catch (e) {
    console.error('Failed to persist rookie points:', e);
  }

  if (clamped >= 10) {
    const promotion = await promoteMember({ member, db, guild, verifierId });
    return { points: clamped, promoted: true, teamName: promotion.teamName };
  }

  if (!member.manageable) {
    return { points: clamped, promoted: false, nicknameUpdated: false, skippedNickname: true };
  }

  const baseName = parseRookieNickname(member.nickname || member.user.username).base || member.user.username;
  const nickname = `${baseName} ${formatPoints(clamped)}/10`;
  const nicknameUpdated = await retrySetNickname(member, nickname);

  return { points: clamped, promoted: false, nicknameUpdated };
}

async function addRookiePoints({ db, member, delta, guild, verifierId }) {
  if (!db || !member) return { points: 0, promoted: false, previousPoints: 0 };
  const resolvedGuildId = resolveGuildId(guild || member.guild);
  const numericDelta = Number(delta);
  if (!Number.isFinite(numericDelta) || numericDelta === 0) {
    const current = await getLinkedPoints({ db, member, guild: resolvedGuildId });
    return { points: current.points || 0, promoted: false, previousPoints: current.points || 0 };
  }

  const seedPoints = Math.max(0, Math.min(10, numericDelta));
  const now = Date.now();

  try {
    await db.run(
      `INSERT INTO rookie_points (guild_id, member_id, points, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, member_id) DO UPDATE SET
         points = MIN(10, MAX(0, rookie_points.points + excluded.points)),
         updated_at = excluded.updated_at`,
      resolvedGuildId,
      member.id,
      seedPoints,
      now
    );
  } catch (e) {
    console.error('Failed to atomically update rookie points:', e);
    const current = await getLinkedPoints({ db, member, guild: resolvedGuildId });
    return { points: current.points || 0, promoted: false, previousPoints: current.points || 0 };
  }

  const row = await db.get(
    'SELECT points FROM rookie_points WHERE guild_id = ? AND member_id = ?',
    resolvedGuildId,
    member.id
  ).catch(() => null);
  const points = row && Number.isFinite(Number(row.points))
    ? Number(row.points)
    : 0;
  const previousPoints = Math.max(0, Math.min(10, points - numericDelta));

  if (points >= 10) {
    const promotion = await promoteMember({ member, db, guild, verifierId });
    return { points: 10, promoted: true, teamName: promotion.teamName, previousPoints };
  }

  if (member.manageable) {
    const baseName = parseRookieNickname(member.nickname || member.user.username).base || member.user.username;
    const nickname = `${baseName} ${formatPoints(points)}/10`;
    await retrySetNickname(member, nickname);
  }

  return { points, promoted: false, previousPoints };
}

module.exports = {
  addRookiePoints,
  formatPoints,
  getLinkedPoints,
  parseRookieNickname,
  setLinkedPoints
};

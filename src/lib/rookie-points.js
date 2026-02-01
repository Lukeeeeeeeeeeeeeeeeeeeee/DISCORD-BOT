const { ROLE_IDS } = require('../constants');
const { promoteMember } = require('./promote');

function parseRookieNickname(rawName) {
  if (!rawName) return { base: null, points: null };
  const match = String(rawName).match(/^(.*?)(?:\s+(\d+(?:\.\d+)?)\s*\/\s*10)?$/i);
  if (!match) return { base: rawName, points: null };
  const base = (match[1] || '').trim();
  const points = match[2] != null ? Number(match[2]) : null;
  return { base: base || rawName, points: Number.isFinite(points) ? points : null };
}

function formatPoints(value) {
  const rounded = Math.round(value * 10) / 10;
  if (Number.isInteger(rounded)) return String(rounded);
  return String(rounded).replace(/\.0$/, '');
}

async function getLinkedPoints({ db, member }) {
  if (!db || !member) return { points: 0, updatedAt: null, baseName: null, source: 'none' };
  try {
    const row = await db.get('SELECT points, updated_at FROM rookie_points WHERE member_id = ?', member.id);
    if (row && Number.isFinite(Number(row.points))) {
      const points = Number(row.points);
      const baseName = parseRookieNickname(member.nickname || member.user.username).base || member.user.username;

      if (member.roles && member.roles.cache && member.roles.cache.has(ROLE_IDS.ROOKIE)) {
        const desiredNickname = `${baseName} ${formatPoints(points)}/10`;
        const currentNickname = member.nickname || member.user.username;
        if (currentNickname !== desiredNickname && typeof member.setNickname === 'function') {
          await member.setNickname(desiredNickname).catch(() => { });
        }
      }

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
  if (parsed.points != null) {
    const now = Date.now();
    try {
      await db.run(
        'INSERT OR REPLACE INTO rookie_points (member_id, points, updated_at) VALUES (?, ?, ?)',
        member.id,
        parsed.points,
        now
      );
    } catch (e) {
      console.error('Failed to sync rookie points from nickname:', e);
    }
    return { points: parsed.points, updatedAt: now, baseName: parsed.base || member.user.username, source: 'nickname' };
  }

  return { points: 0, updatedAt: null, baseName: parsed.base || member.user.username, source: 'none' };
}

async function setLinkedPoints({ db, member, points, guild, verifierId }) {
  if (!db || !member) return { points: 0, promoted: false };
  if (!member.roles || !member.roles.cache || !member.roles.cache.has(ROLE_IDS.ROOKIE)) {
    return { points: 0, promoted: false, skipped: true };
  }

  const clamped = Math.max(0, Math.min(10, points));
  const now = Date.now();

  try {
    await db.run(
      'INSERT OR REPLACE INTO rookie_points (member_id, points, updated_at) VALUES (?, ?, ?)',
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

  const baseName = parseRookieNickname(member.nickname || member.user.username).base || member.user.username;
  const nickname = `${baseName} ${formatPoints(clamped)}/10`;
  await member.setNickname(nickname).catch(() => { });

  return { points: clamped, promoted: false };
}

async function addRookiePoints({ db, member, delta, guild, verifierId }) {
  const current = await getLinkedPoints({ db, member });
  const next = (current.points || 0) + delta;
  const result = await setLinkedPoints({ db, member, points: next, guild, verifierId });
  return { ...result, previousPoints: current.points || 0 };
}

module.exports = {
  addRookiePoints,
  formatPoints,
  getLinkedPoints,
  parseRookieNickname,
  setLinkedPoints
};

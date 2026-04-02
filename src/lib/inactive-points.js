const { ROLE_IDS, ACTIVITY_CHECK } = require('../constants');
const { getRegionInfo } = require('./regions');

const INACTIVE_MAX = 2;

// ── Team ↔ Inactive role mapping ────────────────────────────────────
function getTeamToInactiveMap() {
    const src = ACTIVITY_CHECK && ACTIVITY_CHECK.TEAM_TO_INACTIVE_ROLE;
    if (!src || typeof src !== 'object') return {};
    return src;
}

function getInactiveToTeamMap() {
    const map = {};
    for (const [team, roleId] of Object.entries(getTeamToInactiveMap())) {
        if (roleId) map[String(roleId)] = team.toUpperCase();
    }
    return map;
}

// ── Helpers ──────────────────────────────────────────────────────────
function resolveInactiveTeam(member) {
    const inactiveToTeam = getInactiveToTeamMap();
    for (const [roleId, team] of Object.entries(inactiveToTeam)) {
        if (member.roles.cache.has(roleId)) return { team, inactiveRoleId: roleId };
    }
    return null;
}

function hasInactiveRole(member) {
    return resolveInactiveTeam(member) !== null;
}

function formatPoints(value) {
    const rounded = Math.round(value * 10) / 10;
    if (Number.isInteger(rounded)) return String(rounded);
    return String(rounded).replace(/\.0$/, '');
}

function parseInactiveNickname(rawName) {
    if (!rawName) return { base: null, points: null };
    const trimmed = String(rawName).trim();
    if (!trimmed) return { base: null, points: null };

    // Match "X/2 | something" or "X/2 something"
    const match = trimmed.match(/^(-?\d+(?:\.\d+)?)\s*\/\s*2\s*[|:]\s*/);
    if (match) {
        const points = Number(match[1]);
        const rest = trimmed.slice(match[0].length).trim();
        return {
            base: rest || trimmed,
            points: Number.isFinite(points) ? points : null
        };
    }

    // Also check for trailing "X/2"
    const trailingMatch = trimmed.match(/\s+(-?\d+(?:\.\d+)?)\s*\/\s*2\s*$/);
    if (trailingMatch) {
        const points = Number(trailingMatch[1]);
        const rest = trimmed.slice(0, trailingMatch.index).trim();
        return {
            base: rest || trimmed,
            points: Number.isFinite(points) ? points : null
        };
    }

    return { base: trimmed, points: null };
}

// ── IGN extraction ──────────────────────────────────────────────────
function extractIgn(raw) {
    if (!raw || !raw.trim()) return '';
    const parts = raw.split('|');
    return parts[parts.length - 1].trim();
}

// ── Region resolution ───────────────────────────────────────────────
function resolveRegionAbbr(team) {
    // Team keys (EU, NA, AS) match region abbreviations directly
    return team ? team.toUpperCase() : null;
}

// ── Retry nickname ──────────────────────────────────────────────────
async function retrySetNickname(member, nickname, delaysMs = [0, 1000, 2000]) {
    if (!member || !nickname) return false;
    for (let i = 0; i < delaysMs.length; i++) {
        const delay = delaysMs[i];
        if (delay > 0) await new Promise(resolve => setTimeout(resolve, delay));
        try {
            await member.setNickname(nickname);
            return true;
        } catch (e) {
            if (i === delaysMs.length - 1) {
                console.error('Failed to update inactive nickname', { memberId: member.id, error: e });
                return false;
            }
        }
    }
    return false;
}

// ── DB table creation ───────────────────────────────────────────────
async function ensureTable(db) {
    await db.run(`
    CREATE TABLE IF NOT EXISTS inactive_points (
      guild_id TEXT NOT NULL,
      member_id TEXT NOT NULL,
      points REAL NOT NULL DEFAULT 0,
      updated_at INTEGER,
      PRIMARY KEY (guild_id, member_id)
    )
  `);
}

// ── Get points ──────────────────────────────────────────────────────
async function getInactivePoints({ db, member, guild }) {
    if (!db || !member) return { points: 0, updatedAt: null };
    const guildId = guild ? (guild.id || guild) : (member.guild ? member.guild.id : null);
    try {
        await ensureTable(db);
        const row = await db.get(
            'SELECT points, updated_at FROM inactive_points WHERE guild_id = ? AND member_id = ?',
            guildId,
            member.id
        );
        if (row && Number.isFinite(Number(row.points))) {
            return { points: Number(row.points), updatedAt: row.updated_at || null };
        }
    } catch (e) {
        console.error('Failed to load inactive points:', e);
    }
    return { points: 0, updatedAt: null };
}

// ── Promote back to member ──────────────────────────────────────────
async function promoteInactiveToMember({ member }) {
    const resolved = resolveInactiveTeam(member);
    if (!resolved) return { promoted: false, error: 'No inactive role found' };

    const { team, inactiveRoleId } = resolved;
    const teamMemberRoleId = ROLE_IDS.TEAM_MEMBER && ROLE_IDS.TEAM_MEMBER[team]
        ? ROLE_IDS.TEAM_MEMBER[team] : null;
    const memberRoleId = ROLE_IDS.AUTO_PROMOTE_ROLE || ROLE_IDS.SOLACE;

    // Roles to remove: the inactive role
    const rolesToRemove = [inactiveRoleId].filter(Boolean);
    // Roles to add: member role + team member role
    const rolesToAdd = [memberRoleId, teamMemberRoleId].filter(Boolean);

    const removeList = rolesToRemove.filter(r => member.roles.cache.has(r));
    if (removeList.length > 0) {
        await member.roles.remove(removeList, 'Inactive promotion: remove inactive role').catch(err => {
            console.error('Failed to remove inactive role during promotion:', err);
        });
    }

    const addList = rolesToAdd.filter(r => !member.roles.cache.has(r));
    if (addList.length > 0) {
        await member.roles.add(addList, 'Inactive promotion: add member role').catch(err => {
            console.error('Failed to add member role during promotion:', err);
        });
    }

    // Update nickname: REGION | IGN
    const region = resolveRegionAbbr(team);
    const ign = extractIgn(member.nickname || member.user.globalName || member.user.username || '');
    if (region && ign) {
        let newNick = `${region} | ${ign}`;
        if (newNick.length > 32) {
            newNick = `${region} | ${ign.substring(0, 32 - region.length - 3)}`;
        }
        await retrySetNickname(member, newNick);
    }

    const teamInfo = getRegionInfo(team);
    const teamEmoji = teamInfo.emoji || '';
    const teamName = teamInfo.name || team || 'Unknown';
    return { promoted: true, team, teamName, teamEmoji };
}

// ── Add / set points ────────────────────────────────────────────────
async function addInactivePoints({ db, member, delta, guild, verifierId }) {
    if (!db || !member) return { points: 0, promoted: false, previousPoints: 0 };
    const guildId = guild ? (guild.id || guild) : (member.guild ? member.guild.id : null);
    const numericDelta = Number(delta);
    if (!Number.isFinite(numericDelta) || numericDelta === 0) {
        const current = await getInactivePoints({ db, member, guild });
        return { points: current.points, promoted: false, previousPoints: current.points };
    }

    await ensureTable(db);

    // Clamp: for add, seed between 0 and max; for remove, allow negative
    const seedPoints = numericDelta >= 0
        ? Math.min(INACTIVE_MAX, numericDelta)
        : Math.max(-INACTIVE_MAX, numericDelta);
    const now = Date.now();

    try {
        await db.run(
            `INSERT INTO inactive_points (guild_id, member_id, points, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(guild_id, member_id) DO UPDATE SET
         points = MIN(${INACTIVE_MAX}, MAX(0, inactive_points.points + excluded.points)),
         updated_at = excluded.updated_at`,
            guildId,
            member.id,
            seedPoints,
            now
        );
    } catch (e) {
        console.error('Failed to atomically update inactive points:', e);
        const current = await getInactivePoints({ db, member, guild });
        return { points: current.points, promoted: false, previousPoints: current.points };
    }

    const row = await db.get(
        'SELECT points FROM inactive_points WHERE guild_id = ? AND member_id = ?',
        guildId,
        member.id
    ).catch(() => null);
    const points = row && Number.isFinite(Number(row.points)) ? Number(row.points) : 0;
    const previousPoints = Math.max(0, Math.min(INACTIVE_MAX, points - numericDelta));

    // Auto-promote at 2/2
    if (points >= INACTIVE_MAX) {
        const promotion = await promoteInactiveToMember({ member, db, guild, verifierId });
        return { points: INACTIVE_MAX, promoted: true, teamName: promotion.teamName, previousPoints };
    }

    // Update nickname to show progress: X/2 | IGN
    if (member.manageable) {
        const parsed = parseInactiveNickname(member.nickname || member.user.globalName || member.user.username);
        const baseName = parsed.base || extractIgn(member.nickname || member.user.globalName || member.user.username || '') || member.user.username;
        const nickname = `${formatPoints(points)}/2 | ${baseName}`;
        const truncated = nickname.length > 32
            ? `${formatPoints(points)}/2 | ${baseName.substring(0, 32 - formatPoints(points).length - 5)}`
            : nickname;
        await retrySetNickname(member, truncated);
    }

    return { points, promoted: false, previousPoints };
}

module.exports = {
    addInactivePoints,
    getInactivePoints,
    formatPoints,
    parseInactiveNickname,
    hasInactiveRole,
    resolveInactiveTeam,
    INACTIVE_MAX
};

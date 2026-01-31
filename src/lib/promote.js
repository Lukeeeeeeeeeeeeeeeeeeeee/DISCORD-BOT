const { ROLE_IDS, REGION_INFO } = require('../constants');

function inferTeamFromOnboarding(member) {
    if (!member || !member.roles || !member.roles.cache) return null;
    if (ROLE_IDS.ONBOARDING_FIRE && member.roles.cache.has(ROLE_IDS.ONBOARDING_FIRE)) return 'EU';
    if (ROLE_IDS.ONBOARDING_WATER && member.roles.cache.has(ROLE_IDS.ONBOARDING_WATER)) return 'NA';
    if (ROLE_IDS.ONBOARDING_AIR && member.roles.cache.has(ROLE_IDS.ONBOARDING_AIR)) return 'AS';

    const list = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
    if (list[0] && member.roles.cache.has(list[0])) return 'EU';
    if (list[1] && member.roles.cache.has(list[1])) return 'NA';
    if (list[2] && member.roles.cache.has(list[2])) return 'AS';
    return null;
}

function inferTeamFromRegionTag(member) {
    const { REGION_ROLE_IDS } = require('../constants');
    if (!member || !member.roles || !member.roles.cache) return null;
    const keys = ['EU', 'NA', 'AS'];
    for (const key of keys) {
        const roleId = REGION_ROLE_IDS && REGION_ROLE_IDS[key] ? REGION_ROLE_IDS[key] : null;
        if (roleId && member.roles.cache.has(roleId)) return key;
    }
    return null;
}

function stripRookiePoints(nickname) {
    if (!nickname) return null;
    const trimmed = nickname.replace(/\s*\d+(?:\.\d+)?\s*\/\s*10\s*$/i, '').trim();
    return trimmed.length ? trimmed : null;
}

async function promoteMember({ member, db, guild, verifierId }) {
    const team = inferTeamFromOnboarding(member) || inferTeamFromRegionTag(member);
    const teamRoleId = ROLE_IDS.TEAM_MEMBER && team ? ROLE_IDS.TEAM_MEMBER[team] : null;

    // Roles to remove
    const rolesToRemove = [
        ROLE_IDS.ROOKIE,
        ROLE_IDS.UNVERIFIED,
        ROLE_IDS.ONBOARDING_FIRE,
        ROLE_IDS.ONBOARDING_WATER,
        ROLE_IDS.ONBOARDING_AIR,
        ...(ROLE_IDS.ONBOARDING || [])
    ].filter(Boolean);

    const uniqueRolesToRemove = [...new Set(rolesToRemove)];
    for (const roleId of uniqueRolesToRemove) {
        if (member.roles.cache.has(roleId)) {
            await member.roles.remove(roleId).catch(() => { });
        }
    }

    // Add Roles
    if (ROLE_IDS.SOLACE) await member.roles.add(ROLE_IDS.SOLACE).catch(() => { });
    if (teamRoleId) await member.roles.add(teamRoleId).catch(() => { });

    // Update Nickname
    const cleanedNickname = stripRookiePoints(member.nickname) || member.user.username;
    const teamEmoji = team === 'EU' ? '🔥' : (team === 'NA' ? '💧' : (team === 'AS' ? '🌬️' : ''));
    const newNick = `${cleanedNickname} ${teamEmoji}`.trim();
    if (newNick !== member.nickname) {
        await member.setNickname(newNick).catch(() => { });
    }

    // Record verification
    let recruiterId = null;
    try {
        const recruitRow = await db.get(
            'SELECT recruiter_id FROM recruits WHERE recruited_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 1',
            member.id
        );
        recruiterId = recruitRow ? recruitRow.recruiter_id : null;
    } catch (e) { }

    try {
        await db.run(
            'INSERT OR REPLACE INTO verifications (recruited_id, recruiter_id, verified_at, verified_by) VALUES (?, ?, ?, ?)',
            member.id,
            recruiterId,
            Date.now(),
            verifierId
        );
    } catch (e) {
        console.error('Failed to record verification:', e);
    }

    // Recompute leaderboards
    try {
        const scheduler = require('../scheduler');
        await scheduler.recomputeLeaderboards(db, guild);
    } catch (e) { }

    const teamName = team && REGION_INFO && REGION_INFO[team] ? REGION_INFO[team].name : (team || 'Unknown');
    return { team, teamName, teamEmoji };
}

module.exports = { promoteMember, stripRookiePoints };

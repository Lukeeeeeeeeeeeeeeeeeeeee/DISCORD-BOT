const { ROLE_IDS } = require('../constants');
const { getRegionInfo } = require('./regions');

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
                console.error('Failed to update nickname after promotion', { memberId: member.id, error: e });
                return false;
            }
        }
    }
    return false;
}

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
    const guildId = guild ? guild.id : null;
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

    const uniqueRolesToRemove = new Set(rolesToRemove);
    const currentRoleIds = new Set(member.roles.cache.map(r => r.id));
    for (const roleId of uniqueRolesToRemove) {
        currentRoleIds.delete(roleId);
    }

    if (ROLE_IDS.SOLACE) currentRoleIds.add(ROLE_IDS.SOLACE);
    if (teamRoleId) currentRoleIds.add(teamRoleId);

    const finalRoleIds = Array.from(currentRoleIds).filter(id => id !== member.guild.id);
    await member.roles.set(finalRoleIds, 'Rookie promotion').catch(err => {
      console.error('Failed to update roles during rookie promotion:', err);
    });

    // Update Nickname
    const cleanedNickname = stripRookiePoints(member.nickname) || member.user.username;
    const teamInfo = getRegionInfo(team);
    const teamEmoji = teamInfo.emoji || '';
    const newNick = `${cleanedNickname} ${teamEmoji}`.trim();
    if (newNick !== member.nickname) {
        await retrySetNickname(member, newNick);
    }

    // Record verification
    let recruiterId = null;
    try {
        const recruitRow = await db.get(
            'SELECT recruiter_id FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 1',
            guildId,
            member.id
        );
        recruiterId = recruitRow ? recruitRow.recruiter_id : null;
    } catch (e) { void e; }

    try {
        await db.run(
            'INSERT OR REPLACE INTO verifications (guild_id, recruited_id, recruiter_id, verified_at, verified_by) VALUES (?, ?, ?, ?, ?)',
            guildId,
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
    } catch (e) { void e; }

    const teamName = getRegionInfo(team).name || (team || 'Unknown');
    return { team, teamName, teamEmoji };
}

module.exports = { promoteMember, stripRookiePoints };

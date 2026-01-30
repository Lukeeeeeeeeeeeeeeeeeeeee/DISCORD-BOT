const db = require('../db_async');
const { ROLE_IDS, REGION_INFO } = require('../constants');
const { hasModPlusPermissions } = require('../lib/recruiting-system');

function inferTeamFromOnboarding(member) {
    // Onboarding roles: Fire=EU, Water=NA, Air=AS
    if (!member || !member.roles || !member.roles.cache) return null;

    // Check using explicit role IDs
    if (ROLE_IDS.ONBOARDING_FIRE && member.roles.cache.has(ROLE_IDS.ONBOARDING_FIRE)) return 'EU';
    if (ROLE_IDS.ONBOARDING_WATER && member.roles.cache.has(ROLE_IDS.ONBOARDING_WATER)) return 'NA';
    if (ROLE_IDS.ONBOARDING_AIR && member.roles.cache.has(ROLE_IDS.ONBOARDING_AIR)) return 'AS';

    // Fallback to array indexing
    const list = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
    if (list[0] && member.roles.cache.has(list[0])) return 'EU';  // Fire
    if (list[1] && member.roles.cache.has(list[1])) return 'NA';  // Water
    if (list[2] && member.roles.cache.has(list[2])) return 'AS';  // Air
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
    // Remove X/10 pattern from end of nickname
    const trimmed = nickname.replace(/\s*\d+(?:\.\d+)?\s*\/\s*10\s*$/i, '').trim();
    return trimmed.length ? trimmed : null;
}

module.exports = {
    data: {
        name: 'rookie_promote',
        description: 'Instantly promote a rookie (MOD+ only, for events)'
    },
    async execute(interaction) {
        // MOD+ only
        if (!hasModPlusPermissions(interaction.member)) {
            return interaction.reply({ content: 'MOD+ only.', flags: 64 });
        }

        const targetUser = interaction.options.getUser('member');
        if (!targetUser) {
            return interaction.reply({ content: 'Please specify a member to promote.', flags: 64 });
        }

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            return interaction.reply({ content: 'That member is not in this server.', flags: 64 });
        }

        // Check if they're a rookie (optional - can promote non-rookies for events)
        const isRookie = targetMember.roles.cache.has(ROLE_IDS.ROOKIE);

        // Determine team from onboarding role or region tag
        const team = inferTeamFromOnboarding(targetMember) || inferTeamFromRegionTag(targetMember);
        const teamRoleId = ROLE_IDS.TEAM_MEMBER && team ? ROLE_IDS.TEAM_MEMBER[team] : null;

        // Roles to remove: Rookie, Unverified, all Onboarding roles
        const rolesToRemove = [
            ROLE_IDS.ROOKIE,
            ROLE_IDS.UNVERIFIED,
            ROLE_IDS.ONBOARDING_FIRE,
            ROLE_IDS.ONBOARDING_WATER,
            ROLE_IDS.ONBOARDING_AIR,
            ...(ROLE_IDS.ONBOARDING || [])
        ].filter(Boolean);

        // Remove duplicates
        const uniqueRolesToRemove = [...new Set(rolesToRemove)];

        for (const roleId of uniqueRolesToRemove) {
            if (targetMember.roles.cache.has(roleId)) {
                await targetMember.roles.remove(roleId).catch(() => { });
            }
        }

        // Add SOLACE role
        if (ROLE_IDS.SOLACE) {
            await targetMember.roles.add(ROLE_IDS.SOLACE).catch(() => { });
        }

        // Add team member role based on pathway
        if (teamRoleId) {
            await targetMember.roles.add(teamRoleId).catch(() => { });
        }

        // Remove /10 from nickname
        const cleanedNickname = stripRookiePoints(targetMember.nickname);
        if (cleanedNickname !== null && cleanedNickname !== targetMember.nickname) {
            await targetMember.setNickname(cleanedNickname).catch(() => { });
        }

        // Record verification in DB
        let recruiterId = null;
        try {
            const recruitRow = await db.get(
                'SELECT recruiter_id FROM recruits WHERE recruited_id = ? AND valid = 1 ORDER BY created_at DESC LIMIT 1',
                targetUser.id
            );
            recruiterId = recruitRow ? recruitRow.recruiter_id : null;
        } catch (e) {
            recruiterId = null;
        }

        try {
            await db.run(
                'INSERT OR REPLACE INTO verifications (recruited_id, recruiter_id, verified_at, verified_by) VALUES (?, ?, ?, ?)',
                targetUser.id,
                recruiterId,
                Date.now(),
                interaction.user.id
            );
        } catch (e) {
            console.error('Failed to record promotion verification:', e);
        }

        // Recompute leaderboards
        try {
            const scheduler = require('../scheduler');
            await scheduler.recomputeLeaderboards(db, interaction.guild);
        } catch (e) {
            void e;
        }

        const teamName = team && REGION_INFO && REGION_INFO[team] ? REGION_INFO[team].name : (team || 'Unknown');
        const teamLabel = teamRoleId ? ` Added ${teamName} member role.` : '';
        const rookieNote = isRookie ? '' : ' (Note: Member was not a rookie)';

        return interaction.reply({
            content: `✅ Instantly promoted ${targetUser.tag} to SOLACE.${teamLabel}${rookieNote}`
        });
    }
};

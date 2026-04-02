const db = require('../../db_async');
const { ROLE_IDS } = require('../../constants');
const { PermissionsBitField } = require('discord.js');
const { getRoleLevel } = require('../../lib/recruiting-system');
const { hasAdministrator } = require('../../lib/permissions');
const { addInactivePoints, formatPoints, hasInactiveRole, resolveInactiveTeam } = require('../../lib/inactive-points');
const { replyError } = require('../../lib/embeds');
const { logUnexpectedError } = require('../../lib/logger');

// ── Permission: Helper+ of SAME team, or MOD+ for any team ─────────
function getCallerTeam(member) {
    const teamMember = ROLE_IDS.TEAM_MEMBER;
    if (!teamMember || typeof teamMember !== 'object') return null;
    for (const [team, roleId] of Object.entries(teamMember)) {
        if (roleId && member.roles.cache.has(roleId)) return team.toUpperCase();
    }
    return null;
}

function canManageInactive(caller, targetTeam) {
    if (hasAdministrator(caller)) return true;
    const level = getRoleLevel(caller);
    // MOD+ (level >= 2) can manage any team
    if (level >= 2) return true;
    // Helper/Helper+ (level >= 1) can only manage their own team
    if (level >= 1) {
        const callerTeam = getCallerTeam(caller);
        return callerTeam && callerTeam === targetTeam;
    }
    return false;
}

module.exports = {
    data: { name: 'inactivepoints' },
    async execute(interaction) {
        if (!interaction.guild) {
            return replyError(interaction, 'This command can only be used in a server.');
        }

        const sub = interaction.options && typeof interaction.options.getSubcommand === 'function'
            ? interaction.options.getSubcommand()
            : 'add';

        if (sub !== 'add' && sub !== 'remove' && sub !== 'reset-all') {
            return replyError(interaction, 'Unsupported subcommand.', { flags: 64 });
        }

        // ── reset-all: admin only ───────────────────────────────────────
        if (sub === 'reset-all') {
            if (!hasAdministrator(interaction.member)) {
                return replyError(interaction, 'Administrator permission required for reset-all.', { flags: 64 });
            }

            await interaction.deferReply({ flags: 64 });
            const now = Date.now();
            let result = null;
            try {
                await db.run(`
          CREATE TABLE IF NOT EXISTS inactive_points (
            guild_id TEXT NOT NULL,
            member_id TEXT NOT NULL,
            points REAL NOT NULL DEFAULT 0,
            updated_at INTEGER,
            PRIMARY KEY (guild_id, member_id)
          )
        `);
                result = await db.run(
                    'UPDATE inactive_points SET points = 0, updated_at = ? WHERE guild_id = ?',
                    now,
                    interaction.guild.id
                );
            } catch (error) {
                const dispatchResult = await logUnexpectedError('command.inactivepoints.resetAll', error, {
                    command: 'inactivepoints',
                    guildId: interaction.guild ? interaction.guild.id : null,
                    actorId: interaction.user ? interaction.user.id : null
                });
                return interaction.editReply({
                    content: `Failed to reset inactive points.${dispatchResult && dispatchResult.supportId ? ` Support ID: ${dispatchResult.supportId}.` : ''}`
                });
            }

            const updatedRows = Number(result && Number.isFinite(result.changes) ? result.changes : 0);
            return interaction.editReply({
                content: `Reset inactive points to 0 for ${updatedRows} record(s).`
            });
        }

        // ── add / remove ────────────────────────────────────────────────
        const targetUser = interaction.options.getUser('member');
        const rawPoints = interaction.options.getNumber('points');

        if (!targetUser || !Number.isFinite(rawPoints)) {
            return replyError(interaction, 'Please provide a member and points value.', { flags: 64 });
        }

        if (rawPoints <= 0) {
            return replyError(interaction, 'Points must be greater than 0.', { flags: 64 });
        }

        await interaction.deferReply({ flags: 64 });

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            return replyError(interaction, 'That member is not in this server.');
        }

        // Verify target has an inactive role
        if (!hasInactiveRole(targetMember)) {
            return replyError(interaction, 'That member does not have an inactive role.');
        }

        // Resolve the target's team from their inactive role
        const resolved = resolveInactiveTeam(targetMember);
        if (!resolved) {
            return replyError(interaction, 'Could not determine that member\'s team from their inactive role.');
        }

        // Permission check: caller must be Helper+ of same team or MOD+
        if (!canManageInactive(interaction.member, resolved.team)) {
            const callerTeam = getCallerTeam(interaction.member);
            if (getRoleLevel(interaction.member) >= 1 && callerTeam && callerTeam !== resolved.team) {
                return replyError(interaction, `You can only manage inactive members from your own team (${callerTeam}). This member is on team ${resolved.team}.`);
            }
            return replyError(interaction, 'Helper+ required. You must be on the same team as the inactive member, or MOD+ for any team.');
        }

        // Bot hierarchy check
        const botMember = interaction.guild.members.me
            || await interaction.guild.members.fetch(interaction.client.user.id).catch(() => null);
        const canManageNicknames = botMember && botMember.permissions
            && botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames);
        if (!canManageNicknames) {
            return replyError(interaction, 'Bot lacks Manage Nicknames permission.');
        }

        if (botMember && botMember.roles && botMember.roles.highest && targetMember.roles && targetMember.roles.highest) {
            if (targetMember.roles.highest.position >= botMember.roles.highest.position) {
                return replyError(interaction, 'Cannot update that member: role hierarchy prevents changes.');
            }
        }

        const delta = sub === 'remove' ? -rawPoints : rawPoints;
        let result;
        try {
            result = await addInactivePoints({
                db,
                member: targetMember,
                delta,
                guild: interaction.guild,
                verifierId: interaction.user.id
            });
        } catch (error) {
            const dispatchResult = await logUnexpectedError('command.inactivepoints.addOrRemove', error, {
                command: 'inactivepoints',
                guildId: interaction.guild ? interaction.guild.id : null,
                actorId: interaction.user ? interaction.user.id : null,
                memberId: targetUser.id,
                delta
            });
            return interaction.editReply({
                content: `Failed to update inactive points.${dispatchResult && dispatchResult.supportId ? ` Support ID: ${dispatchResult.supportId}.` : ''}`
            });
        }

        if (result.promoted) {
            return interaction.editReply({
                content: `✅ ${targetUser.tag} has completed 2/2 events. Promoted back to **${result.teamName}** member!`
            });
        }

        return interaction.editReply({
            content: `Updated ${targetUser.tag} to ${formatPoints(result.points)}/2 inactive points.`
        });
    }
};

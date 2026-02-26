const { AttachmentBuilder } = require('discord.js');
const { GUILD_ID, ROLE_IDS, REGION_ROLE_IDS, ACTIVITY_CHECK, TESTING_USER_ID } = require('../constants');
const { replyError } = require('../lib/embeds');


// ── Target roles ────────────────────────────────────────────────────
const ROOKIE_ROLE_ID = ROLE_IDS.ROOKIE;           // 0/10 | IGN
const MEMBER_ROLE_ID = ROLE_IDS.AUTO_PROMOTE_ROLE; // REGION | IGN

// ── Region lookup (role-id → abbreviation) ──────────────────────────
function buildRegionLookup() {
    const map = new Map();
    if (REGION_ROLE_IDS && typeof REGION_ROLE_IDS === 'object') {
        for (const [abbr, roleId] of Object.entries(REGION_ROLE_IDS)) {
            if (roleId) map.set(String(roleId), abbr.toUpperCase());
        }
    }
    return map;
}
const REGION_BY_ROLE_ID = buildRegionLookup();

// ── Inactive role lookup ────────────────────────────────────────────
function buildInactiveRoleSet() {
    const ids = new Set();
    const map = ACTIVITY_CHECK && ACTIVITY_CHECK.TEAM_TO_INACTIVE_ROLE;
    if (map && typeof map === 'object') {
        for (const roleId of Object.values(map)) {
            if (roleId) ids.add(String(roleId));
        }
    }
    return ids;
}
const INACTIVE_ROLE_IDS = buildInactiveRoleSet();

// ── Owner gate ──────────────────────────────────────────────────────
function getOwnerIdSet() {
    const ids = new Set();
    if (TESTING_USER_ID) ids.add(String(TESTING_USER_ID));
    const envOwnerIds = [
        process.env.PATH_BALANCE_OWNER_ID,
        process.env.ACTIVITYCHECK_OWNER_ID,
        process.env.OWNER_ID,
        process.env.ANTINUKE_OWNER_ID
    ].map(v => (v == null ? '' : String(v).trim())).filter(Boolean);
    for (const id of envOwnerIds) ids.add(id);
    return ids;
}

// ── Helpers ─────────────────────────────────────────────────────────
function hasRole(member, roleId) {
    return Boolean(member && member.roles && member.roles.cache && roleId && member.roles.cache.has(roleId));
}

/**
 * Extract the IGN from a display string.
 * "EU | SomeName"       → "SomeName"
 * "0/2 | SomeName"      → "SomeName"
 * "SomeName"            → "SomeName"
 * "EU | Team X | Ghost" → "Ghost"   (last segment)
 */
function extractIgn(raw) {
    if (!raw || !raw.trim()) return '';
    const parts = raw.split('|');
    return parts[parts.length - 1].trim();
}

/**
 * Resolve a member's region abbreviation from their assigned region roles.
 * Returns null if no region role is found.
 */
function resolveRegion(member) {
    const found = [];
    for (const [roleId, abbr] of REGION_BY_ROLE_ID.entries()) {
        if (hasRole(member, roleId)) found.push(abbr);
    }
    if (found.length > 1) return found[0]; // multiple region roles — use first match
    return found[0] || null;
}

/**
 * Get the best current "source" name for IGN extraction.
 */
function getSourceName(member) {
    if (member.nickname) return member.nickname;
    if (member.user) {
        return member.user.globalName || member.user.username || '';
    }
    return '';
}

/**
 * Build the ideal nickname string for a member.
 * Returns { newNick, prefix, ign, skipReason } or skipReason if skipped.
 */
function computeNickname(member) {
    const isMember = hasRole(member, MEMBER_ROLE_ID);
    const isRookie = hasRole(member, ROOKIE_ROLE_ID);

    // Member takes priority over Rookie if they somehow have both roles.
    if (isMember) {
        const region = resolveRegion(member);
        if (!region) {
            return { skipReason: 'Member role but no region role' };
        }
        const ign = extractIgn(getSourceName(member));
        if (!ign) {
            return { skipReason: 'Could not determine IGN' };
        }
        const prefix = region;
        let newNick = `${prefix} | ${ign}`;
        // Discord limit: 32 characters
        if (newNick.length > 32) {
            const maxIgn = 32 - prefix.length - 3; // 3 = ' | '
            newNick = `${prefix} | ${ign.substring(0, maxIgn)}`;
        }
        return { newNick, prefix, ign, skipReason: null };
    }

    // Inactive members: anyone with an inactive team role → 0/2 | IGN
    const isInactive = INACTIVE_ROLE_IDS.size > 0 && Array.from(INACTIVE_ROLE_IDS).some(id => hasRole(member, id));
    if (isInactive) {
        const ign = extractIgn(getSourceName(member));
        if (!ign) {
            return { skipReason: 'Could not determine IGN' };
        }
        const prefix = '0/2';
        let newNick = `${prefix} | ${ign}`;
        if (newNick.length > 32) {
            const maxIgn = 32 - prefix.length - 3;
            newNick = `${prefix} | ${ign.substring(0, maxIgn)}`;
        }
        return { newNick, prefix, ign, skipReason: null };
    }

    if (isRookie) {
        const ign = extractIgn(getSourceName(member));
        if (!ign) {
            return { skipReason: 'Could not determine IGN' };
        }
        const prefix = '0/10';
        let newNick = `${prefix} | ${ign}`;
        if (newNick.length > 32) {
            const maxIgn = 32 - prefix.length - 3;
            newNick = `${prefix} | ${ign.substring(0, maxIgn)}`;
        }
        return { newNick, prefix, ign, skipReason: null };
    }

    return { skipReason: 'No target role (not Rookie or Member)' };
}

// ── Command ─────────────────────────────────────────────────────────
module.exports = {
    data: { name: 'fixnick' },
    async execute(interaction) {
        if (!interaction || !interaction.guild) {
            return replyError(interaction, 'This command can only be used inside a server.');
        }
        if (GUILD_ID && String(interaction.guild.id) !== String(GUILD_ID)) {
            return replyError(interaction, 'This bot is configured for a different guild.');
        }

        // Owner-only gate
        const ownerIds = getOwnerIdSet();
        const callerId = String(interaction.user && interaction.user.id);
        if (!ownerIds.has(callerId)) {
            return replyError(interaction, 'This one-time command is owner-only.');
        }

        const preview = interaction.options.getBoolean('preview') !== false; // default true

        await interaction.deferReply({ flags: 64 });

        // Fetch all guild members
        await interaction.guild.members.fetch().catch(() => null);
        const members = interaction.guild.members.cache
            .filter(m => m && m.user && !m.user.bot)
            .map(m => m);

        if (!members.length) {
            return interaction.editReply({ content: 'No non-bot members found in guild cache.' });
        }

        const planned = [];  // { member, oldNick, newNick, prefix, ign }
        const skipped = [];  // { member, reason }
        const unchanged = [];  // { member, nick }

        for (const member of members) {
            const result = computeNickname(member);

            if (result.skipReason) {
                skipped.push({ member, reason: result.skipReason });
                continue;
            }

            const currentNick = member.nickname || '';
            if ((currentNick || '').trim() === result.newNick.trim()) {
                unchanged.push({ member, nick: currentNick });
                continue;
            }

            planned.push({
                member,
                oldNick: currentNick || member.user.globalName || member.user.username,
                newNick: result.newNick,
                prefix: result.prefix,
                ign: result.ign
            });
        }

        // ── Build preview / result text ─────────────────────────────────
        const lines = [];
        lines.push(`=== FIXNICK ${preview ? 'PREVIEW' : 'RESULTS'} ===`);
        lines.push(`Total members scanned: ${members.length}`);
        lines.push(`Planned changes: ${planned.length}`);
        lines.push(`Already correct: ${unchanged.length}`);
        lines.push(`Skipped: ${skipped.length}`);
        lines.push('');

        // Planned changes
        if (planned.length) {
            lines.push('--- PLANNED CHANGES ---');
            for (const entry of planned) {
                const tag = entry.member.user.tag || entry.member.user.username;
                lines.push(`  ${tag} (${entry.member.id})`);
                lines.push(`    OLD: "${entry.oldNick}"`);
                lines.push(`    NEW: "${entry.newNick}"`);
            }
            lines.push('');
        }

        // Already correct
        if (unchanged.length) {
            lines.push(`--- ALREADY CORRECT (${unchanged.length}) ---`);
            for (const entry of unchanged) {
                const tag = entry.member.user.tag || entry.member.user.username;
                lines.push(`  ${tag}: "${entry.nick}"`);
            }
            lines.push('');
        }

        // Skipped
        if (skipped.length) {
            lines.push(`--- SKIPPED (${skipped.length}) ---`);
            for (const entry of skipped) {
                const tag = entry.member.user.tag || entry.member.user.username;
                lines.push(`  ${tag} (${entry.member.id}): ${entry.reason}`);
            }
            lines.push('');
        }

        // ── Preview mode: just send the file ────────────────────────────
        if (preview) {
            const buffer = Buffer.from(lines.join('\n'), 'utf-8');
            const attachment = new AttachmentBuilder(buffer, { name: 'fixnick_preview.txt' });
            return interaction.editReply({
                content: `**Preview**: ${planned.length} nickname(s) would be changed. ${unchanged.length} already correct, ${skipped.length} skipped.\nSee the attached file for full details.`,
                files: [attachment]
            });
        }

        // ── Live execution ──────────────────────────────────────────────
        const botMember = interaction.guild.members.me;
        let successCount = 0;
        let failCount = 0;
        const failures = [];

        for (const entry of planned) {
            // Skip members the bot can't rename due to role hierarchy
            if (botMember && entry.member.roles.highest.position >= botMember.roles.highest.position) {
                failCount++;
                failures.push({
                    tag: entry.member.user.tag || entry.member.user.username,
                    id: entry.member.id,
                    error: 'Role hierarchy higher than bot'
                });
                continue;
            }
            try {
                await entry.member.setNickname(entry.newNick, 'Automated /fixnick standardization');
                successCount++;
            } catch (err) {
                failCount++;
                failures.push({
                    tag: entry.member.user.tag || entry.member.user.username,
                    id: entry.member.id,
                    error: String(err && err.message ? err.message : err)
                });
            }
            // Rate-limit protection: 1 second cooldown between nickname changes
            await new Promise(r => setTimeout(r, 1000));
        }

        lines.push('--- EXECUTION SUMMARY ---');
        lines.push(`  Successful: ${successCount}`);
        lines.push(`  Failed: ${failCount}`);
        if (failures.length) {
            lines.push('');
            lines.push('--- FAILURES ---');
            for (const f of failures) {
                lines.push(`  ${f.tag} (${f.id}): ${f.error}`);
            }
        }

        const buffer = Buffer.from(lines.join('\n'), 'utf-8');
        const attachment = new AttachmentBuilder(buffer, { name: 'fixnick_results.txt' });
        return interaction.editReply({
            content: `**Done**: ${successCount} renamed, ${failCount} failed, ${unchanged.length} already correct, ${skipped.length} skipped.`,
            files: [attachment]
        });
    }
};

const db = require('../db_async');
const { ROLE_IDS } = require('../constants');
const { hasModPlusPermissions } = require('../lib/recruiting-system');
const { replyError } = require('../lib/embeds');

module.exports = {
    data: {
        name: 'rookie_promote',
        description: 'Verify and promote a rookie (MOD+ only)'
    },
    async execute(interaction) {
        if (!interaction.guild) {
            return replyError(interaction, 'This command can only be used in a server.');
        }

        // MOD+ only
        if (!hasModPlusPermissions(interaction.member)) {
            return replyError(interaction, 'MOD+ only.');
        }

        if (typeof interaction.deferReply === 'function') {
            await interaction.deferReply({ flags: 64 });
        }

        const targetUser = interaction.options.getUser('member');
        if (!targetUser) {
            return replyError(interaction, 'Please specify a member to promote.');
        }

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            return replyError(interaction, 'That member is not in this server.');
        }

        if (!targetMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
            return replyError(interaction, 'That member is not a rookie.');
        }

        const { promoteMember } = require('../lib/promote');
        const result = await promoteMember({
            member: targetMember,
            db,
            guild: interaction.guild,
            verifierId: interaction.user.id
        });

        const teamLabel = result.teamEmoji ? `${result.teamEmoji} ${result.teamName}` : result.teamName;
        if (interaction.editReply) {
            return interaction.editReply({ content: `✅ Verified ${targetUser.tag}.\nAdded ${teamLabel} member role.` });
        }
        return interaction.reply({ content: `✅ Verified ${targetUser.tag}.\nAdded ${teamLabel} member role.` });
    }
};

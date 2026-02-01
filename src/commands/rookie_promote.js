const db = require('../db_async');
const { ROLE_IDS } = require('../constants');
const { hasModPlusPermissions } = require('../lib/recruiting-system');

module.exports = {
    data: {
        name: 'rookie_promote',
        description: 'Verify and promote a rookie (MOD+ only)'
    },
    async execute(interaction) {
        if (!interaction.guild) {
            return interaction.reply({ content: 'This command can only be used in a server.' });
        }

        // MOD+ only
        if (!hasModPlusPermissions(interaction.member)) {
            return interaction.reply({ content: 'MOD+ only.' });
        }

        const targetUser = interaction.options.getUser('member');
        if (!targetUser) {
            return interaction.reply({ content: 'Please specify a member to promote.' });
        }

        const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
        if (!targetMember) {
            return interaction.reply({ content: 'That member is not in this server.' });
        }

        if (!targetMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
            return interaction.reply({ content: 'That member is not a rookie.' });
        }

        const { promoteMember } = require('../lib/promote');
        const result = await promoteMember({
            member: targetMember,
            db,
            guild: interaction.guild,
            verifierId: interaction.user.id
        });

        const teamLabel = result.teamEmoji ? `${result.teamEmoji} ${result.teamName}` : result.teamName;
        return interaction.reply({
            content: `✅ Verified ${targetUser.tag}.\nAdded ${teamLabel} member role.`
        });
    }
};

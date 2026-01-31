const db = require('../db_async');
const { ROLE_IDS } = require('../constants');
const { hasModPlusPermissions } = require('../lib/recruiting-system');

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

        const isRookie = targetMember.roles.cache.has(ROLE_IDS.ROOKIE);

        const { promoteMember } = require('../lib/promote');
        const result = await promoteMember({
            member: targetMember,
            db,
            guild: interaction.guild,
            verifierId: interaction.user.id
        });

        const rookieNote = isRookie ? '' : ' (Note: Member was not a rookie)';
        return interaction.reply({
            content: `✅ Instantly promoted ${targetUser.tag} to SOLACE.\nAdded ${result.teamEmoji} ${result.teamName} member role.${rookieNote}`
        });
    }
};

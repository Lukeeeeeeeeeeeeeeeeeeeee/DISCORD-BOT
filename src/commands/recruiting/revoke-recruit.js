const { hasAdminOrStaffPermissions } = require('../../lib/permissions');
const { replyError } = require('../../lib/embeds');
const { createResponder } = require('../../lib/respond');
const { resolveGuildId } = require('../../lib/guild');
const { revokeRecruit } = require('../../services/recruiting/revoke-recruit-service');
const defaultDb = require('../../db_async');

module.exports = {
  data: {
    name: 'revoke-recruit',
    description: 'Revoke a recruit and update invite channels'
  },
  async execute(interaction, _client, db) {
    if (!hasAdminOrStaffPermissions(interaction.member)) {
      return replyError(interaction, 'Admin/Staff only.');
    }

    const { respond, defer } = createResponder(interaction, { defaultFlags: 64, allowedMentions: { parse: [] } });
    await defer();

    const member = interaction.options.getUser('member');
    const reason = interaction.options.getString('reason') || 'Recruit revoked by staff';

    const dbHandle = db || defaultDb;
    const guildId = resolveGuildId(interaction.guild || interaction);

    try {
      const errResult = await revokeRecruit({ interaction, db: dbHandle, guildId, member, reason });
      if (errResult) return respond(errResult);
      return respond({ content: `Successfully revoked recruit status for ${member.tag}.` });
    } catch (error) {
      console.error('Failed to revoke recruit:', error);
      return replyError(interaction, 'Failed to revoke recruit. Please try again later.');
    }
  }
};

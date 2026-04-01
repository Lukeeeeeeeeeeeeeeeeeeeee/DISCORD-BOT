const { MessageFlags } = require('discord.js');
const defaultDb = require('../../db_async');
const { ROLE_IDS } = require('../../constants');
const { hasModPlusPermissions } = require('../../lib/recruiting-system');
const { promoteMember } = require('../../lib/promote');
const { replyError } = require('../../lib/embeds');

async function execute(interaction, _client, dbHandle = null) {
  const db = dbHandle || defaultDb;
  if (!interaction.guild) {
    return replyError(interaction, 'This command can only be used in a server.');
  }

  if (!hasModPlusPermissions(interaction.member)) {
    return replyError(interaction, 'MOD+ only.');
  }

  if (typeof interaction.deferReply === 'function') {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
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

  const result = await promoteMember({
    member: targetMember,
    db,
    guild: interaction.guild,
    verifierId: interaction.user.id
  });

  if (!result || result.promoted === false) {
    const message = result && result.error
      ? result.error
      : 'Failed to promote member.';
    if (interaction.editReply) {
      return interaction.editReply({ content: message });
    }
    return interaction.reply({ content: message, flags: MessageFlags.Ephemeral });
  }

  const teamLabel = result.teamEmoji ? `${result.teamEmoji} ${result.teamName}` : result.teamName;
  if (interaction.editReply) {
    return interaction.editReply({ content: `Verified ${targetUser.tag}.\nAdded ${teamLabel} member role.` });
  }
  return interaction.reply({ content: `Verified ${targetUser.tag}.\nAdded ${teamLabel} member role.` });
}

module.exports = { execute };

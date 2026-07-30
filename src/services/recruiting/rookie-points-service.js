const defaultDb = require('../../db_async');
const { ROLE_IDS } = require('../../constants');
const { PermissionsBitField } = require('discord.js');
const { hasModPlusPermissions } = require('../../lib/recruiting-system');
const { addRookiePoints, formatPoints } = require('../../lib/rookie-points');
const { replyError } = require('../../lib/embeds');

async function execute(interaction, _client, dbHandle = null) {
  const db = dbHandle || defaultDb;
  if (!hasModPlusPermissions(interaction.member)) {
    return replyError(interaction, 'MOD+ only.', { flags: 64 });
  }

  const sub = interaction.options && typeof interaction.options.getSubcommand === 'function'
    ? interaction.options.getSubcommand()
    : 'add';

  if (sub !== 'add' && sub !== 'remove') {
    return replyError(interaction, 'Unsupported subcommand.', { flags: 64 });
  }

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

  const botMember = interaction.guild.members.me
    || await interaction.guild.members.fetch(interaction.client.user.id).catch(() => null);
  const canManageNicknames = botMember && botMember.permissions
    && botMember.permissions.has(PermissionsBitField.Flags.ManageNicknames);
  if (!canManageNicknames) {
    return replyError(interaction, 'Bot lacks Manage Nicknames permission. Please grant it before updating points.');
  }

  if (botMember && botMember.roles && botMember.roles.highest && targetMember.roles && targetMember.roles.highest) {
    if (targetMember.roles.highest.position >= botMember.roles.highest.position) {
      return replyError(interaction, 'Cannot update that member: role hierarchy prevents nickname changes.');
    }
  }

  if (!targetMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
    return replyError(interaction, 'That member is not a rookie.');
  }

  const delta = sub === 'remove' ? -rawPoints : rawPoints;
  const result = await addRookiePoints({
    db,
    member: targetMember,
    delta,
    guild: interaction.guild,
    verifierId: interaction.user.id
  });

  if (result.promoted) {
    return interaction.editReply({
      content: `Updated ${targetUser.tag} to ${formatPoints(result.points)} points. Promoted to ${result.teamName}.`
    });
  }

  if (result.promotionError) {
    return interaction.editReply({
      content: `Updated ${targetUser.tag} to ${formatPoints(result.points)} points, but promotion failed: ${result.promotionError}`
    });
  }

  return interaction.editReply({
    content: `Updated ${targetUser.tag} to ${formatPoints(result.points)} points.`
  });
}

module.exports = { execute };

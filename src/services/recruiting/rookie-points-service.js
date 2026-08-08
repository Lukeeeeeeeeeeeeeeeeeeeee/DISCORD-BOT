const defaultDb = require('../../db_async');
const { ROLE_IDS } = require('../../constants');
const { PermissionsBitField } = require('discord.js');
const { hasModPlusPermissions } = require('../../lib/recruiting-system');
const { addRookiePoints, formatPoints } = require('../../lib/rookie-points');
const { replyError } = require('../../lib/embeds');

/**
 * Check if member can add rookie points
 * Helper- can only ADD rookie points, not remove
 * MOD+ can add or remove
 */
function canManageRookiePoints(member, isRemove = false) {
  // Check if MOD+ (can do anything)
  if (hasModPlusPermissions(member)) return true;
  
  // Check if Helper- (can only add, not remove)
  if (!isRemove && member.roles && member.roles.cache && ROLE_IDS.HELPER_MINUS) {
    if (member.roles.cache.has(ROLE_IDS.HELPER_MINUS)) return true;
  }
  
  return false;
}

async function execute(interaction, _client, dbHandle = null) {
  const db = dbHandle || defaultDb;
  
  const sub = interaction.options && typeof interaction.options.getSubcommand === 'function'
    ? interaction.options.getSubcommand()
    : 'add';

  if (sub !== 'add' && sub !== 'remove') {
    return replyError(interaction, 'Unsupported subcommand.', { flags: 64 });
  }

  const isRemove = sub === 'remove';
  
  // Permission check: Helper- can only add, MOD+ can add or remove
  if (!canManageRookiePoints(interaction.member, isRemove)) {
    if (isRemove) {
      return replyError(interaction, 'MOD+ required to remove rookie points.', { flags: 64 });
    }
    return replyError(interaction, 'Helper- or MOD+ required to add rookie points.', { flags: 64 });
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
      content: `Updated ${targetUser.tag} to 2/2 points. Promoted to ${result.teamName}.`
    });
  }

  if (result.promotionError) {
    return interaction.editReply({
      content: `Updated ${targetUser.tag} to ${formatPoints(result.points)}/2 points, but promotion failed: ${result.promotionError}`
    });
  }

  return interaction.editReply({
    content: `Updated ${targetUser.tag} to ${formatPoints(result.points)}/2 points.`
  });
}

module.exports = { execute };

const db = require('../../db_async');
const { ROLE_IDS } = require('../../constants');
const { PermissionsBitField } = require('discord.js');
const { hasModPlusPermissions } = require('../../lib/recruiting-system');
const { addRookiePoints, formatPoints } = require('../../lib/rookie-points');
const { replyError } = require('../../lib/embeds');
const { hasAdministrator } = require('../../lib/permissions');

const { SlashCommandBuilder } = require('discord.js');

module.exports = {
  data: new SlashCommandBuilder()
    .setName('rookiepoints')
    .setDescription('Manage rookie points (MOD+ only)')
    .addSubcommand(subcommand =>
      subcommand
        .setName('add')
        .setDescription('Add points to a rookie')
        .addUserOption(option => option.setName('member').setDescription('The rookie').setRequired(true))
        .addNumberOption(option => option.setName('points').setDescription('Points to add').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('remove')
        .setDescription('Remove points from a rookie')
        .addUserOption(option => option.setName('member').setDescription('The rookie').setRequired(true))
        .addNumberOption(option => option.setName('points').setDescription('Points to remove').setRequired(true))
    )
    .addSubcommand(subcommand =>
      subcommand
        .setName('reset-all')
        .setDescription('Reset all rookie points to 0 (admin only)')
    ),
  async execute(interaction) {
    if (!hasModPlusPermissions(interaction.member)) {
      return replyError(interaction, 'MOD+ only.', { flags: 64 });
    }

    const sub = interaction.options && typeof interaction.options.getSubcommand === 'function'
      ? interaction.options.getSubcommand()
      : 'add';

    if (sub !== 'add' && sub !== 'remove' && sub !== 'reset-all') {
      return replyError(interaction, 'Unsupported subcommand.', { flags: 64 });
    }

    if (sub === 'reset-all') {
      if (!interaction.guild || !interaction.guild.id) {
        return replyError(interaction, 'This command can only be used in a server.', { flags: 64 });
      }
      if (!hasAdministrator(interaction.member)) {
        return replyError(interaction, 'Administrator permission required for reset-all.', { flags: 64 });
      }

      await interaction.deferReply({ flags: 64 });
      const now = Date.now();
      let result = null;
      try {
        result = await db.run(
          'UPDATE rookie_points SET points = 0, updated_at = ? WHERE guild_id = ?',
          now,
          interaction.guild.id
        );
      } catch (error) {
        const message = String(error && error.message ? error.message : '').toLowerCase();
        if (!message.includes('no such column: guild_id')) {
          throw error;
        }
        // Legacy schema fallback.
        result = await db.run('UPDATE rookie_points SET points = 0, updated_at = ?', now);
      }

      const updatedRows = Number(result && Number.isFinite(result.changes) ? result.changes : 0);
      return interaction.editReply({
        content: `Reset rookie points to 0 for ${updatedRows} record(s).`
      });
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

    return interaction.editReply({
      content: `Updated ${targetUser.tag} to ${formatPoints(result.points)} points.`
    });
  }
};

const { EmbedBuilder, PermissionsBitField, ChannelType, MessageFlags } = require('discord.js');
const { ensureCommandAccess } = require('../lib/command-auth');
const { buildErrorEmbed } = require('../lib/embeds');
const {
  normalizeEmojiKey,
  roleIsAssignable,
  syncExistingReactionRoleUsers,
  upsertReactionRole
} = require('../services/reaction-role-service');

module.exports = {
  data: {
    name: 'reactionrole',
    description: 'Give a role when someone reacts to a specific message.',
    options: [
      {
        name: 'channel',
        description: 'Channel containing the message',
        type: 7,
        required: true
      },
      {
        name: 'message_id',
        description: 'ID of the message users should react to',
        type: 3,
        required: true
      },
      {
        name: 'emoji',
        description: 'Emoji to watch, for example ✅ or a custom emoji',
        type: 3,
        required: true
      },
      {
        name: 'role',
        description: 'Role to give when users react',
        type: 8,
        required: true
      }
    ]
  },

  async execute(interaction, _client, db) {
    const allowed = await ensureCommandAccess(interaction, {
      allowStaff: false,
      deniedMessage: 'Administrator permission required to configure reaction roles.',
      flags: MessageFlags.Ephemeral
    });
    if (!allowed) return null;

    const channel = interaction.options.getChannel('channel');
    const messageId = String(interaction.options.getString('message_id') || '').trim();
    const emojiInput = String(interaction.options.getString('emoji') || '').trim();
    const role = interaction.options.getRole('role');

    if (!channel || channel.type !== ChannelType.GuildText) {
      return interaction.reply({
        embeds: [buildErrorEmbed('Choose a normal server text channel.')],
        flags: MessageFlags.Ephemeral
      });
    }

    if (!/^\d{15,25}$/.test(messageId)) {
      return interaction.reply({
        embeds: [buildErrorEmbed('Message ID must be a valid Discord snowflake.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const me = interaction.guild.members.me || await interaction.guild.members.fetchMe().catch(() => null);
    const channelPerms = me && typeof channel.permissionsFor === 'function' ? channel.permissionsFor(me) : null;
    const missingChannelPerms = [];
    if (!channelPerms || !channelPerms.has(PermissionsBitField.Flags.ViewChannel)) missingChannelPerms.push('ViewChannel');
    if (!channelPerms || !channelPerms.has(PermissionsBitField.Flags.ReadMessageHistory)) missingChannelPerms.push('ReadMessageHistory');
    if (!channelPerms || !channelPerms.has(PermissionsBitField.Flags.AddReactions)) missingChannelPerms.push('AddReactions');
    if (missingChannelPerms.length) {
      return interaction.reply({
        embeds: [buildErrorEmbed(`I need these channel permissions first: ${missingChannelPerms.join(', ')}.`)],
        flags: MessageFlags.Ephemeral
      });
    }

    const assignable = roleIsAssignable(interaction.guild, role);
    if (!assignable.ok) {
      return interaction.reply({
        embeds: [buildErrorEmbed(assignable.reason)],
        flags: MessageFlags.Ephemeral
      });
    }

    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      return interaction.reply({
        embeds: [buildErrorEmbed('I could not find that message in the selected channel.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const reacted = await message.react(emojiInput).catch(() => null);
    if (!reacted) {
      return interaction.reply({
        embeds: [buildErrorEmbed('I could not react with that emoji. Check the emoji and bot permissions.')],
        flags: MessageFlags.Ephemeral
      });
    }

    const emojiKey = normalizeEmojiKey(reacted.emoji || emojiInput);
    await upsertReactionRole(db, {
      guildId: interaction.guild.id,
      channelId: channel.id,
      messageId,
      emojiKey,
      roleId: role.id,
      createdBy: interaction.user.id
    });
    const syncResult = await syncExistingReactionRoleUsers({
      db,
      message,
      emojiKey
    });

    const embed = new EmbedBuilder()
      .setColor(0x2ecc71)
      .setTitle('Reaction Role Configured')
      .setDescription(`Users who react with ${emojiInput} on [this message](${message.url}) will receive ${role}.`)
      .addFields(
        { name: 'Channel', value: `${channel}`, inline: true },
        { name: 'Role', value: `${role}`, inline: true },
        { name: 'Existing Reactions Synced', value: `${syncResult.assigned}/${syncResult.scanned}`, inline: true },
        { name: 'Message ID', value: messageId, inline: false }
      )
      .setTimestamp();

    return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  }
};

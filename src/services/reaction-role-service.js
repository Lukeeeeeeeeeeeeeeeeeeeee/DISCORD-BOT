const { PermissionsBitField } = require('discord.js');

function normalizeEmojiKey(emoji) {
  if (!emoji) return '';
  if (typeof emoji === 'string') return emoji.trim();
  if (emoji.id) return String(emoji.id);
  if (emoji.name) return String(emoji.name);
  return '';
}

async function upsertReactionRole(db, {
  guildId,
  channelId,
  messageId,
  emojiKey,
  roleId,
  createdBy
}) {
  const now = Date.now();
  await db.run(
    `INSERT INTO reaction_roles (guild_id, channel_id, message_id, emoji_key, role_id, created_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, message_id, emoji_key)
     DO UPDATE SET channel_id = excluded.channel_id, role_id = excluded.role_id, updated_at = excluded.updated_at`,
    guildId,
    channelId,
    messageId,
    emojiKey,
    roleId,
    createdBy,
    now,
    now
  );
}

async function findReactionRole(db, guildId, messageId, emojiKey) {
  if (!guildId || !messageId || !emojiKey) return null;
  return db.get(
    `SELECT guild_id, channel_id, message_id, emoji_key, role_id
     FROM reaction_roles
     WHERE guild_id = ? AND message_id = ? AND emoji_key = ?`,
    guildId,
    messageId,
    emojiKey
  );
}

async function recordAssignment(db, mapping, userId) {
  await db.run(
    `INSERT OR IGNORE INTO reaction_role_assignments
       (guild_id, message_id, emoji_key, role_id, user_id, assigned_at)
     VALUES (?, ?, ?, ?, ?, ?)`,
    mapping.guild_id,
    mapping.message_id,
    mapping.emoji_key,
    mapping.role_id,
    userId,
    Date.now()
  );
}

async function assignReactionRoleToUser({ db, guild, mapping, user, logger = console }) {
  if (!guild || !mapping || !user || user.bot) return false;

  const role = guild.roles && guild.roles.cache ? guild.roles.cache.get(mapping.role_id) : null;
  const assignable = roleIsAssignable(guild, role);
  if (!assignable.ok) {
    logger.warn(`Reaction role skipped: ${assignable.reason}`, {
      guildId: guild.id,
      messageId: mapping.message_id,
      roleId: mapping.role_id
    });
    return false;
  }

  const member = await guild.members.fetch(user.id).catch(() => null);
  if (!member) return false;
  if (!member.roles.cache.has(mapping.role_id)) {
    await member.roles.add(mapping.role_id, 'Reaction role');
  }
  await recordAssignment(db, mapping, user.id);
  return true;
}

function roleIsAssignable(guild, role) {
  const me = guild && guild.members ? guild.members.me : null;
  if (!me || !role) return { ok: false, reason: 'Bot member or role not available.' };
  if (!me.permissions || !me.permissions.has(PermissionsBitField.Flags.ManageRoles)) {
    return { ok: false, reason: 'Bot is missing Manage Roles.' };
  }
  if (role.managed) return { ok: false, reason: 'Managed roles cannot be assigned.' };
  if (me.roles && me.roles.highest && typeof me.roles.highest.comparePositionTo === 'function') {
    if (me.roles.highest.comparePositionTo(role) <= 0) {
      return { ok: false, reason: 'Bot role must be above the target role.' };
    }
  }
  return { ok: true };
}

async function handleReactionRoleAdd({ db, reaction, user, logger = console }) {
  if (!reaction || !user || user.bot) return false;
  if (reaction.partial && typeof reaction.fetch === 'function') {
    reaction = await reaction.fetch();
  }

  const message = reaction.message;
  const guild = message && message.guild;
  if (!guild) return false;

  const emojiKey = normalizeEmojiKey(reaction.emoji);
  const mapping = await findReactionRole(db, guild.id, message.id, emojiKey);
  if (!mapping) return false;

  return assignReactionRoleToUser({ db, guild, mapping, user, logger });
}

async function syncExistingReactionRoleUsers({ db, message, emojiKey, logger = console }) {
  const guild = message && message.guild;
  if (!guild || !message || !emojiKey) return { assigned: 0, scanned: 0 };

  const mapping = await findReactionRole(db, guild.id, message.id, emojiKey);
  if (!mapping) return { assigned: 0, scanned: 0 };

  let reaction = message.reactions && message.reactions.cache
    ? message.reactions.cache.find((entry) => normalizeEmojiKey(entry.emoji) === emojiKey)
    : null;
  if (!reaction && typeof message.react === 'function') {
    reaction = message.reactions && message.reactions.cache
      ? message.reactions.cache.find((entry) => normalizeEmojiKey(entry.emoji) === emojiKey)
      : null;
  }
  if (!reaction || !reaction.users || typeof reaction.users.fetch !== 'function') {
    return { assigned: 0, scanned: 0 };
  }

  const users = await reaction.users.fetch().catch(() => null);
  if (!users || typeof users.values !== 'function') return { assigned: 0, scanned: 0 };

  let assigned = 0;
  let scanned = 0;
  for (const existingUser of users.values()) {
    scanned += 1;
    const didAssign = await assignReactionRoleToUser({ db, guild, mapping, user: existingUser, logger });
    if (didAssign) assigned += 1;
  }
  return { assigned, scanned };
}

module.exports = {
  normalizeEmojiKey,
  upsertReactionRole,
  findReactionRole,
  recordAssignment,
  assignReactionRoleToUser,
  roleIsAssignable,
  handleReactionRoleAdd,
  syncExistingReactionRoleUsers
};

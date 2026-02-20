const {
  ACTIVITY_CHECK,
  GUILD_ID,
  ROLE_IDS,
  REGION_ROLE_IDS,
  TESTING_USER_ID
} = require('../constants');
const { getStaffRoleIds } = require('../lib/permissions');
const { replyError } = require('../lib/embeds');

const FALLBACK_OWNER_ID = '1381692847018868778';
const MESSAGE_LINK_REGEX = /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i;

function toIdSet(values) {
  if (!Array.isArray(values)) return new Set();
  return new Set(
    values
      .map((value) => (value == null ? '' : String(value).trim()))
      .filter(Boolean)
  );
}

function getOwnerIdSet() {
  const configured = toIdSet(ACTIVITY_CHECK && ACTIVITY_CHECK.OWNER_IDS);
  const envOwnerIds = [
    process.env.ACTIVITYCHECK_OWNER_ID,
    process.env.OWNER_ID,
    process.env.ANTINUKE_OWNER_ID
  ]
    .map((value) => (value == null ? '' : String(value).trim()))
    .filter(Boolean);
  for (const ownerId of envOwnerIds) configured.add(ownerId);
  if (TESTING_USER_ID) configured.add(String(TESTING_USER_ID));
  configured.add(FALLBACK_OWNER_ID);
  return configured;
}

function getTeamToInactiveRole() {
  const map = {};
  const source = ACTIVITY_CHECK && ACTIVITY_CHECK.TEAM_TO_INACTIVE_ROLE && typeof ACTIVITY_CHECK.TEAM_TO_INACTIVE_ROLE === 'object'
    ? ACTIVITY_CHECK.TEAM_TO_INACTIVE_ROLE
    : {};
  for (const [key, value] of Object.entries(source)) {
    const roleId = value == null ? '' : String(value).trim();
    const code = key == null ? '' : String(key).trim().toUpperCase();
    if (!code || !roleId) continue;
    map[code] = roleId;
  }
  return map;
}

function getInactiveRolePool(teamToInactiveRole) {
  const pool = new Set();
  const configuredPool = Array.isArray(ACTIVITY_CHECK && ACTIVITY_CHECK.INACTIVE_ROLE_POOL)
    ? ACTIVITY_CHECK.INACTIVE_ROLE_POOL
    : [];
  for (const roleId of configuredPool) {
    const value = roleId == null ? '' : String(roleId).trim();
    if (value) pool.add(value);
  }
  for (const roleId of Object.values(teamToInactiveRole)) {
    const value = roleId == null ? '' : String(roleId).trim();
    if (value) pool.add(value);
  }
  return Array.from(pool);
}

function hasAnyRole(member, roleIds) {
  if (!member || !member.roles || !member.roles.cache || !roleIds || roleIds.size === 0) return false;
  for (const roleId of roleIds) {
    if (member.roles.cache.has(roleId)) return true;
  }
  return false;
}

function inferTeamFromMember(member) {
  if (!member || !member.roles || !member.roles.cache) return null;

  const teamRoles = ROLE_IDS && ROLE_IDS.TEAM_MEMBER && typeof ROLE_IDS.TEAM_MEMBER === 'object'
    ? ROLE_IDS.TEAM_MEMBER
    : {};
  for (const [team, roleId] of Object.entries(teamRoles)) {
    if (!roleId) continue;
    if (member.roles.cache.has(roleId)) return String(team).toUpperCase();
  }

  if (ROLE_IDS && ROLE_IDS.ONBOARDING_FIRE && member.roles.cache.has(ROLE_IDS.ONBOARDING_FIRE)) return 'EU';
  if (ROLE_IDS && ROLE_IDS.ONBOARDING_WATER && member.roles.cache.has(ROLE_IDS.ONBOARDING_WATER)) return 'NA';
  if (ROLE_IDS && ROLE_IDS.ONBOARDING_AIR && member.roles.cache.has(ROLE_IDS.ONBOARDING_AIR)) return 'AS';

  const regionRoles = REGION_ROLE_IDS && typeof REGION_ROLE_IDS === 'object' ? REGION_ROLE_IDS : {};
  for (const [team, roleId] of Object.entries(regionRoles)) {
    if (!roleId) continue;
    const normalized = String(team).toUpperCase();
    if (normalized !== 'EU' && normalized !== 'NA' && normalized !== 'AS') continue;
    if (member.roles.cache.has(roleId)) return normalized;
  }

  return null;
}

function pickInactiveRole(member, teamToInactiveRole, inactiveRolePool) {
  const team = inferTeamFromMember(member);
  const teamRole = team && teamToInactiveRole[team] ? teamToInactiveRole[team] : null;
  if (teamRole) return { team, roleId: teamRole, source: 'team' };
  if (!inactiveRolePool.length) return { team, roleId: null, source: 'none' };
  const randomIdx = Math.floor(Math.random() * inactiveRolePool.length);
  return { team, roleId: inactiveRolePool[randomIdx], source: 'random' };
}

async function getReactedUserIds(message) {
  const reacted = new Set();
  if (!message || !message.reactions || !message.reactions.cache) return reacted;

  for (const reaction of message.reactions.cache.values()) {
    if (!reaction || !reaction.users || typeof reaction.users.fetch !== 'function') continue;
    const users = await reaction.users.fetch().catch(() => null);
    if (!users || typeof users.values !== 'function') continue;
    for (const user of users.values()) {
      if (!user || user.bot) continue;
      reacted.add(String(user.id));
    }
  }

  return reacted;
}

function roleIsRemovable(role) {
  if (!role) return false;
  if (role.managed) return false;
  if (role.editable === false) return false;
  return true;
}

function buildPreserveRoleSet() {
  const preserve = new Set();

  const configured = toIdSet(ACTIVITY_CHECK && ACTIVITY_CHECK.PRESERVE_ROLE_IDS);
  for (const roleId of configured) preserve.add(roleId);

  if (!ACTIVITY_CHECK || ACTIVITY_CHECK.PRESERVE_REGION_ROLES !== false) {
    for (const roleId of Object.values(REGION_ROLE_IDS || {})) {
      if (roleId) preserve.add(roleId);
    }
  }

  if (!ACTIVITY_CHECK || ACTIVITY_CHECK.PRESERVE_ONBOARDING_ROLES !== false) {
    const onboardingIds = [
      ROLE_IDS && ROLE_IDS.ONBOARDING_FIRE,
      ROLE_IDS && ROLE_IDS.ONBOARDING_WATER,
      ROLE_IDS && ROLE_IDS.ONBOARDING_AIR,
      ...(Array.isArray(ROLE_IDS && ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [])
    ];
    for (const roleId of onboardingIds) {
      if (roleId) preserve.add(roleId);
    }
  }

  if (!ACTIVITY_CHECK || ACTIVITY_CHECK.PRESERVE_STAFF_ROLES !== false) {
    for (const roleId of getStaffRoleIds()) {
      if (roleId) preserve.add(roleId);
    }
  }

  return preserve;
}

function parseMessageReference(rawValue) {
  const value = rawValue == null ? '' : String(rawValue).trim();
  if (!value) return null;

  const match = value.match(MESSAGE_LINK_REGEX);
  if (!match) {
    return {
      messageId: value,
      channelId: null,
      guildId: null
    };
  }
  return {
    guildId: match[1] === '@me' ? null : match[1],
    channelId: match[2],
    messageId: match[3]
  };
}

module.exports = {
  data: { name: 'activitycheck' },
  async execute(interaction) {
    if (!interaction || !interaction.guild) {
      return replyError(interaction, 'This command can only be used inside a server.');
    }

    if (GUILD_ID && String(interaction.guild.id) !== String(GUILD_ID)) {
      return replyError(interaction, 'This bot instance is configured for a different guild.');
    }

    const ownerIds = getOwnerIdSet();
    if (!ownerIds.has(String(interaction.user && interaction.user.id))) {
      return replyError(interaction, 'This command can only be used by the configured bot owner.');
    }

    const subcommand = typeof interaction.options.getSubcommand === 'function'
      ? interaction.options.getSubcommand()
      : null;
    if (subcommand !== 'role') {
      return replyError(interaction, 'Unsupported activitycheck action.');
    }

    const messageRefRaw = interaction.options.getString('messageid', true);
    const messageRef = parseMessageReference(messageRefRaw);
    if (!messageRef || !messageRef.messageId) {
      return replyError(interaction, 'Provide a valid message ID or Discord message link.');
    }
    if (messageRef.guildId && String(messageRef.guildId) !== String(interaction.guild.id)) {
      return replyError(interaction, 'That message link points to a different guild.');
    }

    const selectedChannel = interaction.options.getChannel('channel', false);
    const preview = interaction.options.getBoolean('preview') || false;
    const limit = interaction.options.getInteger('limit') || 0;

    let channel = selectedChannel || interaction.channel;
    if (!selectedChannel && messageRef.channelId) {
      channel = interaction.guild.channels.cache.get(messageRef.channelId)
        || await interaction.guild.channels.fetch(messageRef.channelId).catch(() => null);
    }
    if (!channel || typeof channel.isTextBased !== 'function' || !channel.isTextBased()) {
      return replyError(interaction, 'The target channel must be text-based.');
    }
    if (channel.guildId && String(channel.guildId) !== String(interaction.guild.id)) {
      return replyError(interaction, 'The target channel must belong to this guild.');
    }

    await interaction.deferReply({ flags: 64 });

    const messageId = messageRef.messageId;
    const message = await channel.messages.fetch(messageId).catch(() => null);
    if (!message) {
      return interaction.editReply({ content: `Could not find message \`${messageId}\` in <#${channel.id}>.` });
    }

    const teamToInactiveRole = getTeamToInactiveRole();
    const inactivePool = getInactiveRolePool(teamToInactiveRole);
    if (!inactivePool.length) {
      return interaction.editReply({
        content: 'Activity check is not configured: no inactive roles were set in ACTIVITY_CHECK.'
      });
    }

    await interaction.guild.roles.fetch().catch(() => null);

    const validInactivePool = inactivePool.filter((roleId) => Boolean(interaction.guild.roles.cache.get(roleId)));
    if (!validInactivePool.length) {
      return interaction.editReply({
        content: 'Activity check is misconfigured: configured inactive roles do not exist in this guild.'
      });
    }

    const reactedUserIds = await getReactedUserIds(message);
    const allMembers = await interaction.guild.members.fetch();

    const targetRoleIds = toIdSet(ACTIVITY_CHECK && ACTIVITY_CHECK.TARGET_ROLE_IDS);
    const exemptRoleIds = toIdSet(ACTIVITY_CHECK && ACTIVITY_CHECK.EXEMPT_ROLE_IDS);
    const preserveRoles = buildPreserveRoleSet();

    const candidates = [];
    for (const member of allMembers.values()) {
      if (!member || !member.user || member.user.bot) continue;
      if (reactedUserIds.has(String(member.id))) continue;
      if (hasAnyRole(member, exemptRoleIds)) continue;
      if (targetRoleIds.size > 0 && !hasAnyRole(member, targetRoleIds)) continue;
      candidates.push(member);
    }

    const cappedCandidates = limit > 0 ? candidates.slice(0, limit) : candidates;
    let changed = 0;
    let skipped = 0;
    let failed = 0;
    let removedRoleCount = 0;
    let addedRoleCount = 0;

    for (const member of cappedCandidates) {
      const picked = pickInactiveRole(member, teamToInactiveRole, validInactivePool);
      const targetRoleId = picked.roleId;
      if (!targetRoleId) {
        failed += 1;
        continue;
      }

      const keepIds = new Set(preserveRoles);
      keepIds.add(targetRoleId);

      const removableRoleIds = member.roles.cache
        .filter((role) => role.id !== interaction.guild.id)
        .filter((role) => !keepIds.has(role.id))
        .filter((role) => roleIsRemovable(role))
        .map((role) => role.id);

      const needsAdd = !member.roles.cache.has(targetRoleId);
      if (!needsAdd && removableRoleIds.length === 0) {
        skipped += 1;
        continue;
      }

      if (preview) {
        changed += 1;
        if (needsAdd) addedRoleCount += 1;
        removedRoleCount += removableRoleIds.length;
        continue;
      }

      try {
        if (needsAdd) {
          await member.roles.add(targetRoleId, `Activity check: no reaction on message ${message.id}`);
          addedRoleCount += 1;
        }
        if (removableRoleIds.length) {
          await member.roles.remove(removableRoleIds, `Activity check: moving to inactive role (${targetRoleId})`);
          removedRoleCount += removableRoleIds.length;
        }
        changed += 1;
      } catch (error) {
        failed += 1;
        console.error('Activity check role update failed', {
          memberId: member.id,
          guildId: interaction.guild.id,
          messageId: message.id,
          error
        });
      }
    }

    const mode = preview ? 'Preview' : 'Done';
    const summary = [
      `**${mode}: Activity check**`,
      `Message: \`${message.id}\` in <#${channel.id}>`,
      `Reacted users: **${reactedUserIds.size}**`,
      `Matched non-reactors: **${candidates.length}**`,
      limit > 0 ? `Processing limit: **${limit}**` : null,
      `Processed: **${cappedCandidates.length}**`,
      `Updated members: **${changed}**`,
      `Skipped (no changes needed): **${skipped}**`,
      `Role adds: **${addedRoleCount}**`,
      `Role removals: **${removedRoleCount}**`,
      `Failures: **${failed}**`
    ].filter(Boolean).join('\n');

    return interaction.editReply({ content: summary });
  }
};

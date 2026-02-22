const {
  ACTIVITY_CHECK,
  GUILD_ID,
  ROLE_IDS,
  REGION_ROLE_IDS,
  TESTING_USER_ID
} = require('../constants');
const { getStaffRoleIds } = require('../lib/permissions');
const { replyError } = require('../lib/embeds');
const { logUnexpectedError } = require('../lib/logger');

const FALLBACK_OWNER_ID = '1381692847018868778';
const MESSAGE_LINK_REGEX = /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/channels\/([^/]+)\/([^/]+)\/([^/?#]+)(?:[/?#].*)?$/i;
const REACTION_FETCH_PAGE_SIZE = 100;
const REACTION_FETCH_MAX_PAGES = Number.parseInt(process.env.ACTIVITY_CHECK_REACTION_FETCH_MAX_PAGES || '50', 10);

function reportActivityCheckError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'activitycheck',
    ...meta
  });
}

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

    let pageCount = 0;
    let after = null;
    while (pageCount < REACTION_FETCH_MAX_PAGES) {
      const fetchOptions = { limit: REACTION_FETCH_PAGE_SIZE };
      if (after) fetchOptions.after = after;
      const users = await reaction.users.fetch(fetchOptions).catch(() => null);
      if (!users || typeof users.values !== 'function' || users.size === 0) break;

      for (const user of users.values()) {
        if (!user || user.bot) continue;
        reacted.add(String(user.id));
      }

      const keys = typeof users.keys === 'function' ? Array.from(users.keys()) : [];
      const lastId = keys.length ? String(keys[keys.length - 1]) : null;
      if (!lastId || users.size < REACTION_FETCH_PAGE_SIZE || lastId === after) break;
      after = lastId;
      pageCount += 1;
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

function isGatewayMemberFetchRateLimit(error) {
  if (!error) return false;
  const name = String(error.name || '');
  const message = String(error.message || '');
  return name === 'GatewayRateLimitError'
    || /opcode\s*8.*rate limited/i.test(message)
    || /gatewayratelimiterror/i.test(name);
}

function parseRetryAfterMs(error) {
  if (!error) return 0;
  const rawRetryAfter = error.retryAfter ?? error.retry_after ?? (error.data && error.data.retry_after);
  if (Number.isFinite(rawRetryAfter) && Number(rawRetryAfter) > 0) {
    const value = Number(rawRetryAfter);
    return value < 1000 ? Math.ceil(value * 1000) : Math.ceil(value);
  }

  const message = String(error.message || '');
  const match = message.match(/retry after\s+([0-9]+(?:\.[0-9]+)?)\s*seconds?/i);
  if (match && Number.isFinite(Number(match[1]))) {
    return Math.ceil(Number(match[1]) * 1000);
  }
  return 0;
}

function getMemberFetchRetries() {
  const parsed = Number.parseInt(process.env.ACTIVITY_CHECK_MEMBER_FETCH_RETRIES || '1', 10);
  if (!Number.isFinite(parsed)) return 1;
  return Math.max(0, parsed);
}

async function fetchMembersWithFallback(guild) {
  const cache = guild && guild.members && guild.members.cache ? guild.members.cache : null;
  const canFetch = guild && guild.members && typeof guild.members.fetch === 'function';
  const retries = getMemberFetchRetries();
  let lastError = null;

  if (canFetch) {
    for (let attempt = 0; attempt <= retries; attempt += 1) {
      try {
        const members = await guild.members.fetch();
        if (members && typeof members.values === 'function') {
          return { members, source: 'fetch', fetchError: null };
        }
      } catch (error) {
        lastError = error;
        if (!isGatewayMemberFetchRateLimit(error)) break;
        if (attempt >= retries) break;
        const waitMs = parseRetryAfterMs(error) || ((attempt + 1) * 3000);
        await new Promise((resolve) => setTimeout(resolve, waitMs));
      }
    }
  }

  if (cache && typeof cache.values === 'function' && cache.size > 0) {
    return { members: cache, source: 'cache', fetchError: lastError };
  }

  if (lastError) throw lastError;
  return { members: cache || new Map(), source: 'cache', fetchError: null };
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
    let memberLoad = null;
    try {
      memberLoad = await fetchMembersWithFallback(interaction.guild);
    } catch (error) {
      if (isGatewayMemberFetchRateLimit(error)) {
        const retryAfterMs = parseRetryAfterMs(error);
        const retryAfterSecs = Math.max(1, Math.ceil(retryAfterMs / 1000));
        return interaction.editReply({
          content: `Discord rate-limited member loading for this command. Please retry in about **${retryAfterSecs}s**.`
        });
      }
      throw error;
    }
    const allMembers = memberLoad.members;
    const usedMemberCacheFallback = memberLoad.source === 'cache' && !!memberLoad.fetchError;

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
    const assignmentCounts = new Map();
    const assignmentSourceCounts = {
      team: 0,
      random: 0,
      none: 0
    };

    for (const member of cappedCandidates) {
      const picked = pickInactiveRole(member, teamToInactiveRole, validInactivePool);
      const targetRoleId = picked.roleId;
      if (picked && picked.source && Object.prototype.hasOwnProperty.call(assignmentSourceCounts, picked.source)) {
        assignmentSourceCounts[picked.source] += 1;
      }
      if (targetRoleId) {
        assignmentCounts.set(targetRoleId, (assignmentCounts.get(targetRoleId) || 0) + 1);
      }
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
        reportActivityCheckError('command.activitycheck.roleUpdate', error, {
          memberId: member.id,
          guildId: interaction.guild.id,
          messageId: message.id
        });
      }
    }

    const mode = preview ? 'Preview' : 'Done';
    const assignmentSummary = Array.from(assignmentCounts.entries())
      .sort((a, b) => b[1] - a[1])
      .map(([roleId, count]) => `<@&${roleId}>: **${count}**`)
      .join(', ');
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
      `Failures: **${failed}**`,
      usedMemberCacheFallback ? 'Member source: **cache (gateway rate-limit fallback)**' : 'Member source: **live fetch**',
      usedMemberCacheFallback ? 'Note: fallback mode may miss uncached members. Retry after rate-limit window for full accuracy.' : null,
      assignmentSummary ? `Inactive role distribution: ${assignmentSummary}` : null,
      `Assignment source: team **${assignmentSourceCounts.team}**, random **${assignmentSourceCounts.random}**, none **${assignmentSourceCounts.none}**`
    ].filter(Boolean).join('\n');

    return interaction.editReply({ content: summary });
  }
};

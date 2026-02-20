const { GUILD_ID, TESTING_USER_ID } = require('../constants');
const { replyError } = require('../lib/embeds');

const OWNER_FALLBACK_ID = '1381692847018868778';
const DEFAULT_SOURCE_ROLE_ID = '1463200689252597770';
const PATH_KEYS = ['FIRE', 'WATER', 'AIR'];

const BASE_ROLES = {
  ROOKIE: '1412808625529028767',
  MEMBER: '1412808625747132501',
  RECRUITER: '1412808626040733738',
  TRIAL_RECRUITER: '1421549298033627156',
  HELPER: '1412808626099323003',
  HELPER_PLUS: '1412808626099323004',
  MOD: '1412808626136940575'
};

const PATH_BUCKETS = [
  {
    key: 'onboarding',
    roles: {
      AIR: '1473726598300700796',
      FIRE: '1473726606634909829',
      WATER: '1473726616025694419'
    },
    isEligible: (member) => hasRole(member, BASE_ROLES.ROOKIE)
  },
  {
    key: 'member',
    roles: {
      AIR: '1473726626733756438',
      FIRE: '1473726632769622173',
      WATER: '1473726640939991261'
    },
    isEligible: (member) => hasRole(member, BASE_ROLES.MEMBER)
  },
  {
    key: 'inactive',
    roles: {
      AIR: '1473726648712036496',
      FIRE: '1473726655565529259',
      WATER: '1473726663329316946'
    },
    isEligible: (member, sourceRoleId) => hasRole(member, sourceRoleId)
  },
  {
    key: 'recruiter_region',
    roles: {
      AIR: '1473726967277686854',
      FIRE: '1473726977105072314',
      WATER: '1473726986508833061'
    },
    isEligible: (member) => (
      hasRole(member, BASE_ROLES.RECRUITER)
      || hasRole(member, BASE_ROLES.TRIAL_RECRUITER)
      || hasRole(member, BASE_ROLES.HELPER)
      || hasRole(member, BASE_ROLES.HELPER_PLUS)
      || hasRole(member, BASE_ROLES.MOD)
    )
  },
  {
    key: 'helper_region',
    roles: {
      FIRE: '1473773076092027091',
      AIR: '1473773084430307390',
      WATER: '1473773094429655124'
    },
    isEligible: (member) => hasRole(member, BASE_ROLES.HELPER)
  },
  {
    key: 'helper_plus_region',
    roles: {
      FIRE: '1473773139652775968',
      AIR: '1473773194552021107',
      WATER: '1473773203905314871'
    },
    isEligible: (member) => hasRole(member, BASE_ROLES.HELPER_PLUS)
  },
  {
    key: 'mod_region',
    roles: {
      FIRE: '1473773213463875654',
      WATER: '1473773221273796618',
      AIR: '1473773230564180001'
    },
    isEligible: (member) => hasRole(member, BASE_ROLES.MOD)
  }
];

function hasRole(member, roleId) {
  return Boolean(member && member.roles && member.roles.cache && roleId && member.roles.cache.has(roleId));
}

function getOwnerIdSet() {
  const ids = new Set([OWNER_FALLBACK_ID]);
  if (TESTING_USER_ID) ids.add(String(TESTING_USER_ID));

  const envOwnerIds = [
    process.env.PATH_BALANCE_OWNER_ID,
    process.env.ACTIVITYCHECK_OWNER_ID,
    process.env.OWNER_ID,
    process.env.ANTINUKE_OWNER_ID
  ]
    .map((value) => (value == null ? '' : String(value).trim()))
    .filter(Boolean);

  for (const ownerId of envOwnerIds) ids.add(ownerId);
  return ids;
}

function collectAllPathRoleIds() {
  const ids = new Set();
  for (const bucket of PATH_BUCKETS) {
    for (const roleId of Object.values(bucket.roles || {})) {
      if (roleId) ids.add(roleId);
    }
  }
  return ids;
}

function inferExistingPath(member) {
  const counts = {
    FIRE: 0,
    WATER: 0,
    AIR: 0
  };

  for (const bucket of PATH_BUCKETS) {
    for (const pathKey of PATH_KEYS) {
      const roleId = bucket.roles && bucket.roles[pathKey];
      if (roleId && hasRole(member, roleId)) counts[pathKey] += 1;
    }
  }

  const maxCount = Math.max(...Object.values(counts));
  if (maxCount <= 0) return null;
  const tied = PATH_KEYS.filter((pathKey) => counts[pathKey] === maxCount);
  if (tied.length === 1) return tied[0];

  // Tie-break using bucket priority to preserve stronger pre-existing signal.
  for (const bucket of PATH_BUCKETS) {
    for (const pathKey of PATH_KEYS) {
      if (!tied.includes(pathKey)) continue;
      const roleId = bucket.roles && bucket.roles[pathKey];
      if (roleId && hasRole(member, roleId)) return pathKey;
    }
  }
  return tied[0];
}

function shuffleInPlace(items) {
  for (let i = items.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    const tmp = items[i];
    items[i] = items[j];
    items[j] = tmp;
  }
}

function pickLeastUsedPath(pathCounts) {
  const min = Math.min(...PATH_KEYS.map((key) => pathCounts[key]));
  const options = PATH_KEYS.filter((key) => pathCounts[key] === min);
  if (options.length === 1) return options[0];
  return options[Math.floor(Math.random() * options.length)];
}

function toCollectionValues(collection) {
  if (!collection) return [];
  if (typeof collection.values === 'function') return Array.from(collection.values());
  if (Array.isArray(collection)) return collection;
  return [];
}

function memberDisplay(member) {
  if (!member) return 'unknown';
  const nick = member.nickname ? String(member.nickname) : '';
  if (nick) return `${nick} (${member.id})`;
  if (member.user && member.user.tag) return `${member.user.tag} (${member.id})`;
  return String(member.id);
}

function buildMemberRolePlan(member, assignedPath, sourceRoleId, removeSourceRole) {
  const addSet = new Set();
  const removeSet = new Set();

  for (const bucket of PATH_BUCKETS) {
    const roleIds = PATH_KEYS.map((pathKey) => bucket.roles[pathKey]).filter(Boolean);
    const eligible = bucket.isEligible(member, sourceRoleId);
    if (eligible) {
      const targetRoleId = bucket.roles[assignedPath];
      if (targetRoleId && !hasRole(member, targetRoleId)) addSet.add(targetRoleId);
      for (const roleId of roleIds) {
        if (roleId !== targetRoleId && hasRole(member, roleId)) removeSet.add(roleId);
      }
    } else {
      // Cleanup any stale path-role from buckets the member should not be in.
      for (const roleId of roleIds) {
        if (hasRole(member, roleId)) removeSet.add(roleId);
      }
    }
  }

  if (removeSourceRole && hasRole(member, sourceRoleId)) {
    removeSet.add(sourceRoleId);
  }

  for (const roleId of addSet) {
    if (removeSet.has(roleId)) removeSet.delete(roleId);
  }

  return {
    addRoleIds: Array.from(addSet),
    removeRoleIds: Array.from(removeSet)
  };
}

module.exports = {
  data: { name: 'pathbalance' },
  async execute(interaction) {
    if (!interaction || !interaction.guild) {
      return replyError(interaction, 'This command can only be used inside a server.');
    }
    if (GUILD_ID && String(interaction.guild.id) !== String(GUILD_ID)) {
      return replyError(interaction, 'This bot instance is configured for a different guild.');
    }

    const ownerIds = getOwnerIdSet();
    const callerId = String(interaction.user && interaction.user.id);
    if (!ownerIds.has(callerId)) {
      return replyError(interaction, 'This one-time command is owner-only.');
    }

    const preview = interaction.options.getBoolean('preview') !== false;
    const removeSourceRole = interaction.options.getBoolean('remove_source_role') !== false;
    const deleteSourceRole = interaction.options.getBoolean('delete_source_role') !== false;
    const confirm = String(interaction.options.getString('confirm') || '').trim().toUpperCase();
    const limit = interaction.options.getInteger('limit') || 0;
    const sourceRoleOption = interaction.options.getRole('source_role', false);
    const sourceRoleId = sourceRoleOption && sourceRoleOption.id
      ? String(sourceRoleOption.id)
      : DEFAULT_SOURCE_ROLE_ID;

    if (!preview && confirm !== 'CONFIRM') {
      return replyError(
        interaction,
        'Set `confirm` to `CONFIRM` for live execution, or run with `preview=true`.'
      );
    }

    await interaction.deferReply({ flags: 64 });

    await interaction.guild.roles.fetch().catch(() => null);
    const sourceRole = interaction.guild.roles.cache.get(sourceRoleId)
      || await interaction.guild.roles.fetch(sourceRoleId).catch(() => null);
    if (!sourceRole) {
      return interaction.editReply({ content: `Source role not found: <@&${sourceRoleId}>.` });
    }

    const missingRoleIds = Array.from(collectAllPathRoleIds())
      .filter((roleId) => !interaction.guild.roles.cache.has(roleId));
    if (missingRoleIds.length) {
      return interaction.editReply({
        content: `Missing configured path roles in guild: ${missingRoleIds.map((id) => `<@&${id}>`).join(', ')}`
      });
    }

    let members = toCollectionValues(sourceRole.members).filter((member) => member && member.user && !member.user.bot);
    if (limit > 0) members = members.slice(0, limit);
    if (!members.length) {
      return interaction.editReply({ content: `No members found in source role <@&${sourceRoleId}>.` });
    }

    const assignmentByMemberId = new Map();
    const pathCounts = {
      FIRE: 0,
      WATER: 0,
      AIR: 0
    };

    const unresolved = [];
    for (const member of members) {
      const existingPath = inferExistingPath(member);
      if (existingPath) {
        assignmentByMemberId.set(member.id, existingPath);
        pathCounts[existingPath] += 1;
      } else {
        unresolved.push(member);
      }
    }

    shuffleInPlace(unresolved);
    for (const member of unresolved) {
      const assigned = pickLeastUsedPath(pathCounts);
      assignmentByMemberId.set(member.id, assigned);
      pathCounts[assigned] += 1;
    }

    let changedMembers = 0;
    let addCount = 0;
    let removeCount = 0;
    let failed = 0;
    let removedSourceCount = 0;

    const failures = [];
    for (const member of members) {
      const assignedPath = assignmentByMemberId.get(member.id);
      const plan = buildMemberRolePlan(member, assignedPath, sourceRoleId, removeSourceRole);
      addCount += plan.addRoleIds.length;
      removeCount += plan.removeRoleIds.length;
      if (plan.removeRoleIds.includes(sourceRoleId)) removedSourceCount += 1;

      const hasChanges = plan.addRoleIds.length > 0 || plan.removeRoleIds.length > 0;
      if (!hasChanges) continue;
      changedMembers += 1;

      if (preview) continue;

      try {
        if (plan.addRoleIds.length) {
          await member.roles.add(plan.addRoleIds, `One-time path balance (${assignedPath})`);
        }
        if (plan.removeRoleIds.length) {
          await member.roles.remove(plan.removeRoleIds, `One-time path balance (${assignedPath})`);
        }
      } catch (error) {
        failed += 1;
        failures.push({
          memberId: member.id,
          member: memberDisplay(member),
          error: String(error && error.message ? error.message : error)
        });
      }
    }

    let sourceRoleDeleted = false;
    let sourceDeleteError = null;
    if (!preview && deleteSourceRole && removeSourceRole) {
      try {
        await sourceRole.delete('One-time path balance completed');
        sourceRoleDeleted = true;
      } catch (error) {
        sourceDeleteError = String(error && error.message ? error.message : error);
      }
    }

    const lines = [
      `**${preview ? 'Preview' : 'Done'}: Path Balance**`,
      `Source role: <@&${sourceRoleId}>`,
      `Processed members: **${members.length}**`,
      limit > 0 ? `Limit: **${limit}**` : null,
      `Assigned paths: FIRE **${pathCounts.FIRE}**, WATER **${pathCounts.WATER}**, AIR **${pathCounts.AIR}**`,
      `Members with role changes: **${changedMembers}**`,
      `Role adds: **${addCount}**`,
      `Role removals: **${removeCount}**`,
      removeSourceRole ? `Source role removals: **${removedSourceCount}**` : 'Source role removals: **disabled**',
      `Failures: **${failed}**`,
      preview ? 'No roles were changed (preview mode).' : null,
      (!preview && deleteSourceRole)
        ? (sourceRoleDeleted ? 'Source role deleted: **yes**' : `Source role deleted: **no** (${sourceDeleteError || 'unknown error'})`)
        : null
    ].filter(Boolean);

    if (failures.length) {
      const sample = failures.slice(0, 10)
        .map((item) => `- ${item.member}: ${item.error}`)
        .join('\n');
      lines.push(`Failure sample:\n${sample}`);
    }

    return interaction.editReply({ content: lines.join('\n') });
  }
};


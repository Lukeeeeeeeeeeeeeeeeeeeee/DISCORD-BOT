const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');
const { PermissionsBitField } = require('discord.js');
const ELEVATED_PERMISSION_FLAGS = [
  PermissionsBitField.Flags.ManageGuild,
  PermissionsBitField.Flags.ModerateMembers,
  PermissionsBitField.Flags.BanMembers,
  PermissionsBitField.Flags.KickMembers,
  PermissionsBitField.Flags.ManageRoles,
  PermissionsBitField.Flags.ManageChannels
];

function getMemberPermissions(member) {
  if (!member || !member.permissions) return null;
  if (typeof member.permissions.has === 'function') return member.permissions;
  try {
    return new PermissionsBitField(member.permissions);
  } catch (e) {
    return null;
  }
}

function getMemberRoleIds(member) {
  if (!member || !member.roles) return [];
  if (Array.isArray(member.roles)) return member.roles.filter(Boolean);
  if (member.roles.cache) {
    if (Array.isArray(member.roles.cache)) return member.roles.cache.filter(Boolean);
    if (typeof member.roles.cache.keys === 'function') {
      return Array.from(member.roles.cache.keys());
    }
    if (Array.isArray(member.roles.cache.values)) {
      return member.roles.cache.values.map(role => role && role.id ? role.id : role).filter(Boolean);
    }
    if (member.roles.cache.has && typeof member.roles.cache.has === 'function' && member.roles.cache._roles) {
      return Array.from(member.roles.cache._roles.keys ? member.roles.cache._roles.keys() : []);
    }
  }
  if (member.roles instanceof Set) return Array.from(member.roles);
  return [];
}

function memberHasRole(member, roleId) {
  if (!roleId) return false;
  const roles = getMemberRoleIds(member);
  return roles.includes(roleId);
}

function hasAdministrator(member) {
  const perms = getMemberPermissions(member);
  if (!perms) return false;
  return perms.has(PermissionsBitField.Flags.Administrator) || perms.has('Administrator');
}

function hasElevatedGuildPermissions(member) {
  if (hasAdministrator(member)) return true;
  const perms = getMemberPermissions(member);
  if (!perms || typeof perms.has !== 'function') return false;
  return ELEVATED_PERMISSION_FLAGS.some(flag => perms.has(flag));
}

function getStaffRoleIds() {
  const configured = ROLE_IDS && Array.isArray(ROLE_IDS.STAFF) ? ROLE_IDS.STAFF.filter(Boolean) : [];
  if (configured.length) return configured;
  return [
    ROLE_IDS.HELPER_MINUS,
    ROLE_IDS.HELPER,
    ROLE_IDS.HELPER_PLUS,
    ROLE_IDS.HIGH_STAFF,
    ROLE_IDS.MOD,
    ROLE_IDS.CHIEF,
    ROLE_IDS.CHIEF_OF_WAR,
    ROLE_IDS.CHIEF_OF_COMMUNITY,
    ROLE_IDS.CHIEF_OF_RECRUITMENT,
    ROLE_IDS.CO_LEADER,
    ROLE_IDS.LEADER
  ].filter(Boolean);
}

function hasAnyRole(member, roleIds) {
  const allowed = Array.isArray(roleIds) ? roleIds.filter(Boolean) : [];
  if (!allowed.length) return false;
  const memberRoleIds = getMemberRoleIds(member);
  if (!memberRoleIds.length) return false;
  return allowed.some(roleId => memberRoleIds.includes(roleId));
}

/**
 * Check if a user has recruiter or staff permissions
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has recruiter or staff permissions
 */
function hasRecruiterOrStaffPermissions(member) {
  if (!member) return false;
  if (hasElevatedGuildPermissions(member)) return true;

  // Check staff roles
  const staffRoles = getStaffRoleIds();

  // Check recruiter roles
  const recruiterRoles = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...Object.values(RECRUITER_ROLE_IDS || {})
  ];

  const allAllowedRoles = [...staffRoles, ...recruiterRoles];
  return hasAnyRole(member, allAllowedRoles);
}

/**
 * Check if a user has admin or staff permissions (for admin commands)
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has admin or staff permissions
 */
/**
 * Check if a user has admin or staff permissions (for admin commands)
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has admin or staff permissions
 */
function hasAdminOrStaffPermissions(member) {
  if (!member) return false;
  if (hasElevatedGuildPermissions(member)) return true;

  // Check staff roles
  const staffRoles = getStaffRoleIds();
  return hasAnyRole(member, staffRoles);
}

/**
 * Check if a user has true "Admin" power (Chief rank or above, or Discord Administrator)
 * This is used for critical bypasses and overrides.
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has administrative power
 */
function hasAdminPermissions(member) {
  if (!member) return false;
  if (hasAdministrator(member)) return true;
  
  // Only high-ranking staff: Chief, Co-Leader, Leader
  const adminRoles = [
    ROLE_IDS.CHIEF,
    ROLE_IDS.CHIEF_OF_WAR,
    ROLE_IDS.CHIEF_OF_COMMUNITY,
    ROLE_IDS.CHIEF_OF_RECRUITMENT,
    ROLE_IDS.CO_LEADER,
    ROLE_IDS.LEADER
  ].filter(Boolean);

  return hasAnyRole(member, adminRoles);
}

module.exports = {
  hasRecruiterOrStaffPermissions,
  hasAdminOrStaffPermissions,
  hasAdminPermissions,
  hasAdministrator,
  hasElevatedGuildPermissions,
  getMemberPermissions,
  getMemberRoleIds,
  memberHasRole,
  getStaffRoleIds,
  hasAnyRole
};

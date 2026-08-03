const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');
const { PermissionsBitField } = require('discord.js');

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
  if (member.roles.cache && typeof member.roles.cache.keys === 'function') {
    return Array.from(member.roles.cache.keys());
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

function getStaffRoleIds() {
  const configured = ROLE_IDS && Array.isArray(ROLE_IDS.STAFF) ? ROLE_IDS.STAFF.filter(Boolean) : [];
  if (configured.length) return configured;
  return [
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

/**
 * Check if a user has recruiter or staff permissions
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has recruiter or staff permissions
 */
function hasRecruiterOrStaffPermissions(member) {
  if (!member) return false;
  const roleIds = getMemberRoleIds(member);

  // Check Discord admin permission
  if (hasAdministrator(member)) return true;

  const perms = getMemberPermissions(member);
  if (perms && typeof perms.has === 'function') {
    const elevated = [
      PermissionsBitField.Flags.ManageGuild,
      PermissionsBitField.Flags.ModerateMembers,
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.ManageChannels
    ];
    if (elevated.some(flag => perms.has(flag))) return true;
  }

  // Check staff roles
  const staffRoles = getStaffRoleIds();

  // Check recruiter roles
  const recruiterRoles = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...Object.values(RECRUITER_ROLE_IDS)
  ];

  const allAllowedRoles = [...staffRoles, ...recruiterRoles];

  if (!roleIds.length) return false;
  return allAllowedRoles.some(roleId => roleIds.includes(roleId));
}

/**
 * Check if a user has admin or staff permissions (for admin commands)
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has admin or staff permissions
 */
function hasAdminOrStaffPermissions(member) {
  if (!member) return false;
  const roleIds = getMemberRoleIds(member);

  // Check Discord admin permission
  if (hasAdministrator(member)) return true;

  const perms = getMemberPermissions(member);
  if (perms && typeof perms.has === 'function') {
    const elevated = [
      PermissionsBitField.Flags.ManageGuild,
      PermissionsBitField.Flags.ModerateMembers,
      PermissionsBitField.Flags.BanMembers,
      PermissionsBitField.Flags.KickMembers,
      PermissionsBitField.Flags.ManageRoles,
      PermissionsBitField.Flags.ManageChannels
    ];
    if (elevated.some(flag => perms.has(flag))) return true;
  }

  // Check staff roles
  const staffRoles = getStaffRoleIds();

  if (!roleIds.length) return false;
  return staffRoles.some(roleId => roleIds.includes(roleId));
}

module.exports = {
  hasRecruiterOrStaffPermissions,
  hasAdminOrStaffPermissions,
  hasAdministrator,
  getMemberPermissions,
  getMemberRoleIds,
  memberHasRole
};

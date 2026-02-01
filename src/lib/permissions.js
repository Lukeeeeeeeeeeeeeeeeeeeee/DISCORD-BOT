const { ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');
const { PermissionsBitField } = require('discord.js');

function hasAdministrator(member) {
  if (!member) return false;
  const hasPermissions = !!member.permissions && typeof member.permissions.has === 'function';
  if (!hasPermissions) return false;
  return member.permissions.has(PermissionsBitField.Flags.Administrator) || member.permissions.has('Administrator');
}

/**
 * Check if a user has recruiter or staff permissions
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has recruiter or staff permissions
 */
function hasRecruiterOrStaffPermissions(member) {
  if (!member) return false;
  const hasRoleCache = !!member.roles && !!member.roles.cache && typeof member.roles.cache.has === 'function';

  // Check Discord admin permission
  if (hasAdministrator(member)) return true;

  // Check staff roles
  const staffRoles = [
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
  ];

  // Check recruiter roles
  const recruiterRoles = [
    ROLE_IDS.RECRUITER,
    ROLE_IDS.TRIAL_RECRUITER,
    ...Object.values(RECRUITER_ROLE_IDS)
  ];

  const allAllowedRoles = [...staffRoles, ...recruiterRoles];

  if (!hasRoleCache) return false;
  return allAllowedRoles.some(roleId => member.roles.cache.has(roleId));
}

/**
 * Check if a user has admin or staff permissions (for admin commands)
 * @param {GuildMember} member - Discord guild member
 * @returns {boolean} - True if user has admin or staff permissions
 */
function hasAdminOrStaffPermissions(member) {
  if (!member) return false;
  const hasRoleCache = !!member.roles && !!member.roles.cache && typeof member.roles.cache.has === 'function';

  // Check Discord admin permission
  if (hasAdministrator(member)) return true;

  // Check staff roles
  const staffRoles = [
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
  ];

  if (!hasRoleCache) return false;
  return staffRoles.some(roleId => member.roles.cache.has(roleId));
}

module.exports = {
  hasRecruiterOrStaffPermissions,
  hasAdminOrStaffPermissions,
  hasAdministrator
};

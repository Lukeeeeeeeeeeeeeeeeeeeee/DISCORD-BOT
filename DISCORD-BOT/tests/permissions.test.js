jest.mock('../src/constants', () => ({
  ROLE_IDS: {
    STAFF: ['staff_role'],
    RECRUITER: 'recruiter_role',
    TRIAL_RECRUITER: 'trial_recruiter_role'
  },
  RECRUITER_ROLE_IDS: {
    BRONZE: 'recruiter_bronze'
  }
}));

const { PermissionsBitField } = require('discord.js');
const {
  hasAdminOrStaffPermissions,
  hasRecruiterOrStaffPermissions,
  hasElevatedGuildPermissions,
  hasAnyRole,
  getMemberRoleIds
} = require('../src/lib/permissions');

function createMember({ roleIds = [], permissions = [] } = {}) {
  const roleMap = new Map(roleIds.map(id => [id, { id }]));
  return {
    permissions: {
      has: (flag) => permissions.includes(flag)
    },
    roles: {
      cache: roleMap
    }
  };
}

describe('permissions helpers', () => {
  test('detects elevated Discord permissions', () => {
    const member = createMember({
      permissions: [PermissionsBitField.Flags.ManageGuild]
    });

    expect(hasElevatedGuildPermissions(member)).toBe(true);
    expect(hasAdminOrStaffPermissions(member)).toBe(true);
  });

  test('allows recruiter/staff based on configured roles', () => {
    const recruiterMember = createMember({ roleIds: ['recruiter_role'] });
    const staffMember = createMember({ roleIds: ['staff_role'] });
    const deniedMember = createMember({ roleIds: ['random_role'] });

    expect(hasRecruiterOrStaffPermissions(recruiterMember)).toBe(true);
    expect(hasRecruiterOrStaffPermissions(staffMember)).toBe(true);
    expect(hasRecruiterOrStaffPermissions(deniedMember)).toBe(false);
  });

  test('hasAnyRole and getMemberRoleIds handle heterogeneous role containers', () => {
    const asArray = { roles: ['x', 'y'] };
    const asSet = { roles: new Set(['a', 'b']) };

    expect(getMemberRoleIds(asArray)).toEqual(['x', 'y']);
    expect(getMemberRoleIds(asSet)).toEqual(expect.arrayContaining(['a', 'b']));
    expect(hasAnyRole(asArray, ['none', 'y'])).toBe(true);
    expect(hasAnyRole(asSet, ['z'])).toBe(false);
  });
});

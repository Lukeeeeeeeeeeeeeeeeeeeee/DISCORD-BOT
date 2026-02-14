jest.mock('../src/constants', () => ({
  ROLE_IDS: {
    ROOKIE: 'role_rookie',
    UNVERIFIED: 'role_unverified',
    ONBOARDING_FIRE: 'role_onboarding_fire',
    ONBOARDING_WATER: 'role_onboarding_water',
    ONBOARDING_AIR: 'role_onboarding_air',
    ONBOARDING: ['role_onboarding_fire', 'role_onboarding_water', 'role_onboarding_air'],
    SOLACE: 'role_solace',
    TEAM_MEMBER: {
      EU: 'role_team_eu',
      NA: 'role_team_na',
      AS: 'role_team_as'
    }
  }
}));

jest.mock('../src/scheduler', () => ({
  recomputeLeaderboards: jest.fn().mockResolvedValue(undefined)
}));

const { promoteMember } = require('../src/lib/promote');

function createRoleCache(ids) {
  return {
    has: (id) => ids.includes(id),
    map: (fn) => ids.map((id) => fn({ id }))
  };
}

describe('promote role safety', () => {
  test('uses granular add/remove and avoids destructive roles.set when supported', async () => {
    const member = {
      id: 'member-1',
      nickname: 'Player 4/10',
      user: { username: 'Player' },
      guild: { id: 'guild-role-id' },
      setNickname: jest.fn().mockResolvedValue(undefined),
      roles: {
        cache: createRoleCache([
          'role_rookie',
          'role_onboarding_fire',
          'role_custom_a'
        ]),
        remove: jest.fn().mockResolvedValue(undefined),
        add: jest.fn().mockResolvedValue(undefined),
        set: jest.fn().mockResolvedValue(undefined)
      }
    };

    const db = {
      get: jest.fn().mockResolvedValue({ recruiter_id: 'recruiter-1' }),
      run: jest.fn().mockResolvedValue(undefined)
    };
    const guild = { id: 'guild-1' };

    await promoteMember({ member, db, guild, verifierId: 'verifier-1' });

    expect(member.roles.remove).toHaveBeenCalledTimes(1);
    expect(member.roles.remove.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['role_rookie', 'role_onboarding_fire'])
    );
    expect(member.roles.add).toHaveBeenCalledTimes(1);
    expect(member.roles.add.mock.calls[0][0]).toEqual(
      expect.arrayContaining(['role_solace', 'role_team_eu'])
    );
    expect(member.roles.set).not.toHaveBeenCalled();
  });

  test('falls back to roles.set when granular operations are unavailable', async () => {
    const member = {
      id: 'member-2',
      nickname: 'Player 7/10',
      user: { username: 'Player' },
      guild: { id: 'guild-role-id' },
      setNickname: jest.fn().mockResolvedValue(undefined),
      roles: {
        cache: createRoleCache([
          'role_rookie',
          'role_onboarding_fire',
          'role_custom_b'
        ]),
        set: jest.fn().mockResolvedValue(undefined)
      }
    };

    const db = {
      get: jest.fn().mockResolvedValue({ recruiter_id: 'recruiter-2' }),
      run: jest.fn().mockResolvedValue(undefined)
    };
    const guild = { id: 'guild-2' };

    await promoteMember({ member, db, guild, verifierId: 'verifier-2' });

    expect(member.roles.set).toHaveBeenCalledTimes(1);
    const finalRoleIds = member.roles.set.mock.calls[0][0];
    expect(finalRoleIds).toEqual(expect.arrayContaining(['role_custom_b', 'role_solace', 'role_team_eu']));
    expect(finalRoleIds).not.toEqual(expect.arrayContaining(['role_rookie', 'role_onboarding_fire']));
  });
});

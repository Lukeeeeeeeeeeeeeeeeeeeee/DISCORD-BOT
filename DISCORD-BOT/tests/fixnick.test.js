jest.mock('../src/constants', () => ({
  GUILD_ID: 'guild-1',
  TESTING_USER_ID: 'owner-1',
  ROLE_IDS: {
    ROOKIE: 'rookie-role',
    AUTO_PROMOTE_ROLE: 'member-role'
  },
  REGION_ROLE_IDS: {
    EU: 'region-eu',
    NA: 'region-na',
    AS: 'region-as',
    ME: 'region-me'
  },
  ACTIVITY_CHECK: {
    TEAM_TO_INACTIVE_ROLE: {
      EU: 'inactive-eu',
      NA: 'inactive-na',
      AS: 'inactive-as'
    }
  }
}));

jest.mock('../src/lib/embeds', () => ({
  replyError: jest.fn(async () => null)
}));

const command = require('../src/commands/fixnick');

describe('fixnick IGN parser', () => {
  const { extractIgn } = command._private;

  test.each([
    ['EU | BlockyArla', 'BlockyArla'],
    ['0/10 | RevEngiMC', 'RevEngiMC'],
    ['Purify__ | EU 0/10', 'Purify__'],
    ['FanatWhiteEagle | EU | 0/10', 'FanatWhiteEagle'],
    ['Ashbracker | EU 0/10', 'Ashbracker'],
    ['KzzLikeTha 0/10', 'KzzLikeTha'],
    ['DeterminationMC | EU 💧', 'DeterminationMC'],
    ['Skilldified | EU', 'Skilldified'],
    ['Snip1r | EU', 'Snip1r'],
    ['Linalise | 0/10 NA', 'Linalise'],
    ['BalisticSniper | 0/10 EU', 'BalisticSniper'],
    ['EU | AvoidMyCritz', 'AvoidMyCritz'],
    ['0/2 | ielajah', 'ielajah']
  ])('extracts IGN from "%s"', (raw, expected) => {
    expect(extractIgn(raw)).toBe(expected);
  });
});

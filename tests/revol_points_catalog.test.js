const { ECONOMY_CONFIG, calculateRecruitPoints } = require('../src/lib/economy');
const { PURCHASE_ITEMS, APPROVAL_ONLY_ITEMS } = require('../src/constants');

describe('REVOL points and multipliers catalog', () => {
  test('multiplier catalog matches expected values', () => {
    const expected = {
      'm1.5_7d': { value: 1.5, cost: 2, days: 7 },
      'm1.75_7d': { value: 1.75, cost: 3, days: 7 },
      'm2.0_7d': { value: 2.0, cost: 4, days: 7 },
      'm2.5_7d': { value: 2.5, cost: 6, days: 7 },
      'm1.5_14d': { value: 1.5, cost: 6, days: 14 },
      'm2.0_14d': { value: 2.0, cost: 8, days: 14 }
    };

    expect(ECONOMY_CONFIG.MULTIPLIERS).toEqual(expected);
  });

  test('reward catalog matches expected values', () => {
    expect(PURCHASE_ITEMS).toMatchObject({
      'custom-nickname': 10,
      'vip': 15,
      'mvp': 20,
      'custom-vc': 20,
      'custom-role': 25
    });

    expect(PURCHASE_ITEMS['custom-suggestion']).toBeUndefined();
    expect(APPROVAL_ONLY_ITEMS['custom-suggestion']).toMatch(/approved by staff/i);
  });

  test('recruit point calculation uses active multiplier values', () => {
    expect(calculateRecruitPoints({ multiplierValue: 1.0 })).toBe(1);
    expect(calculateRecruitPoints({ multiplierValue: 1.5 })).toBe(1.5);
    expect(calculateRecruitPoints({ multiplierValue: 1.75 })).toBe(1.75);
    expect(calculateRecruitPoints({ multiplierValue: 2.0 })).toBe(2);
    expect(calculateRecruitPoints({ multiplierValue: 2.5 })).toBe(2.5);
  });
});

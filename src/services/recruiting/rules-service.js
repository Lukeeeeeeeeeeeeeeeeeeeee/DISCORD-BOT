const RECRUITING_RULES = Object.freeze({
  TARGET_RECRUITS_PER_WEEK: 8,
  MIN_MIN_REQ: 2,
  MAX_MIN_REQ: 8,
  BASE_RECRUIT_POINTS: 1
});

const ROOKIE_CHAT_RULES = Object.freeze({
  MESSAGES_PER_BLOCK: 105,
  POINTS_PER_BLOCK: 1.5
});

const ROOKIE_WAR_RULES = Object.freeze({
  POINTS: 5,
  WINDOW_DAYS: 14,
  MAX_PER_WINDOW: 2
});

function normalizeMultiplierValue(multiplierValue) {
  const parsed = Number(multiplierValue);
  if (!Number.isFinite(parsed) || parsed <= 0) return 1.0;
  return parsed;
}

function calculateRecruitPoints({
  basePoints = RECRUITING_RULES.BASE_RECRUIT_POINTS,
  multiplierValue = 1.0
} = {}) {
  const base = Number(basePoints);
  const safeBase = Number.isFinite(base) && base > 0 ? base : RECRUITING_RULES.BASE_RECRUIT_POINTS;
  const multiplier = normalizeMultiplierValue(multiplierValue);
  const raw = safeBase * multiplier;
  return Math.round(raw * 100) / 100;
}

module.exports = {
  RECRUITING_RULES,
  ROOKIE_CHAT_RULES,
  ROOKIE_WAR_RULES,
  calculateRecruitPoints,
  normalizeMultiplierValue
};

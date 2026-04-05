const DEFAULT_WEEK_OFFSET_MS = 5 * 60 * 1000;
const SEVEN_DAYS_MS = 7 * 24 * 60 * 60 * 1000;

function getWeekStartUtcTs(now = new Date(), offsetMs = DEFAULT_WEEK_OFFSET_MS) {
  const date = new Date(now);
  if (Number.isFinite(offsetMs) && offsetMs) {
    date.setTime(date.getTime() - offsetMs);
  }
  const day = date.getUTCDay();
  const diffToMonday = (day + 6) % 7;
  const weekStart = new Date(Date.UTC(
    date.getUTCFullYear(),
    date.getUTCMonth(),
    date.getUTCDate(),
    0, 0, 0, 0
  ));
  weekStart.setUTCDate(weekStart.getUTCDate() - diffToMonday);
  return weekStart.getTime();
}

function getRolling7DayStartTs(now = Date.now()) {
  const baseMs = now instanceof Date ? now.getTime() : Number(now);
  const safeNow = Number.isFinite(baseMs) ? baseMs : Date.now();
  return safeNow - SEVEN_DAYS_MS;
}

module.exports = { getWeekStartUtcTs, getRolling7DayStartTs, SEVEN_DAYS_MS };

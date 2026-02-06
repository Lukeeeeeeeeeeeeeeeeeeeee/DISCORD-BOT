const DEFAULT_WEEK_OFFSET_MS = 5 * 60 * 1000;

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
  return weekStart.getTime() + (Number.isFinite(offsetMs) ? offsetMs : 0);
}

module.exports = { getWeekStartUtcTs };

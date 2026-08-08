function toUnixSeconds(ms) {
  const ts = Number.isFinite(ms) ? ms : Date.now();
  return Math.floor(ts / 1000);
}

function formatUtcDate(ms) {
  const ts = Number.isFinite(ms) ? ms : Date.now();
  return new Date(ts).toISOString();
}

function formatUtcDateOnly(ms) {
  return formatUtcDate(ms).slice(0, 10);
}

function formatDiscordTimestamp(ms, style = 'R') {
  if (!Number.isFinite(ms)) return 'N/A';
  return `<t:${toUnixSeconds(ms)}:${style}>`;
}

module.exports = {
  toUnixSeconds,
  formatUtcDate,
  formatUtcDateOnly,
  formatDiscordTimestamp
};

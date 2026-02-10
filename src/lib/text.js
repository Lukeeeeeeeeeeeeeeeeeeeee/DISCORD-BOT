function clampText(input, maxLen) {
  const str = input == null ? '' : String(input);
  if (!maxLen || str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  return `${str.slice(0, maxLen - 3)}...`;
}

function escapeMentions(input) {
  const str = input == null ? '' : String(input);
  return str.replace(/@/g, '@\u200b');
}

function sanitizeForEmbed(input, maxLen = 1024) {
  return clampText(escapeMentions(input), maxLen);
}

module.exports = { clampText, escapeMentions, sanitizeForEmbed };

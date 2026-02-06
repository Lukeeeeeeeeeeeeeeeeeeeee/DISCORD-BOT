function clampText(input, maxLen) {
  const str = input == null ? '' : String(input);
  if (!maxLen || str.length <= maxLen) return str;
  if (maxLen <= 3) return str.slice(0, maxLen);
  return `${str.slice(0, maxLen - 3)}...`;
}

module.exports = { clampText };

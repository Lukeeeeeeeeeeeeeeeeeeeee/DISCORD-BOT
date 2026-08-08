const { REGION_INFO, REGIONS } = require('../constants');

const DEFAULT_REGION = { name: 'Unknown', emoji: '', color: 0x00AAFF };

function getRegionInfo(code) {
  if (!code) return { ...DEFAULT_REGION };
  const info = REGION_INFO && REGION_INFO[code] ? REGION_INFO[code] : null;
  if (!info) return { ...DEFAULT_REGION, name: code };
  return { ...DEFAULT_REGION, ...info };
}

function getTeamLabel(code) {
  const info = getRegionInfo(code);
  const label = info.emoji ? `${info.emoji} ${info.name}` : info.name;
  return label || code;
}

function normalizeRegionInput(input) {
  if (!input) return null;
  const upper = String(input).toUpperCase();
  if (REGIONS && REGIONS.includes(upper)) return upper;
  for (const [code, info] of Object.entries(REGION_INFO || {})) {
    if (info && info.name && String(info.name).toUpperCase() === upper) return code;
  }
  return null;
}

module.exports = {
  getRegionInfo,
  getTeamLabel,
  normalizeRegionInput
};

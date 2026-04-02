const fs = require('fs');
const path = require('path');

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function deepMerge(base, override) {
  if (!isPlainObject(override)) return { ...base };
  const output = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (value === undefined) continue;
    if (isPlainObject(value) && isPlainObject(base[key])) {
      output[key] = deepMerge(base[key], value);
    } else {
      output[key] = value;
    }
  }
  return output;
}

function readJsonConfig(filePath, opts = {}) {
  if (!filePath) return null;
  const explicit = opts.explicit === true;
  const strict = opts.strict === true;

  if (!fs.existsSync(filePath)) {
    if (explicit && strict) {
      throw new Error(`Configured guild config file was not found: ${filePath}`);
    }
    return null;
  }

  try {
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (error) {
    if (!strict) return null;
    const message = error && error.message ? error.message : String(error);
    throw new Error(`Failed to parse guild config at ${filePath}: ${message}`);
  }
}

function resolveConfigPath(env = process.env, cwd = process.cwd()) {
  const envPath = env.GUILD_CONFIG_PATH || env.CONFIG_PATH;
  if (envPath) return envPath;

  const candidates = [
    path.join(cwd, 'config.json'),
    path.join(cwd, 'config.local.json'),
    path.join(__dirname, '..', 'config.json')
  ];

  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function mapKeys(input, keyMap) {
  const out = {};
  if (!isPlainObject(input)) return out;
  for (const [key, value] of Object.entries(input)) {
    const mapped = keyMap[key] || key;
    out[mapped] = value;
  }
  return out;
}

function normalizeRoleIds(rawRoleIds) {
  const keyMap = {
    onboarding: 'ONBOARDING',
    onboarding_fire: 'ONBOARDING_FIRE',
    onboarding_water: 'ONBOARDING_WATER',
    onboarding_air: 'ONBOARDING_AIR',
    rookie: 'ROOKIE',
    unverified: 'UNVERIFIED',
    auto_promote_role: 'AUTO_PROMOTE_ROLE',
    solace: 'SOLACE',
    recruiter: 'RECRUITER',
    trial_recruiter: 'TRIAL_RECRUITER',
    helper: 'HELPER',
    helper_plus: 'HELPER_PLUS',
    high_staff: 'HIGH_STAFF',
    mod: 'MOD',
    chief: 'CHIEF',
    chief_of_war: 'CHIEF_OF_WAR',
    chief_of_community: 'CHIEF_OF_COMMUNITY',
    chief_of_recruitment: 'CHIEF_OF_RECRUITMENT',
    co_leader: 'CO_LEADER',
    leader: 'LEADER',
    staff: 'STAFF',
    staff_roles: 'STAFF',
    vip: 'VIP',
    mvp: 'MVP',
    custom: 'CUSTOM',
    team_member: 'TEAM_MEMBER'
  };
  return mapKeys(rawRoleIds, keyMap);
}

function normalizeChannels(rawChannels) {
  const keyMap = {
    log_invites_overall: 'INVITES_OVERALL',
    invites_overall: 'INVITES_OVERALL',
    invites_eu: 'INVITES_EU',
    invites_na: 'INVITES_NA',
    invites_as: 'INVITES_AS',
    recruiter_warnings: 'RECRUITER_WARNINGS',
    central_leaderboard: 'CENTRAL_LEADERBOARD',
    rookie_logs: 'ROOKIE_LOGS',
    economy_notifications: 'ECONOMY_NOTIFICATIONS'
  };
  return mapKeys(rawChannels, keyMap);
}

function toStringArray(value) {
  if (!Array.isArray(value)) return [];
  return value
    .map((item) => (item == null ? '' : String(item).trim()))
    .filter(Boolean);
}

function normalizeActivityCheck(rawActivityCheck) {
  if (!isPlainObject(rawActivityCheck)) return {};
  const keyMap = {
    ownerIds: 'OWNER_IDS',
    owner_ids: 'OWNER_IDS',
    teamToInactiveRole: 'TEAM_TO_INACTIVE_ROLE',
    team_to_inactive_role: 'TEAM_TO_INACTIVE_ROLE',
    inactiveRoleIds: 'TEAM_TO_INACTIVE_ROLE',
    inactive_role_ids: 'TEAM_TO_INACTIVE_ROLE',
    inactiveRolePool: 'INACTIVE_ROLE_POOL',
    inactive_role_pool: 'INACTIVE_ROLE_POOL',
    inactiveRoles: 'INACTIVE_ROLE_POOL',
    inactive_roles: 'INACTIVE_ROLE_POOL',
    targetRoleIds: 'TARGET_ROLE_IDS',
    target_role_ids: 'TARGET_ROLE_IDS',
    preserveRoleIds: 'PRESERVE_ROLE_IDS',
    preserve_role_ids: 'PRESERVE_ROLE_IDS',
    exemptRoleIds: 'EXEMPT_ROLE_IDS',
    exempt_role_ids: 'EXEMPT_ROLE_IDS',
    preserveRegionRoles: 'PRESERVE_REGION_ROLES',
    preserve_region_roles: 'PRESERVE_REGION_ROLES',
    preserveOnboardingRoles: 'PRESERVE_ONBOARDING_ROLES',
    preserve_onboarding_roles: 'PRESERVE_ONBOARDING_ROLES',
    preserveStaffRoles: 'PRESERVE_STAFF_ROLES',
    preserve_staff_roles: 'PRESERVE_STAFF_ROLES'
  };
  const mapped = mapKeys(rawActivityCheck, keyMap);
  const out = {};

  if (mapped.OWNER_IDS !== undefined) out.OWNER_IDS = toStringArray(mapped.OWNER_IDS);
  if (mapped.INACTIVE_ROLE_POOL !== undefined) out.INACTIVE_ROLE_POOL = toStringArray(mapped.INACTIVE_ROLE_POOL);
  if (mapped.TARGET_ROLE_IDS !== undefined) out.TARGET_ROLE_IDS = toStringArray(mapped.TARGET_ROLE_IDS);
  if (mapped.PRESERVE_ROLE_IDS !== undefined) out.PRESERVE_ROLE_IDS = toStringArray(mapped.PRESERVE_ROLE_IDS);
  if (mapped.EXEMPT_ROLE_IDS !== undefined) out.EXEMPT_ROLE_IDS = toStringArray(mapped.EXEMPT_ROLE_IDS);

  const teamMapRaw = mapped.TEAM_TO_INACTIVE_ROLE;
  if (isPlainObject(teamMapRaw)) {
    const teamMap = {};
    for (const [key, value] of Object.entries(teamMapRaw)) {
      if (value == null) continue;
      const normKey = String(key || '').trim().toUpperCase();
      const normValue = String(value || '').trim();
      if (!normKey || !normValue) continue;
      teamMap[normKey] = normValue;
    }
    out.TEAM_TO_INACTIVE_ROLE = teamMap;
  } else if (Array.isArray(teamMapRaw)) {
    out.INACTIVE_ROLE_POOL = toStringArray(teamMapRaw);
  }

  for (const key of ['PRESERVE_REGION_ROLES', 'PRESERVE_ONBOARDING_ROLES', 'PRESERVE_STAFF_ROLES']) {
    if (mapped[key] !== undefined) out[key] = Boolean(mapped[key]);
  }

  return out;
}

function normalizeConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) return {};

  const normalized = {};

  if (rawConfig.GUILD_ID || rawConfig.guildId) {
    normalized.GUILD_ID = rawConfig.GUILD_ID || rawConfig.guildId;
  }
  if (rawConfig.TESTING_USER_ID || rawConfig.testingUserId) {
    normalized.TESTING_USER_ID = rawConfig.TESTING_USER_ID || rawConfig.testingUserId;
  }
  if (rawConfig.BRAND_NAME || rawConfig.brandName) {
    normalized.BRAND_NAME = rawConfig.BRAND_NAME || rawConfig.brandName;
  }
  if (rawConfig.BRAND_ROOKIE_HEADER_ICON !== undefined || rawConfig.brandRookieHeaderIcon !== undefined) {
    normalized.BRAND_ROOKIE_HEADER_ICON = rawConfig.BRAND_ROOKIE_HEADER_ICON !== undefined
      ? rawConfig.BRAND_ROOKIE_HEADER_ICON
      : rawConfig.brandRookieHeaderIcon;
  }

  if (rawConfig.ROLE_IDS || rawConfig.roleIds) {
    const roleIds = {
      ...(isPlainObject(rawConfig.ROLE_IDS) ? rawConfig.ROLE_IDS : {}),
      ...normalizeRoleIds(rawConfig.roleIds)
    };
    if (Object.keys(roleIds).length) normalized.ROLE_IDS = roleIds;
  }

  if (rawConfig.RECRUITER_ROLE_IDS || rawConfig.recruiterRoleIds || (rawConfig.roleIds && rawConfig.roleIds.recruiter_roles)) {
    normalized.RECRUITER_ROLE_IDS = {
      ...(isPlainObject(rawConfig.RECRUITER_ROLE_IDS) ? rawConfig.RECRUITER_ROLE_IDS : {}),
      ...(isPlainObject(rawConfig.recruiterRoleIds) ? rawConfig.recruiterRoleIds : {}),
      ...(isPlainObject(rawConfig.roleIds && rawConfig.roleIds.recruiter_roles) ? rawConfig.roleIds.recruiter_roles : {})
    };
  }

  if (rawConfig.REGION_ROLE_IDS || rawConfig.regionRoleIds || (rawConfig.roleIds && rawConfig.roleIds.region_roles)) {
    normalized.REGION_ROLE_IDS = {
      ...(isPlainObject(rawConfig.REGION_ROLE_IDS) ? rawConfig.REGION_ROLE_IDS : {}),
      ...(isPlainObject(rawConfig.regionRoleIds) ? rawConfig.regionRoleIds : {}),
      ...(isPlainObject(rawConfig.roleIds && rawConfig.roleIds.region_roles) ? rawConfig.roleIds.region_roles : {})
    };
  }

  if (rawConfig.CHANNELS || rawConfig.channels) {
    const channels = {
      ...(isPlainObject(rawConfig.CHANNELS) ? rawConfig.CHANNELS : {}),
      ...normalizeChannels(rawConfig.channels)
    };
    if (Object.keys(channels).length) normalized.CHANNELS = channels;
  }

  if (rawConfig.REGION_INFO || rawConfig.regionInfo) {
    normalized.REGION_INFO = {
      ...(isPlainObject(rawConfig.REGION_INFO) ? rawConfig.REGION_INFO : {}),
      ...(isPlainObject(rawConfig.regionInfo) ? rawConfig.regionInfo : {})
    };
  }

  if (rawConfig.ACTIVITY_CHECK || rawConfig.activityCheck) {
    normalized.ACTIVITY_CHECK = {
      ...(isPlainObject(rawConfig.ACTIVITY_CHECK) ? rawConfig.ACTIVITY_CHECK : {}),
      ...normalizeActivityCheck(rawConfig.activityCheck)
    };
  }

  for (const key of [
    'MIN_RECRUITS_FOR_AUTO',
    'MIN_LEADERBOARD_ENTRIES',
    'EXEMPT_TOP_PERCENT',
    'REPEATED_FLAGS_TO_WARN',
    'ESCALATION_WINDOW_WEEKS',
    'REGIONS',
    'PURCHASE_ITEMS',
    'APPROVAL_ONLY_ITEMS',
    'PURCHASE_ITEM_ALIASES'
  ]) {
    if (rawConfig[key] !== undefined) normalized[key] = rawConfig[key];
  }

  return normalized;
}

function applyDerivedRoleIds(config) {
  if (!config || !config.ROLE_IDS) return config;
  const roleIds = { ...config.ROLE_IDS };
  if (Array.isArray(roleIds.ONBOARDING)) {
    if (roleIds.ONBOARDING[0]) roleIds.ONBOARDING_FIRE = roleIds.ONBOARDING[0];
    if (roleIds.ONBOARDING[1]) roleIds.ONBOARDING_WATER = roleIds.ONBOARDING[1];
    if (roleIds.ONBOARDING[2]) roleIds.ONBOARDING_AIR = roleIds.ONBOARDING[2];
  }
  if (roleIds.AUTO_PROMOTE_ROLE) roleIds.SOLACE = roleIds.AUTO_PROMOTE_ROLE;
  if (!Array.isArray(roleIds.STAFF) || roleIds.STAFF.length === 0) {
    roleIds.STAFF = [
      roleIds.HELPER,
      roleIds.HELPER_PLUS,
      roleIds.HIGH_STAFF,
      roleIds.MOD,
      roleIds.CHIEF,
      roleIds.CHIEF_OF_WAR,
      roleIds.CHIEF_OF_COMMUNITY,
      roleIds.CHIEF_OF_RECRUITMENT,
      roleIds.CO_LEADER,
      roleIds.LEADER
    ].filter(Boolean);
  } else {
    roleIds.STAFF = roleIds.STAFF.filter(Boolean);
  }
  return { ...config, ROLE_IDS: roleIds };
}

function loadGuildConfig(base, opts = {}) {
  const env = opts.env || process.env;
  const cwd = opts.cwd || process.cwd();
  const configPath = resolveConfigPath(env, cwd);
  const explicitPath = env.GUILD_CONFIG_PATH || env.CONFIG_PATH;
  const strictConfig = String(env.CONFIG_STRICT || '').trim().toLowerCase() === 'false'
    ? false
    : true;
  const rawConfig = readJsonConfig(configPath, {
    explicit: Boolean(explicitPath),
    strict: strictConfig
  });
  const envGuildId = env.GUILD_ID;
  const baseGuildId = envGuildId || (rawConfig && (rawConfig.guildId || rawConfig.GUILD_ID)) || base.GUILD_ID;

  let selectedRaw = rawConfig;
  if (rawConfig && rawConfig.guilds && baseGuildId && rawConfig.guilds[baseGuildId]) {
    const { guilds, ...rootConfig } = rawConfig;
    void guilds;
    selectedRaw = deepMerge(rootConfig, rawConfig.guilds[baseGuildId]);
  }

  const overrides = normalizeConfig(selectedRaw);
  let merged = deepMerge(base, overrides);
  merged.GUILD_ID = baseGuildId;
  merged = applyDerivedRoleIds(merged);

  return {
    configPath,
    config: merged
  };
}

module.exports = {
  loadGuildConfig,
  resolveConfigPath,
  readJsonConfig,
  normalizeConfig
};

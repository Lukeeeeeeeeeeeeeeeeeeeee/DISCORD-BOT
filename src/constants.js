const fs = require('fs');
const path = require('path');

const BASE = {
  GUILD_ID: "1331020304763453522",
  ROLE_IDS: {
    // Onboarding roles: [0]=Fire/EU, [1]=Water/NA, [2]=Air/AS
    ONBOARDING: ["1473726606634909829", "1473726616025694419", "1473726598300700796"],
    // Onboarding role IDs for easy lookup
    ONBOARDING_FIRE: "1473726606634909829",
    ONBOARDING_WATER: "1473726616025694419",
    ONBOARDING_AIR: "1473726598300700796",
    ROOKIE: "1412808625529028767",
    UNVERIFIED: "1412808625495212098",
    AUTO_PROMOTE_ROLE: "1412808625747132501",
    SOLACE: "1412808625747132501",
    TEAM_MEMBER: {
      EU: "1473726632769622173",
      NA: "1473726640939991261",
      AS: "1473726626733756438"
    },
    VIP: "1463546680832954379",
    MVP: "1463546673883250688",
    CUSTOM: "1331020540982460466",
    RECRUITER: "1412808626040733738",
    TRIAL_RECRUITER: "1421549298033627156",
    HELPER: "1412808626099323003",
    HELPER_PLUS: "1412808626099323004",
    HIGH_STAFF: "1474124708923572387",
    MOD: "1412808626136940575",
    CHIEF: "1455704259491532961",
    CHIEF_OF_WAR: "1455705998843973693",
    CHIEF_OF_COMMUNITY: "1455705920813142016",
    CHIEF_OF_RECRUITMENT: "1455706002237161492",
    CO_LEADER: "1412808626136940579",
    LEADER: "1412808626136940580"
  },
  RECRUITER_ROLE_IDS: {
    EU: "1473726977105072314",
    NA: "1473726986508833061",
    AS: "1473726967277686854"
  },
  REGION_ROLE_IDS: {
    EU: "1412808625495212104",
    ME: "1422204219061960794",
    NA: "1412808625495212103",
    AS: "1412808625495212102",
    AF: "",
    SA: ""
  },
  CHANNELS: {
    INVITES_OVERALL: "1412808632554225690",
    ECONOMY_NOTIFICATIONS: "1412808632176869523",
    INVITES_EU: "1474125637345349854",
    INVITES_NA: "1473726188974379028",
    INVITES_AS: "1473726149552111747",
    RECRUITER_WARNINGS: "1474126888166359171",
    CENTRAL_LEADERBOARD: "1412808632554225690",
    ROOKIE_LOGS: ""
  },
  MIN_RECRUITS_FOR_AUTO: 5,
  MIN_LEADERBOARD_ENTRIES: 5,
  EXEMPT_TOP_PERCENT: 0.10,
  REPEATED_FLAGS_TO_WARN: 2,
  ESCALATION_WINDOW_WEEKS: 4,
  REGIONS: ['EU', 'NA', 'AS'],
  REGION_INFO: {
    EU: { name: 'Fire', emoji: '🔥', color: 0xE25822, thumbnail: '' },
    NA: { name: 'Water', emoji: '💧', color: 0x1E90FF, thumbnail: '' },
    AS: { name: 'Air', emoji: '�️', color: 0x8E44AD, thumbnail: '' }
  },
  PURCHASE_ITEMS: {
    'nickname': 30,
    'custom-vc': 25,
    'custom-role': 50,
    'custom-suggestion': 100,
    'vip-role': 25,
    'mvp-role': 35
  },
  RECRUIT_POLICY: {
    // Set to 0 or negative to disable the check.
    MAX_JOIN_MINUTES: 120,
    // Set to 0 or negative to disable the check.
    MIN_ACCOUNT_AGE_DAYS: 180
  }
};

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

function tryReadJson(filePath) {
  if (!filePath) return null;
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = fs.readFileSync(filePath, 'utf8');
    if (!raw || !raw.trim()) return null;
    return JSON.parse(raw);
  } catch (e) {
    return null;
  }
}

function resolveConfigPath() {
  const envPath = process.env.GUILD_CONFIG_PATH || process.env.CONFIG_PATH;
  if (envPath) return envPath;
  const cwd = process.cwd();
  const candidates = [
    path.join(cwd, 'config.json'),
    path.join(cwd, 'config.local.json'),
    path.join(__dirname, 'config.json')
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

function normalizeConfig(rawConfig) {
  if (!isPlainObject(rawConfig)) return {};

  const normalized = {};

  if (rawConfig.GUILD_ID || rawConfig.guildId) {
    normalized.GUILD_ID = rawConfig.GUILD_ID || rawConfig.guildId;
  }
  if (rawConfig.RECRUIT_POLICY || rawConfig.recruitPolicy) {
    normalized.RECRUIT_POLICY = {
      ...(isPlainObject(rawConfig.RECRUIT_POLICY) ? rawConfig.RECRUIT_POLICY : {}),
      ...(isPlainObject(rawConfig.recruitPolicy) ? rawConfig.recruitPolicy : {})
    };
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

  const passthroughKeys = [
    'MIN_RECRUITS_FOR_AUTO',
    'MIN_LEADERBOARD_ENTRIES',
    'EXEMPT_TOP_PERCENT',
    'REPEATED_FLAGS_TO_WARN',
    'ESCALATION_WINDOW_WEEKS',
    'REGIONS',
    'PURCHASE_ITEMS',
    'RECRUIT_POLICY'
  ];
  for (const key of passthroughKeys) {
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

const configPath = resolveConfigPath();
const rawConfig = tryReadJson(configPath);
const envGuildId = process.env.GUILD_ID;
const baseGuildId = envGuildId || (rawConfig && (rawConfig.guildId || rawConfig.GUILD_ID)) || BASE.GUILD_ID;

let selectedRaw = rawConfig;
if (rawConfig && rawConfig.guilds && baseGuildId && rawConfig.guilds[baseGuildId]) {
  const { guilds, ...rootConfig } = rawConfig;
  void guilds;
  selectedRaw = deepMerge(rootConfig, rawConfig.guilds[baseGuildId]);
}

const overrides = normalizeConfig(selectedRaw);
let merged = deepMerge(BASE, overrides);
merged.GUILD_ID = baseGuildId;
merged = applyDerivedRoleIds(merged);

module.exports = merged;

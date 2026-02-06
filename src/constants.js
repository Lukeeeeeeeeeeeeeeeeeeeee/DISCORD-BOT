const fs = require('fs');
const path = require('path');

const BASE = {
  GUILD_ID: "1331020304763453522",
  TESTING_USER_ID: "1381692847018868778", // Your user ID for testing
  ROLE_IDS: {
    // Onboarding roles: [0]=Fire/EU, [1]=Water/NA, [2]=Air/AS
    ONBOARDING: ["1459878495290261839", "1459880782108692521", "1459880774168739892"],
    // Onboarding role IDs for easy lookup
    ONBOARDING_FIRE: "1459878495290261839",
    ONBOARDING_WATER: "1459880782108692521",
    ONBOARDING_AIR: "1459880774168739892",
    ROOKIE: "1331020584473329726",
    UNVERIFIED: "1331020591175565517",
    AUTO_PROMOTE_ROLE: "1331020565879984198",
    SOLACE: "1331020565879984198",
    TEAM_MEMBER: {
      EU: "1461039409456746678",
      NA: "1461039396596748328",
      AS: "1461039389642592393"
    },
    VIP: "1463546680832954379",
    MVP: "1463546673883250688",
    CUSTOM: "1331020540982460466",
    RECRUITER: "1331020553707847772",
    TRIAL_RECRUITER: "1459956798172827933",
    HELPER: "1331020542031171678",
    HELPER_PLUS: "1331020536611999846",
    HIGH_STAFF: "1331020520401141883",
    MOD: "1331020531218124803",
    CHIEF: "1331020521755775016",
    CHIEF_OF_WAR: "1459939643473793086",
    CHIEF_OF_COMMUNITY: "1459939634044866667",
    CHIEF_OF_RECRUITMENT: "1459939833857183937",
    CO_LEADER: "1331020513522225324",
    LEADER: "1331020511123079239"
  },
  RECRUITER_ROLE_IDS: {
    EU: "1331020554588917772",
    NA: "1331020555566059622",
    AS: "1331020556144869438"
  },
  REGION_ROLE_IDS: {
    EU: "1331020592564146296",
    ME: "1331020593671311380",
    NA: "1331020594833264684",
    AS: "1331020598058418268",
    AF: "1331020599346335775",
    SA: "1331020596804456528"
  },
  CHANNELS: {
    INVITES_OVERALL: "1331020749556809843",
    ECONOMY_NOTIFICATIONS: "1331020752597815457",
    INVITES_EU: "1331020760906731730",
    INVITES_NA: "1331020766296150190",
    INVITES_AS: "1331020771476242544",
    RECRUITER_WARNINGS: "1331020754090987570",
    CENTRAL_LEADERBOARD: "1331020755617710260",
    ROOKIE_LOGS: "1331020800551293030"
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
  if (rawConfig.TESTING_USER_ID || rawConfig.testingUserId) {
    normalized.TESTING_USER_ID = rawConfig.TESTING_USER_ID || rawConfig.testingUserId;
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
    'PURCHASE_ITEMS'
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

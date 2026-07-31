const {
  ROLE_IDS,
  RECRUITER_ROLE_IDS,
  REGION_ROLE_IDS,
  REGION_INFO,
  RECRUIT_POLICY
} = require('../../constants');
const { PermissionsBitField } = require('discord.js');
const { getRegionInfo, getTeamLabel } = require('../../lib/regions');
const { replyError } = require('../../lib/embeds');
const defaultDb = require('../../db_async');
const { getActiveMultiplier, calculateRecruitPoints, formatPointsValue } = require('../../lib/economy');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const { resolveGuildId } = require('../../lib/guild');
const { buildRecruitWelcomeMessage } = require('../../lib/join-welcome');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');
const { hasRecruiterOrStaffPermissions, hasAdministrator } = require('../../lib/permissions');
const { calculate7DayStats, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement } = require('../../lib/recruiting-system');
const { getWeekStartUtcTs } = require('../../lib/week');
const { withTransaction } = require('../../lib/transactions');
const recruitsRepo = require('../../repos/recruits-repo');
const rookiePointsRepo = require('../../repos/rookie-points-repo');
const trialFastTrackRepo = require('../../repos/trial-fast-track-repo');
const { changeRecruiterPoints } = require('./ledger-service');
const scheduler = require('../../scheduler');
const campaignService = require('../dm/dm-campaign-service');

function createTraceId() {
  return `recruit_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`;
}

function reportRecruitServiceError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'recruit',
    ...meta
  });
}

function inferTeamFromRecruiter(member) {
  if (!member || !member.roles || !member.roles.cache || typeof member.roles.cache.has !== 'function') return null;
  if (RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.EU && member.roles.cache.has(RECRUITER_ROLE_IDS.EU)) return 'EU';
  if (RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.NA && member.roles.cache.has(RECRUITER_ROLE_IDS.NA)) return 'NA';
  if (RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.AS && member.roles.cache.has(RECRUITER_ROLE_IDS.AS)) return 'AS';
  return null;
}

function inferRegionTagFromMember(member) {
  if (!member || !member.roles || !member.roles.cache || typeof member.roles.cache.has !== 'function') return null;
  const keys = ['EU', 'ME', 'NA', 'AS', 'AF', 'SA'];
  for (const k of keys) {
    const roleId = REGION_ROLE_IDS && REGION_ROLE_IDS[k] ? REGION_ROLE_IDS[k] : null;
    if (roleId && member.roles.cache.has(roleId)) return k;
  }
  return null;
}

function pickOnboardingRole(team) {
  if (team === 'EU' && ROLE_IDS.ONBOARDING_FIRE) return ROLE_IDS.ONBOARDING_FIRE;
  if (team === 'NA' && ROLE_IDS.ONBOARDING_WATER) return ROLE_IDS.ONBOARDING_WATER;
  if (team === 'AS' && ROLE_IDS.ONBOARDING_AIR) return ROLE_IDS.ONBOARDING_AIR;

  const list = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
  if (!list.length) return null;
  if (team === 'EU') return list[0];
  if (team === 'NA') return list[1];
  if (team === 'AS') return list[2];
  
  // Audit Fix: Explicit error instead of silent EU fallback.
  throw new Error(`Unknown mapping for team "${team}". Update ROLE_IDS.ONBOARDING configuration.`);
}


function normalizeIgn(rawIgn, suffix) {
  const base = rawIgn == null ? '' : String(rawIgn);
  const cleaned = base.replace(/\s+/g, ' ').trim();
  if (!suffix) return cleaned;
  // Audit Fix: Ensure at least 2 chars of base IGN remain before suffix.
  const maxLen = Math.max(2, 32 - suffix.length);
  if (cleaned.length > maxLen) return cleaned.slice(0, maxLen).trim();
  return cleaned;
}

function parseThreshold(value, fallback) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const num = Number(value);
  if (!Number.isFinite(num)) return fallback;
  return num;
}

function parseBoolean(value, fallback = false) {
  if (value === undefined || value === null || String(value).trim() === '') return !!fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return !!fallback;
}

function getRecruitPolicy() {
  const defaults = RECRUIT_POLICY || {};
  const maxJoinMinutes = parseThreshold(
    process.env.RECRUIT_MAX_JOIN_MINUTES,
    parseThreshold(defaults.MAX_JOIN_MINUTES, 120)
  );
  const minAccountAgeDays = parseThreshold(
    process.env.RECRUIT_MIN_ACCOUNT_AGE_DAYS,
    parseThreshold(defaults.MIN_ACCOUNT_AGE_DAYS, 180)
  );
  const allowLateAdminOverride = parseBoolean(
    process.env.RECRUIT_ALLOW_LATE_ADMIN_OVERRIDE,
    parseBoolean(defaults.ALLOW_LATE_ADMIN_OVERRIDE, true)
  );
  return {
    maxJoinMinutes,
    minAccountAgeDays,
    allowLateAdminOverride
  };
}

function formatJoinLimitMessage(maxJoinMinutes) {
  const hours = maxJoinMinutes / 60;
  const label = Number.isInteger(hours) ? String(hours) : String(Math.round(hours * 10) / 10);
  return `Cannot give roles to someone who joined more than ${label} hour${hours === 1 ? '' : 's'} ago.`;
}

function formatMinAccountAgeMessage(minAccountAgeDays) {
  if (Number(minAccountAgeDays) === 180) return 'Account must be at least 6 months old.';
  return `Account must be at least ${Math.round(minAccountAgeDays)} days old.`;
}

function isTransientSqliteError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('sqlite_busy')
    || msg.includes('sqlite_locked')
    || msg.includes('database is locked')
    || msg.includes('cannot start a transaction within a transaction');
}

function isSchemaMismatchError(err) {
  const msg = String((err && err.message) || '').toLowerCase();
  return msg.includes('no such column: guild_id')
    || msg.includes('no such table')
    || msg.includes('error in trigger');
}

async function resolveBotMember(guild, client) {
  if (!guild) return null;
  if (guild.members && guild.members.me) return guild.members.me;
  if (client && client.user && guild.members && typeof guild.members.fetch === 'function') {
    return guild.members.fetch(client.user.id).catch(() => null);
  }
  return null;
}

function hasManageRolesPermission(member) {
  if (!member || !member.permissions || typeof member.permissions.has !== 'function') return false;
  return member.permissions.has(PermissionsBitField.Flags.ManageRoles);
}

function hasManageNicknamesPermission(member) {
  if (!member || !member.permissions || typeof member.permissions.has !== 'function') return false;
  return member.permissions.has(PermissionsBitField.Flags.ManageNicknames);
}

function roleIsManageable(botMember, role) {
  if (!role || !botMember || !botMember.roles || !botMember.roles.highest) return false;
  return botMember.roles.highest.position > role.position;
}

async function storeMinReqSnapshotAfterPromotion(dbHandle, guild, recruiterMember) {
  try {
    const guildId = resolveGuildId(guild);
    const weekStart = getWeekStartUtcTs();
    const statsWindow = { sinceTs: weekStart - (7 * 24 * 60 * 60 * 1000), untilTs: weekStart };
    const currentStats = await calculate7DayStats(dbHandle, recruiterMember.id, guild || null, { ...statsWindow, guildId });

    const warnings = await dbHandle.get(
      'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
      guildId,
      recruiterMember.id,
      Date.now()
    );
    const activeWarnings = warnings ? warnings.c : 0;
    const absence = await dbHandle.get(
      'SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ? AND active = 1 AND end_date >= date("now")',
      guildId,
      recruiterMember.id
    );
    const roleBase = getBaseRequirement(recruiterMember);
    const calculatedMinReq = calculateMinRecruitsFixed({
      roleBase,
      member: recruiterMember,
      recruits7d: currentStats.recruits7d,
      activityRate: currentStats.activityRate,
      verifyRate: currentStats.verifyRate,
      retention: currentStats.retention,
      warnings: activeWarnings,
      previousMinReq: null,
      absent: !!absence,
      isNewStaff: false
    });

    await storeWeeklyCalculation(dbHandle, {
      guildId,
      recruiterId: recruiterMember.id,
      weekStart,
      recruits7d: currentStats.recruits7d,
      activityRate: currentStats.activityRate,
      verifyRate: currentStats.verifyRate,
      retention: currentStats.retention,
      warnings: activeWarnings,
      previousMinReq: null,
      calculatedMinReq,
      roleBase,
      isSnapshot: true
    });
  } catch (e) {
    reportRecruitServiceError('service.recruit.storeWeeklyCalcAfterPromotion', e);
  }
}

async function refreshCurrentWeekCalculationAfterRecruit(dbHandle, guild, recruiterMember) {
  if (!recruiterMember) return;
  try {
    const guildId = resolveGuildId(guild);
    const nowTs = Date.now();
    const weekStart = getWeekStartUtcTs();
    const statsWindow = { sinceTs: weekStart, untilTs: nowTs };
    const currentStats = await calculate7DayStats(dbHandle, recruiterMember.id, guild || null, { ...statsWindow, guildId });

    const warnings = await dbHandle.get(
      'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
      guildId,
      recruiterMember.id,
      nowTs
    );
    const activeWarnings = warnings ? Number(warnings.c || 0) : 0;
    const absence = await dbHandle.get(
      'SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ? AND active = 1 AND end_date >= date("now")',
      guildId,
      recruiterMember.id
    );
    const roleBase = getBaseRequirement(recruiterMember);

    const previousCalc = await dbHandle.get(
      'SELECT calculated_min_req FROM weekly_calculations WHERE guild_id = ? AND recruiter_id = ? AND week_start < ? ORDER BY week_start DESC LIMIT 1',
      guildId,
      recruiterMember.id,
      weekStart
    ).catch(() => null);
    const previousMinReq = previousCalc && previousCalc.calculated_min_req != null
      ? Number(previousCalc.calculated_min_req)
      : null;

    const calculatedMinReq = calculateMinRecruitsFixed({
      roleBase,
      member: recruiterMember,
      recruits7d: currentStats.recruits7d,
      activityRate: currentStats.activityRate,
      verifyRate: currentStats.verifyRate,
      retention: currentStats.retention,
      warnings: activeWarnings,
      previousMinReq,
      absent: !!absence,
      isNewStaff: false
    });

    await storeWeeklyCalculation(dbHandle, {
      guildId,
      recruiterId: recruiterMember.id,
      weekStart,
      recruits7d: currentStats.recruits7d,
      activityRate: currentStats.activityRate,
      verifyRate: currentStats.verifyRate,
      retention: currentStats.retention,
      warnings: activeWarnings,
      absent: !!absence,
      previousMinReq,
      calculatedMinReq,
      roleBase
    });
  } catch (e) {
    reportRecruitServiceError('service.recruit.refreshCurrentWeekCalculation', e);
  }
}

async function updateTrialFastTrack(dbHandle, guild, recruiterMember, recruitedId, interactionUserId) {
  if (!recruiterMember || !recruiterMember.roles || !recruiterMember.roles.cache) return { promoted: false };
  if (!recruiterMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)) return { promoted: false };
  if (!recruiterMember.roles.cache.has(ROLE_IDS.ROOKIE)) return { promoted: false };

  // 1 recruit = 1 rookie point
  const { addRookiePoints } = require('../../lib/rookie-points');
  const result = await addRookiePoints({
    db: dbHandle,
    member: recruiterMember,
    delta: 1,
    guild,
    verifierId: interactionUserId
  });

  if (result.promoted) {
    // Already promoted to Member by addRookiePoints (via promoteMember).
    // Now add RECRUITER role and remove TRIAL_RECRUITER role.
    const botMember = await resolveBotMember(guild, recruiterMember.client);
    
    // Determine which recruiter role to give based on region
    let recruiterRoleId = null;
    try {
      const guildId = resolveGuildId(guild);
      const rows = await dbHandle.all(
        'SELECT region, COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 GROUP BY region ORDER BY c DESC',
        guildId,
        recruiterMember.id
      );
      const topRegion = rows && rows.length ? rows[0].region : null;
      recruiterRoleId = topRegion ? RECRUITER_ROLE_IDS[topRegion] : null;
    } catch (e) {
      recruiterRoleId = null;
    }

    const rolesToAdd = [ROLE_IDS.RECRUITER, recruiterRoleId]
      .filter(Boolean)
      .filter(roleId => !recruiterMember.roles.cache.has(roleId));

    const safeRolesToAdd = [];
    for (const rid of rolesToAdd) {
      const role = guild.roles.cache.get(rid);
      if (role && roleIsManageable(botMember, role)) {
        safeRolesToAdd.push(rid);
      } else if (role) {
        logRuntimeEvent('warn', 'service.recruit.promotion.hierarchy', 'Skipping role grant: Bot too low in hierarchy', { 
          recruiterId: recruiterMember.id, roleName: role.name 
        });
      }
    }

    try {
      if (safeRolesToAdd.length) {
        await recruiterMember.roles.add(safeRolesToAdd, 'Trial recruiter reached 2/2 rookie points');
      }
      if (ROLE_IDS.TRIAL_RECRUITER && recruiterMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)) {
        const trialRole = guild.roles.cache.get(ROLE_IDS.TRIAL_RECRUITER);
        if (trialRole && roleIsManageable(botMember, trialRole)) {
          await recruiterMember.roles.remove(ROLE_IDS.TRIAL_RECRUITER, 'Trial recruiter auto-promotion');
        }
      }
    } catch (err) {
      reportRecruitServiceError('service.recruit.trialPromotion.applyRoles', err, { recruiterId: recruiterMember.id });
    }
    
    void logRuntimeEvent('info', 'service.recruit.promotion.success', 'Trial recruiter auto-promoted successfully', {
      recruiterId: recruiterMember.id, roles: safeRolesToAdd
    });
    
    return { promoted: true };
  }

  return { promoted: false };
}

async function execute(interaction, _client, dbHandle = null) {
  const db = dbHandle || defaultDb;
  const traceId = createTraceId();
  try {
    let didDefer = false;
    const respond = async (payload) => {
      if (didDefer && typeof interaction.editReply === 'function') return interaction.editReply(payload);
      if (typeof interaction.reply === 'function') return interaction.reply(payload);
      if (typeof interaction.editReply === 'function') return interaction.editReply(payload);
      return null;
    };

    if (!interaction.deferred && !interaction.replied && typeof interaction.deferReply === 'function') {
      await interaction.deferReply();
      didDefer = true;
    }

    const member = interaction.options.getUser('member');
    const rawIgn = interaction.options.getString('ign');
    const creditedRecruiter = interaction.options.getUser('credit_to')
      || interaction.options.getUser('recruiter')
      || null;
    const creditedRecruiterId = creditedRecruiter ? creditedRecruiter.id : interaction.user.id;
    const isCreditOverride = creditedRecruiterId !== interaction.user.id;
    const adminBypass = typeof interaction.options.getBoolean === 'function'
      ? (interaction.options.getBoolean('admin_bypass') || false)
      : false;

    if (!member || !rawIgn) {
      return replyError(interaction, 'Missing required parameters. Please provide member and ign.');
    }

    if (!interaction.guild) {
      return replyError(interaction, 'This command can only be used in a server.');
    }

    const guildId = resolveGuildId(interaction.guild);
    const botMember = await resolveBotMember(interaction.guild, interaction.client);
    if (!botMember) {
      return replyError(interaction, 'Unable to verify bot permissions in this guild.');
    }
    if (!hasManageRolesPermission(botMember)) {
      return replyError(interaction, 'Missing Manage Roles permission. Please update the bot permissions and try again.');
    }

    const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
    if (!guildMember) {
      return replyError(interaction, 'Unable to verify your guild membership.');
    }

    if (!hasRecruiterOrStaffPermissions(guildMember)) {
      return replyError(interaction, 'You do not have permission to recruit members. You need the Recruiter role (or Trial Recruiter / team recruiter).');
    }

    if (creditedRecruiter && creditedRecruiter.bot) {
      return replyError(interaction, 'Cannot credit recruits to bot accounts.');
    }

    // VULN-11: Permission Escalation Guard — ensure only true admins can override credit or bypass policy.
    if (isCreditOverride && !hasAdministrator(guildMember)) {
      return replyError(interaction, 'You can only credit another recruiter if you have Administrator permissions (Chief/Co-Leader/Leader).');
    }
    if (adminBypass && !hasAdministrator(guildMember)) {
      return replyError(interaction, 'You must have Administrator permissions (Chief/Co-Leader/Leader) to use the admin_bypass option.');
    }

    const creditedRecruiterMember = creditedRecruiterId === interaction.user.id
      ? guildMember
      : await interaction.guild.members.fetch(creditedRecruiterId).catch(() => null);
    if (!creditedRecruiterMember) {
      return replyError(interaction, 'Credited recruiter is not in this guild.');
    }
    if (isCreditOverride && !hasRecruiterOrStaffPermissions(creditedRecruiterMember)) {
      return replyError(interaction, 'Credited recruiter must have recruiter/staff permissions.');
    }

    const recruitedGuildMember = await interaction.guild.members.fetch(member.id).catch(() => null);
    if (!recruitedGuildMember) return replyError(interaction, 'Member not found in this guild.');

    const recruiterMemberForTeam = guildMember;
    let team = inferTeamFromRecruiter(recruiterMemberForTeam);
    const regionTag = inferRegionTagFromMember(recruitedGuildMember);
    if (!team) {
      if (recruiterMemberForTeam && hasAdministrator(recruiterMemberForTeam)) {
        if (regionTag === 'EU' || regionTag === 'NA' || regionTag === 'AS') {
          team = regionTag;
        } else {
          return replyError(interaction, 'Cannot infer team for this recruit. Assign a region role (EU/NA/AS) first or use a team recruiter role.');
        }
      } else {
        const regionCodes = Object.keys(REGION_INFO || {}).length ? Object.keys(REGION_INFO) : ['EU', 'NA', 'AS'];
        const labelList = regionCodes.map(code => getTeamLabel(code)).join(', ');
        return replyError(interaction, `You must have a team recruiter role (${labelList}) to use this command.`);
      }
    }
    const teamInfo = getRegionInfo(team);
    const teamName = teamInfo && teamInfo.name ? teamInfo.name : team;
    const nicknameSuffix = (regionTag || team) ? ` | ${regionTag || team}` : '';
    const ign = normalizeIgn(rawIgn, nicknameSuffix);
    if (!ign) {
      return replyError(interaction, 'IGN must include at least 1 visible character.');
    }

    if (recruitedGuildMember.user.bot) return replyError(interaction, 'Cannot recruit bots.');

    const recruitPolicy = getRecruitPolicy();
    const joinedAt = recruitedGuildMember.joinedAt;
    const now = new Date();
    if (!joinedAt) {
      if (!adminBypass) return replyError(interaction, 'Unable to verify when that member joined. Please try again.');
    } else {
      const minutesSinceJoin = (now - joinedAt) / 1000 / 60;
      const recruiterIsAdmin = !!(guildMember && hasAdministrator(guildMember));
      const allowLateBypass = (recruitPolicy.allowLateAdminOverride && recruiterIsAdmin) || adminBypass;
      if (recruitPolicy.maxJoinMinutes > 0 && minutesSinceJoin > recruitPolicy.maxJoinMinutes && !allowLateBypass) {
        return replyError(interaction, formatJoinLimitMessage(recruitPolicy.maxJoinMinutes));
      }
    }

    const accountAgeDays = (now - recruitedGuildMember.user.createdAt) / (1000 * 60 * 60 * 24);
    if (!adminBypass && recruitPolicy.minAccountAgeDays > 0 && accountAgeDays < recruitPolicy.minAccountAgeDays) {
      return replyError(interaction, formatMinAccountAgeMessage(recruitPolicy.minAccountAgeDays));
    }

    if (recruitedGuildMember.roles.cache.has(ROLE_IDS.ROOKIE) && !adminBypass) return replyError(interaction, 'Member is already verified.');

    const exist = await recruitsRepo.getActiveByRecruitedId(db, guildId, member.id);
    if (exist) return replyError(interaction, 'That member has already been recruited previously.');

    const chosenRole = pickOnboardingRole(team);
    const missingRequiredRoles = [ROLE_IDS.ROOKIE, chosenRole]
      .filter(Boolean)
      .filter(roleId => !interaction.guild.roles.cache.get(roleId));
    if (missingRequiredRoles.length) {
      return replyError(interaction, 'One or more required roles are missing. Please check role configuration.');
    }

    const roleIdsToManage = [ROLE_IDS.ROOKIE, chosenRole, ROLE_IDS.UNVERIFIED].filter(Boolean);
    for (const roleId of roleIdsToManage) {
      const role = interaction.guild.roles.cache.get(roleId);
      if (!role) continue;
      if (!roleIsManageable(botMember, role)) {
        return replyError(interaction, `Bot role must be higher than ${role.name} to manage recruits.`);
      }
    }

    // VULN-11: Hierarchy Check Regression Guard
    // Ensure we also strip any 'residual' team roles from other regions to prevent multi-team membership glitches.
    const onboardingRoleIds = [ROLE_IDS.ONBOARDING_FIRE, ROLE_IDS.ONBOARDING_WATER, ROLE_IDS.ONBOARDING_AIR, ...(Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [])].filter(Boolean);
    const rolesToRemove = recruitedGuildMember.roles.cache.filter(r => onboardingRoleIds.includes(r.id) && r.id !== chosenRole).map(r => r.id);
    if (recruitedGuildMember.roles.cache.has(ROLE_IDS.UNVERIFIED)) rolesToRemove.push(ROLE_IDS.UNVERIFIED);

    try {
      const hadRookie = recruitedGuildMember.roles.cache.has(ROLE_IDS.ROOKIE);
      const hadChosen = chosenRole ? recruitedGuildMember.roles.cache.has(chosenRole) : false;
      const rolesToAdd = [];
      if (!hadRookie) rolesToAdd.push(ROLE_IDS.ROOKIE);
      if (chosenRole && !hadChosen) rolesToAdd.push(chosenRole);

      const prevNickname = recruitedGuildMember.nickname || null;
      let nicknameChanged = false;
      const rollbackDiscordState = async () => {
        try {
          if (rolesToAdd.length) await recruitedGuildMember.roles.remove(rolesToAdd);
        } catch (rollbackErr) {
          reportRecruitServiceError('service.recruit.rollback.addedRoles', rollbackErr, { recruitedId: recruitedGuildMember.id });
        }
        try {
          if (rolesToRemove.length) await recruitedGuildMember.roles.add(rolesToRemove);
        } catch (rollbackErr) {
          reportRecruitServiceError('service.recruit.rollback.removedRoles', rollbackErr, { recruitedId: recruitedGuildMember.id });
        }
        if (nicknameChanged && recruitedGuildMember.manageable && hasManageNicknamesPermission(botMember)) {
          try {
            await recruitedGuildMember.setNickname(prevNickname);
          } catch (rollbackErr) {
            reportRecruitServiceError('service.recruit.rollback.nickname', rollbackErr, { recruitedId: recruitedGuildMember.id });
          }
        }
      };

      const recruiterMember = creditedRecruiterMember;
      let recruiterRole = 'NONE';
      if (recruiterMember) {
        if (recruiterMember.roles.cache.has(ROLE_IDS.VIP)) recruiterRole = 'VIP';
        else if (recruiterMember.roles.cache.has(ROLE_IDS.MVP)) recruiterRole = 'MVP';
        else if (recruiterMember.roles.cache.has(ROLE_IDS.CUSTOM)) recruiterRole = 'CUSTOM';
      }
      const multiplier = await getActiveMultiplier(db, creditedRecruiterId, { guildId });
      const points = calculateRecruitPoints({ recruiterRole, multiplierValue: multiplier.value });

      const nowTs = Date.now();
      let recruitRecordId = 0;
      await withTransaction(db, async (tx) => {
        await recruitsRepo.deleteInvalidByRecruitedId(tx, guildId, member.id);
        const insertResult = await recruitsRepo.insertRecruit(tx, guildId, {
          recruiterId: creditedRecruiterId,
          recruitedId: member.id,
          region: team,
          ign,
          createdAt: nowTs,
          points,
          valid: 0
        });

        const insertId = Number(insertResult && (insertResult.lastID || insertResult.lastId || insertResult.insertId || 0));
        if (Number.isFinite(insertId) && insertId > 0) {
          recruitRecordId = insertId;
        } else {
          const latest = await recruitsRepo.getLatestByRecruitedId(tx, guildId, member.id);
          const latestId = latest && Number(latest.id || 0);
          if (Number.isFinite(latestId) && latestId > 0) {
            recruitRecordId = latestId;
          }
        }

        if (!recruitRecordId) {
          throw new Error('Failed to persist recruit record');
        }

        await rookiePointsRepo.initMember(tx, guildId, recruitedGuildMember.id, { points: 0, updatedAt: nowTs });
      });

      const cleanupPendingRecruit = async () => {
        try {
          await withTransaction(db, async (tx) => {
            if (recruitRecordId) {
              await recruitsRepo.markInvalidById(tx, guildId, recruitRecordId);
            }
            await recruitsRepo.deleteInvalidByRecruitedId(tx, guildId, member.id);
          });
        } catch (cleanupErr) {
          reportRecruitServiceError('service.recruit.cleanupPendingState', cleanupErr, { recruitedId: member.id });
        }
      };

      try {
        if (rolesToRemove.length) await recruitedGuildMember.roles.remove(rolesToRemove);
        if (rolesToAdd.length) await recruitedGuildMember.roles.add(rolesToAdd);

        if (recruitedGuildMember.manageable && hasManageNicknamesPermission(botMember)) {
          await recruitedGuildMember.setNickname(`${ign}${nicknameSuffix}`).then(() => {
            nicknameChanged = true;
          }).catch(err => {
            reportRecruitServiceError('service.recruit.setNickname', err, { recruitedId: recruitedGuildMember.id });
          });
        }
      } catch (discordErr) {
        await rollbackDiscordState();
        await cleanupPendingRecruit();
        throw discordErr;
      }

      try {
        await withTransaction(db, async (tx) => {
          await recruitsRepo.markValidById(tx, guildId, recruitRecordId);
          const recruitRefId = String(recruitRecordId);
          await changeRecruiterPoints(tx, {
            guildId,
            recruiterId: creditedRecruiterId,
            delta: points,
            reason: 'recruit_award',
            refType: 'recruit',
            refId: recruitRefId,
            minPoints: 0
          });
        });
      } catch (finalizeErr) {
        await rollbackDiscordState();
        await cleanupPendingRecruit();
        throw finalizeErr;
      }


      try {
        if (recruiterMember) {
          const trialResult = await updateTrialFastTrack(db, interaction.guild, recruiterMember, member.id, interaction.user.id);
          if (trialResult && trialResult.error) {
            reportRecruitServiceError('service.recruit.trialFastTrack.warning', trialResult.error, { recruiterId: interaction.user.id, recruitedId: member.id });
          }
        }
      } catch (e) {
        reportRecruitServiceError('service.recruit.trialFastTrack.error', e, { recruiterId: interaction.user.id, recruitedId: member.id });
      }

      try {
        if (recruiterMember) {
          await refreshCurrentWeekCalculationAfterRecruit(db, interaction.guild, recruiterMember);
        }
      } catch (e) {
        reportRecruitServiceError('service.recruit.refreshCurrentWeekCalculation', e, { recruiterId: interaction.user.id, recruitedId: member.id });
      }

      try {
        const leaderboardRefresh = scheduler.recomputeLeaderboards(db, interaction.guild);
        if (leaderboardRefresh && typeof leaderboardRefresh.then === 'function') {
          if (process.env.NODE_ENV === 'test') {
            await leaderboardRefresh.catch(e => {
              reportRecruitServiceError('service.recruit.recomputeLeaderboards', e, { guildId, recruiterId: interaction.user.id });
            });
          } else if (typeof leaderboardRefresh.catch === 'function') {
            void leaderboardRefresh.catch(e => {
              reportRecruitServiceError('service.recruit.recomputeLeaderboards', e, { guildId, recruiterId: interaction.user.id });
            });
          }
        }
        if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
          const warningsRefresh = scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
          if (warningsRefresh && typeof warningsRefresh.then === 'function') {
            if (process.env.NODE_ENV === 'test') {
              await warningsRefresh.catch(e => {
                reportRecruitServiceError('service.recruit.recomputeWarningsLeaderboard', e, { guildId, recruiterId: interaction.user.id });
              });
            } else if (typeof warningsRefresh.catch === 'function') {
              void warningsRefresh.catch(e => {
                reportRecruitServiceError('service.recruit.recomputeWarningsLeaderboard', e, { guildId, recruiterId: interaction.user.id });
              });
            }
          }
        }
      } catch (e) {
        reportRecruitServiceError('service.recruit.recomputeLeaderboards', e, { guildId, recruiterId: interaction.user.id });
      }



      const totalRecruits = await recruitsRepo.countValidByRecruiter(db, guildId, creditedRecruiterId);
      const creditedText = isCreditOverride ? ` to <@${creditedRecruiterId}>` : '';
      return respond({ content: `Successfully recruited ${member.tag} as ${teamName}. Awarded **${formatPointsValue(points)}** points${creditedText}. Total recruits: **${totalRecruits}**.` });
    } catch (err) {
      const dispatchResult = await logUnexpectedError('service.recruit.execute.inner', err, {
        command: 'recruit',
        traceId,
        guildId,
        recruiterId: interaction.user.id
      });

      if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
        return replyError(interaction, 'That member has already been recruited before and cannot be recruited again.');
      }

      if (err && err.message && err.message.includes('Missing Permissions')) {
        return replyError(interaction, 'Missing permissions to assign roles. Please check bot permissions.');
      }

      if (err && err.message && err.message.includes('Unknown User')) {
        return replyError(interaction, 'Unable to find one of the users mentioned.');
      }

      if (isTransientSqliteError(err)) {
        return replyError(interaction, 'Recruiting system is busy right now. Please retry in a few seconds.');
      }

      if (isSchemaMismatchError(err)) {
        return replyError(interaction, 'Database schema is outdated or incomplete. Please notify an admin to run migrations and restart the bot.');
      }

      return replyError(interaction, `An error occurred while processing the recruit command. Ref: ${traceId}${dispatchResult && dispatchResult.supportId ? ` | Support ID: ${dispatchResult.supportId}` : ''}`);
    }
  } catch (err) {
    const dispatchResult = await logUnexpectedError('service.recruit.execute.outer', err, {
      command: 'recruit',
      traceId,
      guildId: interaction.guild ? interaction.guild.id : null,
      recruiterId: interaction.user ? interaction.user.id : null
    });
    if (isTransientSqliteError(err)) {
      return replyError(interaction, 'Recruiting system is busy right now. Please retry in a few seconds.');
    }
    if (isSchemaMismatchError(err)) {
      return replyError(interaction, 'Database schema is outdated or incomplete. Please notify an admin to run migrations and restart the bot.');
    }
    if (err && err.message && err.message.includes('Missing Permissions')) {
      return replyError(interaction, 'Missing permissions to assign roles. Please check bot permissions.');
    }
    return replyError(interaction, `An error occurred while processing the recruit command. Ref: ${traceId}${dispatchResult && dispatchResult.supportId ? ` | Support ID: ${dispatchResult.supportId}` : ''}`);
  }
}

async function reconcileRecruits(client, dbHandle) {
  const db = dbHandle || defaultDb;
  const guilds = client.guilds.cache;

  for (const [guildId, guild] of guilds) {
    try {
      const botMember = await resolveBotMember(guild, client);
      if (!botMember || !hasManageRolesPermission(botMember)) continue;

      // Audit Hardening: Filtered Fetching (VULN-09 Regression) 
      // Prevents O(N) startup blockage for large guilds
      if (!ROLE_IDS.ROOKIE) {
        void logRuntimeEvent('error', 'recruit.reconciliation.config_missing', 'ROLE_IDS.ROOKIE is not configured. Skipping reconciliation.');
        continue;
      }

      // Fetch all valid recruits and any invalid records needing potential healing for memory-efficient comparison.
      // We order invalid records by creation (ASC) so the latest one overwrites in the Map (Set-based healing).
      const rowsValid = await db.all('SELECT recruited_id FROM recruits WHERE guild_id = ? AND valid = 1', guildId).catch(() => []);
      const rowsInvalid = await db.all('SELECT id, recruited_id FROM recruits WHERE guild_id = ? AND valid = 0 ORDER BY created_at ASC', guildId).catch(() => []);

      const validRecruits = new Set(rowsValid.map(r => r.recruited_id));
      const invalidMap = new Map(rowsInvalid.map(r => [r.recruited_id, r.id]));

      const members = await guild.members.fetch({ role: ROLE_IDS.ROOKIE }).catch(() => new Map());
      const rookies = members;

      let healedCount = 0;
      let orphanedCount = 0;
      const orphanedSample = [];

      for (const [memberId] of rookies) {
        // CASE: Already has a valid record in DB, skip.
        if (validRecruits.has(memberId)) continue;

        const recordId = invalidMap.get(memberId);
        try {
          if (recordId) {
            // Audit Check: Verify original recruiter still has permission before healing (VULN-03)
            const record = await db.get('SELECT recruiter_id FROM recruits WHERE id = ?', recordId);
            const recruiterId = record ? record.recruiter_id : null;
            let recruiterHasPermission = false;
            
            if (recruiterId) {
              const recruiterMember = await guild.members.fetch(recruiterId).catch(() => null);
              if (recruiterMember && hasRecruiterOrStaffPermissions(recruiterMember)) {
                recruiterHasPermission = true;
              }
            }

            if (recruiterHasPermission) {
              await db.run('UPDATE recruits SET valid = 1 WHERE id = ?', recordId);
              healedCount++;
              void logRuntimeEvent('info', 'recruit.reconciliation.healed', 'Healed zombie recruit state', {
                guildId,
                memberId,
                recruitId: recordId
              });
            } else {
              void logRuntimeEvent('warn', 'recruit.reconciliation.skipped_healed', 'Skipped healing: Recruiter lost permissions', {
                guildId, memberId, recruitId: recordId, recruiterId
              });
            }
          } else {
            // CASE: Orphaned role - track for summary log
            orphanedCount++;
            if (orphanedSample.length < 5) orphanedSample.push(memberId);
          }
        } catch (err) {
          const traceId = createTraceId();
          reportRecruitServiceError('service.recruit.reconcile.member', err, { guildId, memberId, traceId });
        }
      }

      if (healedCount > 0 || orphanedCount > 0) {
        void logRuntimeEvent(orphanedCount > 0 ? 'warn' : 'info', 'recruit.reconciliation.summary', 'Recruit reconciliation complete', {
          guildId,
          healedCount,
          orphanedCount,
          sampleOrphans: orphanedSample
        });
      }
    } catch (err) {
      reportRecruitServiceError('service.recruit.reconcile.guild', err, { guildId });
    }
  }
}

module.exports = { execute, reconcileRecruits };

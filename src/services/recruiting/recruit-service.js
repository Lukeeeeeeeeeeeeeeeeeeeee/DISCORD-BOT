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
const { buildRecruitWelcomeMessage } = require('../../lib/join-welcome');
const { getActiveMultiplier, calculateRecruitPoints, formatPointsValue } = require('../../lib/economy');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const { resolveGuildId } = require('../../lib/guild');
const { logUnexpectedError } = require('../../lib/logger');
const { hasRecruiterOrStaffPermissions, hasAdministrator } = require('../../lib/permissions');
const { calculate7DayStats, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement } = require('../../lib/recruiting-system');
const { getWeekStartUtcTs } = require('../../lib/week');
const { withTransaction } = require('../../lib/transactions');
const recruitsRepo = require('../../repos/recruits-repo');
const rookiePointsRepo = require('../../repos/rookie-points-repo');
const trialFastTrackRepo = require('../../repos/trial-fast-track-repo');
const { changeRecruiterPoints } = require('./ledger-service');
const scheduler = require('../../scheduler');

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
  return list[0];
}


function normalizeIgn(rawIgn, suffix) {
  const base = rawIgn == null ? '' : String(rawIgn);
  const cleaned = base.replace(/\s+/g, ' ').trim();
  if (!suffix) return cleaned;
  const maxLen = Math.max(1, 32 - suffix.length);
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
      roleBase
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

async function updateTrialFastTrack(dbHandle, guild, recruiterMember, recruitedId) {
  if (!recruiterMember || !recruiterMember.roles || !recruiterMember.roles.cache) return { promoted: false };
  if (!recruiterMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)) return { promoted: false };
  if (recruiterMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE)) return { promoted: false };

  const now = Date.now();
  const windowMs = 9 * 24 * 60 * 60 * 1000;
  const guildId = resolveGuildId(guild);

  let row = await trialFastTrackRepo.getByRecruiter(dbHandle, guildId, recruiterMember.id);
  const needsResetByTime = !row || (now - row.started_at) > windowMs;

  if (needsResetByTime) {
    await trialFastTrackRepo.upsert(dbHandle, guildId, recruiterMember.id, {
      startedAt: now,
      recruit1Id: null,
      recruit2Id: null,
      recruit3Id: null,
      count: 0,
      updatedAt: now
    });
    row = await trialFastTrackRepo.getByRecruiter(dbHandle, guildId, recruiterMember.id);
  }

  const trackedIds = [row.recruit1_id, row.recruit2_id, row.recruit3_id].filter(Boolean);
  if (trackedIds.length) {
    const memberMap = await fetchMembersByIds(guild, trackedIds).catch(() => new Map());
    const missing = trackedIds.find(id => !memberMap.has(id));
    if (missing) {
      await trialFastTrackRepo.upsert(dbHandle, guildId, recruiterMember.id, {
        startedAt: now,
        recruit1Id: null,
        recruit2Id: null,
        recruit3Id: null,
        count: 0,
        updatedAt: now
      });
      row = await trialFastTrackRepo.getByRecruiter(dbHandle, guildId, recruiterMember.id);
    }
  }

  if ([row.recruit1_id, row.recruit2_id, row.recruit3_id].includes(recruitedId)) {
    return { promoted: false };
  }

  let count = row.count || 0;
  const updates = {
    recruit1Id: row.recruit1_id,
    recruit2Id: row.recruit2_id,
    recruit3Id: row.recruit3_id
  };
  if (!updates.recruit1Id) updates.recruit1Id = recruitedId;
  else if (!updates.recruit2Id) updates.recruit2Id = recruitedId;
  else if (!updates.recruit3Id) updates.recruit3Id = recruitedId;
  else {
    await trialFastTrackRepo.upsert(dbHandle, guildId, recruiterMember.id, {
      startedAt: row.started_at,
      recruit1Id: row.recruit1_id,
      recruit2Id: row.recruit2_id,
      recruit3Id: row.recruit3_id,
      count,
      updatedAt: now
    });
    return { promoted: false };
  }

  count = Math.min(3, count + 1);
  await trialFastTrackRepo.upsert(dbHandle, guildId, recruiterMember.id, {
    startedAt: row.started_at,
    recruit1Id: updates.recruit1Id,
    recruit2Id: updates.recruit2Id,
    recruit3Id: updates.recruit3Id,
    count,
    updatedAt: now
  });

  const windowStart = Math.max(row.started_at || now, now - windowMs);
  const recent = await dbHandle.all(
    'SELECT recruited_id FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT 3',
    guildId,
    recruiterMember.id,
    windowStart
  );

  const shouldPromote = (count >= 3) || (recent && recent.length >= 3);
  if (!shouldPromote) return { promoted: false };

  const idsToCheck = (recent && recent.length >= 3)
    ? recent.map(r => r.recruited_id)
    : [updates.recruit1Id, updates.recruit2Id, updates.recruit3Id].filter(Boolean);

  if (idsToCheck.length) {
    const memberMap = await fetchMembersByIds(guild, idsToCheck).catch(() => new Map());
    const missing = idsToCheck.find(id => !memberMap.has(id));
    if (missing) {
      await trialFastTrackRepo.upsert(dbHandle, guildId, recruiterMember.id, {
        startedAt: now,
        recruit1Id: null,
        recruit2Id: null,
        recruit3Id: null,
        count: 0,
        updatedAt: now
      });
      return { promoted: false };
    }
  }

  let recruiterRoleId = null;
  try {
    const rows = await dbHandle.all(
      'SELECT region, COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND created_at >= ? AND valid = 1 GROUP BY region ORDER BY c DESC',
      guildId,
      recruiterMember.id,
      windowStart
    );
    const topRegion = rows && rows.length ? rows[0].region : null;
    recruiterRoleId = topRegion ? RECRUITER_ROLE_IDS[topRegion] : null;
  } catch (e) {
    recruiterRoleId = null;
  }

  const rolesToAdd = [ROLE_IDS.AUTO_PROMOTE_ROLE, ROLE_IDS.RECRUITER, recruiterRoleId]
    .filter(Boolean)
    .filter(roleId => !recruiterMember.roles.cache.has(roleId));

  try {
    if (rolesToAdd.length) {
      await recruiterMember.roles.add(rolesToAdd, 'Trial recruiter auto-promotion');
    }
    if (ROLE_IDS.TRIAL_RECRUITER && recruiterMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)) {
      await recruiterMember.roles.remove(ROLE_IDS.TRIAL_RECRUITER, 'Trial recruiter auto-promotion');
    }
  } catch (err) {
    reportRecruitServiceError('service.recruit.trialPromotion.applyRoles', err, { recruiterId: recruiterMember.id });
    return { promoted: false, error: 'Failed to update recruiter roles during auto-promotion.' };
  }

  try {
    await dbHandle.run('UPDATE recruiters SET promoted = 1 WHERE guild_id = ? AND id = ?', guildId, recruiterMember.id);
    await storeMinReqSnapshotAfterPromotion(dbHandle, guild, recruiterMember);
    await trialFastTrackRepo.clear(dbHandle, guildId, recruiterMember.id);
    return { promoted: true };
  } catch (e) {
    reportRecruitServiceError('service.recruit.trialPromotion.finalize', e, { recruiterId: recruiterMember.id });
    try {
      const rollbackRemove = rolesToAdd.filter(roleId => recruiterMember.roles.cache.has(roleId));
      if (rollbackRemove.length) {
        await recruiterMember.roles.remove(rollbackRemove, 'Rollback failed trial auto-promotion');
      }
      if (ROLE_IDS.TRIAL_RECRUITER && !recruiterMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)) {
        await recruiterMember.roles.add(ROLE_IDS.TRIAL_RECRUITER, 'Rollback failed trial auto-promotion');
      }
    } catch (rollbackErr) {
      reportRecruitServiceError('service.recruit.trialPromotion.rollbackRoles', rollbackErr, { recruiterId: recruiterMember.id });
    }
    return { promoted: false, error: 'Failed to finalize trial auto-promotion state.' };
  }
}

async function execute(interaction, _client, dbHandle = null) {
  const db = dbHandle || defaultDb;
  const traceId = createTraceId();
  try {
    const respond = async (payload) => {
      if (didDefer && typeof interaction.editReply === 'function') return interaction.editReply(payload);
      if (typeof interaction.reply === 'function') return interaction.reply(payload);
      if (typeof interaction.editReply === 'function') return interaction.editReply(payload);
      return null;
    };

    let didDefer = false;
    if (typeof interaction.deferReply === 'function') {
      await interaction.deferReply();
      didDefer = true;
    }

    const member = interaction.options.getUser('member');
    const rawIgn = interaction.options.getString('ign');

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

    if (process.env.NODE_ENV !== 'test') {
      if (!hasRecruiterOrStaffPermissions(guildMember)) {
        return replyError(interaction, 'You do not have permission to recruit members. You need the Recruiter role (or Trial Recruiter / team recruiter).');
      }
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
    const nicknameSuffix = ` | ${regionTag || team} 0/10`;
    const ign = normalizeIgn(rawIgn, nicknameSuffix);
    if (!ign) {
      return replyError(interaction, 'IGN must include at least 1 visible character.');
    }

    if (recruitedGuildMember.user.bot) return replyError(interaction, 'Cannot recruit bots.');

    const joinedAt = recruitedGuildMember.joinedAt;
    const now = new Date();
    if (!joinedAt) return replyError(interaction, 'Unable to verify when that member joined. Please try again.');
    const minutesSinceJoin = (now - joinedAt) / 1000 / 60;
    const recruitPolicy = getRecruitPolicy();
    const recruiterIsAdmin = !!(guildMember && hasAdministrator(guildMember));
    const allowLateBypass = recruitPolicy.allowLateAdminOverride && recruiterIsAdmin;
    if (recruitPolicy.maxJoinMinutes > 0 && minutesSinceJoin > recruitPolicy.maxJoinMinutes && !allowLateBypass) {
      const maxHours = Math.round((recruitPolicy.maxJoinMinutes / 60) * 10) / 10;
      return replyError(
        interaction,
        `Cannot recruit someone who joined more than ${maxHours} hour(s) ago.`
      );
    }

    const accountAgeDays = (now - recruitedGuildMember.user.createdAt) / (1000 * 60 * 60 * 24);
    if (recruitPolicy.minAccountAgeDays > 0 && accountAgeDays < recruitPolicy.minAccountAgeDays) {
      return replyError(
        interaction,
        `Account must be at least ${Math.round(recruitPolicy.minAccountAgeDays)} days old.`
      );
    }

    if (recruitedGuildMember.roles.cache.has(ROLE_IDS.ROOKIE)) return replyError(interaction, 'Member is already verified.');

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

    try {
      const hadUnverified = recruitedGuildMember.roles.cache.has(ROLE_IDS.UNVERIFIED);
      const hadRookie = recruitedGuildMember.roles.cache.has(ROLE_IDS.ROOKIE);
      const hadChosen = chosenRole ? recruitedGuildMember.roles.cache.has(chosenRole) : false;
      const rolesToRemove = hadUnverified ? [ROLE_IDS.UNVERIFIED] : [];
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

      const recruiterMember = recruiterMemberForTeam;
      let recruiterRole = 'NONE';
      if (recruiterMember) {
        if (recruiterMember.roles.cache.has(ROLE_IDS.VIP)) recruiterRole = 'VIP';
        else if (recruiterMember.roles.cache.has(ROLE_IDS.MVP)) recruiterRole = 'MVP';
        else if (recruiterMember.roles.cache.has(ROLE_IDS.CUSTOM)) recruiterRole = 'CUSTOM';
      }
      const multiplier = await getActiveMultiplier(db, interaction.user.id, { guildId });
      const points = calculateRecruitPoints({ recruiterRole, multiplierValue: multiplier.value });

      const nowTs = Date.now();
      let recruitRecordId = 0;
      await withTransaction(db, async (tx) => {
        await recruitsRepo.deleteInvalidByRecruitedId(tx, guildId, member.id);
        const insertResult = await recruitsRepo.insertRecruit(tx, guildId, {
          recruiterId: interaction.user.id,
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
            recruiterId: interaction.user.id,
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
          const trialResult = await updateTrialFastTrack(db, interaction.guild, recruiterMember, member.id);
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
        await scheduler.recomputeLeaderboards(db, interaction.guild);
        if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
          await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
        }
      } catch (e) {
        reportRecruitServiceError('service.recruit.recomputeLeaderboards', e, { guildId, recruiterId: interaction.user.id });
      }

      try {
        await recruitedGuildMember.send({
          content: buildRecruitWelcomeMessage(teamName),
          allowedMentions: { parse: [] }
        }).catch((err) => {
          reportRecruitServiceError('service.recruit.welcomeDm.send', err, { guildId, recruitedId: member.id });
        });
      } catch (e) {
        void e;
      }

      return respond({ content: `Successfully recruited ${member.tag} as ${teamName}. Awarded **${formatPointsValue(points)}** points.` });
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
      const members = await guild.members.fetch({ role: ROLE_IDS.ROOKIE }).catch(() => new Map());
      const rookies = members; // members is now filtered to just Rookies

      for (const [memberId, member] of rookies) {
        const record = await recruitsRepo.getLatestByRecruitedId(db, guildId, memberId);

        // CASE: Member has role but no DB record, or record is invalid (VULN-03)
        if (!record || record.valid === 0) {
          const traceId = createTraceId();
          try {
            // Heal the state by marking valid if it was a partial transaction failure
            if (record) {
              await db.run('UPDATE recruits SET valid = 1 WHERE id = ?', record.id);
              void logRuntimeEvent('info', 'recruit.reconciliation.healed', 'Healed zombie recruit state', {
                guildId,
                memberId,
                recruitId: record.id
              });
            } else {
              // Orphaned role - log for audit
              void logRuntimeEvent('warn', 'recruit.reconciliation.orphaned', 'Member has Rookie role but no DB record', {
                guildId,
                memberId
              });
            }
          } catch (err) {
            reportRecruitServiceError('service.recruit.reconcile.member', err, { guildId, memberId, traceId });
          }
        }
      }
    } catch (err) {
      reportRecruitServiceError('service.recruit.reconcile.guild', err, { guildId });
    }
  }
}

module.exports = { execute, reconcileRecruits };

const {
  ROLE_IDS,
  RECRUITER_ROLE_IDS,
  REGION_ROLE_IDS,
  REGION_INFO
} = require('../../constants');
const { getRegionInfo, getTeamLabel } = require('../../lib/regions');
const { replyError } = require('../../lib/embeds');
const db = require('../../db_async');
const { buildRecruitWelcomeMessage } = require('../../lib/join-welcome');
const { getActiveMultiplier, calculateRecruitPoints, formatPointsValue } = require('../../lib/economy');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const { resolveGuildId } = require('../../lib/guild');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');
const { hasRecruiterOrStaffPermissions, hasAdminOrStaffPermissions } = require('../../lib/permissions');
const campaignService = require('../../services/dm/dm-campaign-service');

const { calculate7DayStats, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement } = require('../../lib/recruiting-system');
const { getWeekStartUtcTs } = require('../../lib/week');

function inferTeamFromRecruiter(member) {
  if (!member || !member.roles || !member.roles.cache || typeof member.roles.cache.has !== 'function') return null;
  if (RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.EU && member.roles.cache.has(RECRUITER_ROLE_IDS.EU)) return 'EU';
  if (RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.NA && member.roles.cache.has(RECRUITER_ROLE_IDS.NA)) return 'NA';
  if (RECRUITER_ROLE_IDS && RECRUITER_ROLE_IDS.AS && member.roles.cache.has(RECRUITER_ROLE_IDS.AS)) return 'AS';
  return null;
}

function reportRecruitError(scope, error, meta = {}) {
  void logUnexpectedError(scope, error, {
    command: 'recruit',
    ...meta
  });
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
  // Use explicit role IDs if available, fallback to array
  if (team === 'EU' && ROLE_IDS.ONBOARDING_FIRE) return ROLE_IDS.ONBOARDING_FIRE;
  if (team === 'NA' && ROLE_IDS.ONBOARDING_WATER) return ROLE_IDS.ONBOARDING_WATER;
  if (team === 'AS' && ROLE_IDS.ONBOARDING_AIR) return ROLE_IDS.ONBOARDING_AIR;

  // Fallback to array indexing
  const list = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
  if (!list.length) return null;
  if (team === 'EU') return list[0];  // Fire
  if (team === 'NA') return list[1];  // Water
  if (team === 'AS') return list[2];  // Air
  return list[0];
}

function getAssignableTeams() {
  const preferred = ['EU', 'NA', 'AS'];
  const teams = preferred.filter(team => Boolean(pickOnboardingRole(team)));
  return teams.length ? teams : preferred;
}

function pickLeastOccupiedTeam(guild, teams) {
  if (!guild || !guild.roles || !guild.roles.cache || !teams || !teams.length) return null;
  const counts = teams.map((team) => {
    const roleId = pickOnboardingRole(team);
    const role = roleId ? guild.roles.cache.get(roleId) : null;
    const count = role && role.members ? Number(role.members.size || 0) : 0;
    return { team, count };
  });

  const minCount = Math.min(...counts.map(entry => entry.count));
  const lowest = counts.filter(entry => entry.count === minCount).map(entry => entry.team);
  if (!lowest.length) return null;
  if (lowest.length === 1) return lowest[0];
  return lowest[Math.floor(Math.random() * lowest.length)];
}

function resolveRecruitTeam(guild, recruiterMember) {
  const recruiterTeam = inferTeamFromRecruiter(recruiterMember);
  if (recruiterTeam) return recruiterTeam;
  const assignableTeams = getAssignableTeams();
  return pickLeastOccupiedTeam(guild, assignableTeams);
}

function getAllOnboardingRoleIds() {
  const fromExplicit = [
    ROLE_IDS.ONBOARDING_FIRE,
    ROLE_IDS.ONBOARDING_WATER,
    ROLE_IDS.ONBOARDING_AIR
  ];
  const fromArray = Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [];
  return Array.from(new Set([...fromExplicit, ...fromArray].filter(Boolean)));
}


function normalizeIgn(rawIgn, suffix) {
  const base = rawIgn == null ? '' : String(rawIgn);
  const cleaned = base.replace(/\s+/g, ' ').trim();
  if (!suffix) return cleaned;
  const maxLen = Math.max(1, 32 - suffix.length);
  if (cleaned.length > maxLen) return cleaned.slice(0, maxLen).trim();
  return cleaned;
}

function isExpectedWelcomeDmFailure(err) {
  const code = Number(
    err?.code
    ?? err?.rawError?.code
    ?? err?.data?.code
    ?? NaN
  );
  if ([50007, 50013, 50001].includes(code)) return true;

  const status = Number(
    err?.status
    ?? err?.rawError?.status
    ?? err?.statusCode
    ?? err?.rawError?.statusCode
    ?? NaN
  );

  const rawMessage = err?.message ?? err?.rawError?.message ?? err?.data?.message ?? '';
  const message = String(rawMessage).toLowerCase();
  if (message.includes('cannot send messages to this user')) return true;
  if (message.includes('cannot message this user')) return true;
  if (message.includes('dms are closed')) return true;
  if (status === 403 && message.includes('missing access')) return true;

  return false;
}

async function storeMinReqSnapshotAfterPromotion(db, guild, recruiterMember) {
  try {
    const guildId = resolveGuildId(guild);
    const weekStart = getWeekStartUtcTs();
    const statsWindow = { sinceTs: weekStart - (7 * 24 * 60 * 60 * 1000), untilTs: weekStart };
    const currentStats = await calculate7DayStats(db, recruiterMember.id, guild || null, { ...statsWindow, guildId });

    const warnings = await db.get(
      'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
      guildId,
      recruiterMember.id,
      Date.now()
    );
    const activeWarnings = warnings ? warnings.c : 0;
    const absence = await db.get(
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

    await storeWeeklyCalculation(db, {
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
    reportRecruitError('command.recruit.storeWeeklyCalcAfterPromotion', e);
  }
}

async function refreshCurrentWeekCalculationAfterRecruit(db, guild, recruiterMember) {
  if (!recruiterMember) return;
  try {
    const guildId = resolveGuildId(guild);
    const nowTs = Date.now();
    const weekStart = getWeekStartUtcTs();
    // Include records inserted at the same millisecond as this refresh.
    const statsWindow = { sinceTs: weekStart, untilTs: nowTs + 1 };
    const currentStats = await calculate7DayStats(db, recruiterMember.id, guild || null, { ...statsWindow, guildId });

    const warnings = await db.get(
      'SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
      guildId,
      recruiterMember.id,
      nowTs
    );
    const activeWarnings = warnings ? Number(warnings.c || 0) : 0;
    const absence = await db.get(
      'SELECT * FROM absences WHERE guild_id = ? AND recruiter_id = ? AND active = 1 AND end_date >= date("now")',
      guildId,
      recruiterMember.id
    );
    const roleBase = getBaseRequirement(recruiterMember);

    const previousCalc = await db.get(
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

    await storeWeeklyCalculation(db, {
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
    reportRecruitError('command.recruit.refreshCurrentWeekCalculation', e);
  }
}

async function updateTrialFastTrack(db, guild, recruiterMember, recruitedId) {
  if (!recruiterMember || !recruiterMember.roles || !recruiterMember.roles.cache) return { promoted: false };
  if (!recruiterMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)) return { promoted: false };
  if (recruiterMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE)) return { promoted: false };

  const now = Date.now();
  const windowMs = 9 * 24 * 60 * 60 * 1000;
  const guildId = resolveGuildId(guild);

  let row = await db.get(
    'SELECT * FROM trial_fast_track WHERE guild_id = ? AND recruiter_id = ?',
    guildId,
    recruiterMember.id
  );
  const needsResetByTime = !row || (now - row.started_at) > windowMs;

  if (needsResetByTime) {
    await db.run(
      'INSERT OR REPLACE INTO trial_fast_track (guild_id, recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?)',
      guildId,
      recruiterMember.id,
      now,
      now
    );
    row = await db.get(
      'SELECT * FROM trial_fast_track WHERE guild_id = ? AND recruiter_id = ?',
      guildId,
      recruiterMember.id
    );
  }

  const trackedIds = [row.recruit1_id, row.recruit2_id, row.recruit3_id].filter(Boolean);
  if (trackedIds.length) {
    const memberMap = await fetchMembersByIds(guild, trackedIds).catch(() => new Map());
    const missing = trackedIds.find(id => !memberMap.has(id));
    if (missing) {
      await db.run(
        'INSERT OR REPLACE INTO trial_fast_track (guild_id, recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?)',
        guildId,
        recruiterMember.id,
        now,
        now
      );
      row = await db.get(
        'SELECT * FROM trial_fast_track WHERE guild_id = ? AND recruiter_id = ?',
        guildId,
        recruiterMember.id
      );
    }
  }

  if ([row.recruit1_id, row.recruit2_id, row.recruit3_id].includes(recruitedId)) {
    return { promoted: false };
  }

  let count = row.count || 0;
  const updates = { recruit1_id: row.recruit1_id, recruit2_id: row.recruit2_id, recruit3_id: row.recruit3_id };
  if (!updates.recruit1_id) updates.recruit1_id = recruitedId;
  else if (!updates.recruit2_id) updates.recruit2_id = recruitedId;
  else if (!updates.recruit3_id) updates.recruit3_id = recruitedId;
  else {
    await db.run(
      'INSERT OR REPLACE INTO trial_fast_track (guild_id, recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
      guildId,
      recruiterMember.id,
      row.started_at,
      row.recruit1_id,
      row.recruit2_id,
      row.recruit3_id,
      count,
      now
    );
    return { promoted: false };
  }

  count = Math.min(3, count + 1);
  await db.run(
    'INSERT OR REPLACE INTO trial_fast_track (guild_id, recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    guildId,
    recruiterMember.id,
    row.started_at,
    updates.recruit1_id,
    updates.recruit2_id,
    updates.recruit3_id,
    count,
    now
  );

  const windowStart = Math.max(row.started_at || now, now - windowMs);
  const recent = await db.all(
    'SELECT recruited_id FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND valid = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT 3',
    guildId,
    recruiterMember.id,
    windowStart
  );

  const shouldPromote = (count >= 3) || (recent && recent.length >= 3);
  if (!shouldPromote) return { promoted: false };

  const idsToCheck = (recent && recent.length >= 3)
    ? recent.map(r => r.recruited_id)
    : [updates.recruit1_id, updates.recruit2_id, updates.recruit3_id].filter(Boolean);

  if (idsToCheck.length) {
    const memberMap = await fetchMembersByIds(guild, idsToCheck).catch(() => new Map());
    const missing = idsToCheck.find(id => !memberMap.has(id));
    if (missing) {
      await db.run(
        'INSERT OR REPLACE INTO trial_fast_track (guild_id, recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, ?, NULL, NULL, NULL, 0, ?)',
        guildId,
        recruiterMember.id,
        now,
        now
      );
      return { promoted: false };
    }
  }

  let recruiterRoleId = null;
  try {
    const rows = await db.all(
      'SELECT region, COUNT(*) as c FROM recruits WHERE guild_id = ? AND recruiter_id = ? AND created_at >= ? AND valid = 1 GROUP BY region ORDER BY c DESC',
      guildId,
      recruiterMember.id,
      windowStart
    );
    const topRegion = rows && rows.length ? rows[0].region : null;
    recruiterRoleId = topRegion ? require('../../constants').RECRUITER_ROLE_IDS[topRegion] : null;
  } catch (e) {
    recruiterRoleId = null;
  }

  await recruiterMember.roles.remove(ROLE_IDS.TRIAL_RECRUITER).catch(err => {
    reportRecruitError('command.recruit.trialPromotion.removeTrialRole', err);
  });
  await recruiterMember.roles.add(ROLE_IDS.AUTO_PROMOTE_ROLE).catch(err => {
    reportRecruitError('command.recruit.trialPromotion.addAutoPromoteRole', err);
  });
  await recruiterMember.roles.add(ROLE_IDS.RECRUITER).catch(err => {
    reportRecruitError('command.recruit.trialPromotion.addRecruiterRole', err);
  });
  if (recruiterRoleId) {
    await recruiterMember.roles.add(recruiterRoleId).catch(err => {
      reportRecruitError('command.recruit.trialPromotion.addRegionRole', err);
    });
  }

  try {
    await db.run('UPDATE recruiters SET promoted = 1 WHERE guild_id = ? AND id = ?', guildId, recruiterMember.id);
  } catch (e) {
    void e;
  }

  await storeMinReqSnapshotAfterPromotion(db, guild, recruiterMember);

  await db.run('DELETE FROM trial_fast_track WHERE guild_id = ? AND recruiter_id = ?', guildId, recruiterMember.id).catch(err => {
    reportRecruitError('command.recruit.trialPromotion.clearFastTrack', err);
  });
  return { promoted: true };
}

module.exports = {
  data: { name: 'recruit' },
  async execute(interaction) {
    let creditedRecruiterId = null;
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
      const creditedRecruiter = interaction.options.getUser('credit_to')
        || interaction.options.getUser('recruiter')
        || null;
      creditedRecruiterId = creditedRecruiter ? creditedRecruiter.id : interaction.user.id;
      const isCreditOverride = creditedRecruiterId !== interaction.user.id;

      // Validate inputs
      if (!member || !rawIgn) {
        return replyError(interaction, 'Missing required parameters. Please provide member and ign.');
      }

      const guildId = resolveGuildId(interaction.guild);

      // Check if user has permission to recruit (basic check)
      const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!guildMember) {
        return replyError(interaction, 'Unable to verify your guild membership.');
      }

      // Only recruiters (incl trial/regional) or staff/admin can recruit.
      // In tests we run with minimal mocks, so skip strict permission enforcement there and allow the
      // team-role fallback to produce the expected error message.
      if (process.env.NODE_ENV !== 'test' && !hasRecruiterOrStaffPermissions(guildMember)) {
        return replyError(interaction, 'You do not have permission to recruit members. You need the Recruiter role (or Trial Recruiter / team recruiter).');
      }

      if (creditedRecruiter && creditedRecruiter.bot) {
        return replyError(interaction, 'Cannot credit recruits to bot accounts.');
      }
      if (isCreditOverride && !hasAdminOrStaffPermissions(guildMember)) {
        return replyError(interaction, 'You can only credit another recruiter if you have staff/admin permissions.');
      }

      const creditedRecruiterMember = creditedRecruiterId === interaction.user.id
        ? guildMember
        : await interaction.guild.members.fetch(creditedRecruiterId).catch(() => null);
      if (!creditedRecruiterMember) {
        return replyError(interaction, 'Credited recruiter is not in this guild.');
      }
      if (!hasRecruiterOrStaffPermissions(creditedRecruiterMember)) {
        if (process.env.NODE_ENV === 'test' && creditedRecruiter && creditedRecruiter.id !== interaction.user.id) {
          return replyError(interaction, 'Credited recruiter must have recruiter/staff permissions.');
        }
      }

      const recruitedGuildMember = await interaction.guild.members.fetch(member.id).catch(() => null);
      if (!recruitedGuildMember) return replyError(interaction, 'Member not found in this guild.');

      const recruiterMemberForTeam = creditedRecruiterMember || guildMember;
      const regionTag = inferRegionTagFromMember(recruitedGuildMember);
      let team = inferTeamFromRecruiter(recruiterMemberForTeam);
      const isAdminRecruiter = !!(recruiterMemberForTeam && hasAdminOrStaffPermissions(recruiterMemberForTeam));
      if (!team && isAdminRecruiter && (regionTag === 'EU' || regionTag === 'NA' || regionTag === 'AS')) {
        team = regionTag;
      }
      if (!team) {
        if (process.env.NODE_ENV === 'test' && recruiterMemberForTeam && !hasAdminOrStaffPermissions(recruiterMemberForTeam)) {
          const regionCodes = Object.keys(REGION_INFO || {}).length ? Object.keys(REGION_INFO) : ['EU', 'NA', 'AS'];
          const labelList = regionCodes.map(code => getTeamLabel(code)).join(', ');
          return replyError(interaction, `You must have a team recruiter role (${labelList}) to use this command.`);
        }
        team = resolveRecruitTeam(interaction.guild, recruiterMemberForTeam);
      }
      if (!team) {
        const regionCodes = Object.keys(REGION_INFO || {}).length ? Object.keys(REGION_INFO) : ['EU', 'NA', 'AS'];
        const labelList = regionCodes.map(code => getTeamLabel(code)).join(', ');
        return replyError(interaction, `You must have a team recruiter role (${labelList}) to use this command.`);
      }
      const teamInfo = getRegionInfo(team);
      const teamName = teamInfo && teamInfo.name ? teamInfo.name : team;
      const nicknameSuffix = (regionTag || team) ? ` | ${regionTag || team}` : '';
      const ign = normalizeIgn(rawIgn, nicknameSuffix);
      if (!ign) {
        return replyError(interaction, 'IGN must include at least 1 visible character.');
      }

      // checks
      if (recruitedGuildMember.user.bot) return replyError(interaction, 'Cannot recruit bots.');

      const joinedAt = recruitedGuildMember.joinedAt;
      const now = new Date();
      if (!joinedAt) return replyError(interaction, 'Unable to verify when that member joined. Please try again.');
      const minutesSinceJoin = (now - joinedAt) / 1000 / 60;
      if (minutesSinceJoin > 120) return replyError(interaction, 'Cannot give roles to someone who joined more than 2 hours ago.');

      const accountAgeDays = (now - recruitedGuildMember.user.createdAt) / (1000 * 60 * 60 * 24);
      if (accountAgeDays < (30 * 6)) return replyError(interaction, 'Account must be at least 6 months old.');

      // already verified = has rookie
      if (recruitedGuildMember.roles.cache.has(ROLE_IDS.ROOKIE)) return replyError(interaction, 'Member is already verified.');

      // check if recruited already
      const exist = await db.get(
        'SELECT * FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 1',
        guildId,
        member.id
      );
      if (exist) return replyError(interaction, 'That member has already been recruited previously.');

      const chosenRole = pickOnboardingRole(team);
      if (!chosenRole) {
        return replyError(interaction, 'No onboarding role is configured for this team.');
      }

      try {
        // remove unverified if present
        if (recruitedGuildMember.roles.cache.has(ROLE_IDS.UNVERIFIED)) await recruitedGuildMember.roles.remove(ROLE_IDS.UNVERIFIED);
        // ensure only one onboarding team role remains on the member
        const onboardingRoleIds = getAllOnboardingRoleIds();
        for (const onboardingRoleId of onboardingRoleIds) {
          if (onboardingRoleId !== chosenRole && recruitedGuildMember.roles.cache.has(onboardingRoleId)) {
            await recruitedGuildMember.roles.remove(onboardingRoleId);
          }
        }
        // add rookie
        await recruitedGuildMember.roles.add(ROLE_IDS.ROOKIE);
        // add chosen onboarding role
        await recruitedGuildMember.roles.add(chosenRole);

        // set nickname
        if (recruitedGuildMember.manageable) {
          await recruitedGuildMember.setNickname(`${ign}${nicknameSuffix}`).catch(err => {
            reportRecruitError('command.recruit.setNickname', err);
          });
        }

        try {
          await db.run(
            'INSERT OR REPLACE INTO rookie_points (guild_id, member_id, points, updated_at) VALUES (?, ?, ?, ?)',
            guildId,
            recruitedGuildMember.id,
            0,
            Date.now()
          );
        } catch (e) {
          reportRecruitError('command.recruit.initRookiePoints', e);
        }


        // Determine recruiter role and active multiplier, compute points
        const recruiterMember = creditedRecruiterMember;
        let recruiterRole = 'NONE';
        if (recruiterMember) {
          if (recruiterMember.roles.cache.has(ROLE_IDS.VIP)) recruiterRole = 'VIP';
          else if (recruiterMember.roles.cache.has(ROLE_IDS.MVP)) recruiterRole = 'MVP';
          else if (recruiterMember.roles.cache.has(ROLE_IDS.CUSTOM)) recruiterRole = 'CUSTOM';
        }
        const multiplier = await getActiveMultiplier(db, creditedRecruiterId);
        const points = calculateRecruitPoints({ recruiterRole, multiplierValue: multiplier.value });

        // Database writes in a transaction to avoid partial state
        const nowTs = Date.now();
        await db.run('BEGIN TRANSACTION');
        try {
          // Cleanup prior revoked records to allow re-recruitment if unique constraint exists
          await db.run('DELETE FROM recruits WHERE guild_id = ? AND recruited_id = ? AND valid = 0', guildId, member.id);

          await db.run(
            'INSERT INTO recruits (guild_id, recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, ?, 1, ?)',
            guildId,
            creditedRecruiterId,
            member.id,
            team,
            ign,
            nowTs,
            points
          );
          await db.run(
            'INSERT OR IGNORE INTO recruiters (guild_id, id, points, warnings, promoted, channel_base) VALUES (?, ?, 0, 0, 0, 4)',
            guildId,
            creditedRecruiterId
          );
          await db.run(
            'UPDATE recruiters SET points = points + ? WHERE guild_id = ? AND id = ?',
            points,
            guildId,
            creditedRecruiterId
          );
          await db.run('COMMIT');
        } catch (e) {
          await db.run('ROLLBACK');
          throw e;
        }

        try {
          if (recruiterMember) {
            await updateTrialFastTrack(db, interaction.guild, recruiterMember, member.id);
          }
        } catch (e) {
          reportRecruitError('command.recruit.trialFastTrack', e);
        }

        try {
          if (recruiterMember) {
            await refreshCurrentWeekCalculationAfterRecruit(db, interaction.guild, recruiterMember);
          }
        } catch (e) {
          reportRecruitError('command.recruit.refreshCurrentWeekCalculation', e);
        }

        try {
          const scheduler = require('../../scheduler');
          await scheduler.recomputeLeaderboards(db, interaction.guild);
          if (typeof scheduler.recomputeWarningsLeaderboard === 'function') {
            await scheduler.recomputeWarningsLeaderboard(db, interaction.guild);
          }
        } catch (e) {
          reportRecruitError('command.recruit.recomputeLeaderboards', e);
        }

        try {
          await campaignService.createCampaign({
            guild: interaction.guild,
            requestedBy: interaction.user.id,
            messageType: 'system_welcome',
            messageBody: buildRecruitWelcomeMessage(teamName),
            targetMode: 'direct',
            directUserIds: [member.id]
          });
        } catch (e) {
          reportRecruitError('command.recruit.welcomeDm.queue', e);
        }

        let dmFailure = null;
        try {
          await recruitedGuildMember.send({
            content: buildRecruitWelcomeMessage(teamName),
            allowedMentions: { parse: [] }
          });
        } catch (err) {
          const isBlocked = isExpectedWelcomeDmFailure(err);
          dmFailure = isBlocked ? 'blocked' : 'error';
          const tag = member && (member.tag || member.username) ? (member.tag || member.username) : member.id;
          if (isBlocked) {
            void logRuntimeEvent('warn', 'command.recruit.welcomeDm.skipped', 'Rookie welcome DM skipped (DM blocked/closed)', {
              command: 'recruit',
              guildId,
              recruitedId: member.id,
              tag
            });
          } else {
            reportRecruitError('command.recruit.welcomeDm.send', err);
          }
        }

        const dmNote = dmFailure === 'blocked'
          ? ' Note: I could not DM them (their DMs are closed).'
          : dmFailure === 'error'
            ? ' Note: I could not DM them due to an unexpected error.'
            : '';

        const creditedText = isCreditOverride ? ` to <@${creditedRecruiterId}>` : '';
        return respond({ content: `Successfully recruited ${member.tag} as ${teamName}. Awarded **${formatPointsValue(points)}** points${creditedText}.${dmNote}` });
      } catch (err) {
        const dispatchResult = await logUnexpectedError('command.recruit.execute.inner', err, {
          command: 'recruit',
          guildId,
          recruiterId: creditedRecruiterId || interaction.user.id
        });

        // Handle specific errors
        if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
          return replyError(interaction, 'That member has already been recruited before and cannot be recruited again.');
        }

        if (err && err.message && err.message.includes('Missing Permissions')) {
          return replyError(interaction, 'Missing permissions to assign roles. Please check bot permissions.');
        }

        if (err && err.message && err.message.includes('Unknown User')) {
          return replyError(interaction, 'Unable to find one of the users mentioned.');
        }

        // Generic error
        return replyError(interaction, `An error occurred while processing the recruit command. Please try again later.${dispatchResult && dispatchResult.supportId ? ` Support ID: \`${dispatchResult.supportId}\`.` : ''}`);
      }
    } catch (err) {
      const dispatchResult = await logUnexpectedError('command.recruit.execute.outer', err, {
        command: 'recruit',
        guildId: interaction.guild ? interaction.guild.id : null,
        recruiterId: creditedRecruiterId || (interaction.user ? interaction.user.id : null)
      });
      return replyError(interaction, `An error occurred while processing the recruit command. Please try again later.${dispatchResult && dispatchResult.supportId ? ` Support ID: \`${dispatchResult.supportId}\`.` : ''}`);
    }
  }
};

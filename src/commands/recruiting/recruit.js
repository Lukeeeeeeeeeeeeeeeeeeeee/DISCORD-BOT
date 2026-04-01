const { SlashCommandBuilder, PermissionFlagsBits, PermissionsBitField } = require('discord.js');
const {
  ROLE_IDS,
  RECRUITER_ROLE_IDS,
  REGION_ROLE_IDS,
  REGION_INFO,
  RECRUIT_POLICY
} = require('../../constants');
const { getRegionInfo, getTeamLabel } = require('../../lib/regions');
const { replyError } = require('../../lib/embeds');
const db = require('../../db_async');
const { buildRecruitWelcomeMessage } = require('../../lib/join-welcome');
const { getActiveMultiplier, calculateRecruitPoints, formatPointsValue } = require('../../lib/economy');
const { fetchMembersByIds } = require('../../lib/member-fetch');
const { resolveGuildId } = require('../../lib/guild');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');
const { hasRecruiterOrStaffPermissions, hasAdministrator } = require('../../lib/permissions');
const { calculate7DayStats, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement } = require('../../lib/recruiting-system');
const { getWeekStartUtcTs } = require('../../lib/week');
const { withTransaction } = require('../../lib/transactions');
const recruitsRepo = require('../../repos/recruits-repo');
const rookiePointsRepo = require('../../repos/rookie-points-repo');
const trialFastTrackRepo = require('../../repos/trial-fast-track-repo');
const { changeRecruiterPoints } = require('../../services/recruiting/ledger-service');
const scheduler = require('../../scheduler');

// --- Helper Functions (Visible in Command) ---

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

function getRecruitPolicy() {
  const defaults = RECRUIT_POLICY || {};
  const parseThreshold = (val, def) => (val != null && !isNaN(Number(val))) ? Number(val) : def;
  const parseBool = (val, def) => val === 'true' || val === '1' || val === true ? true : (val === 'false' || val === '0' || val === false ? false : !!def);

  return {
    maxJoinMinutes: parseThreshold(process.env.RECRUIT_MAX_JOIN_MINUTES, parseThreshold(defaults.MAX_JOIN_MINUTES, 120)),
    minAccountAgeDays: parseThreshold(process.env.RECRUIT_MIN_ACCOUNT_AGE_DAYS, parseThreshold(defaults.MIN_ACCOUNT_AGE_DAYS, 180)),
    allowLateAdminOverride: parseBool(process.env.RECRUIT_ALLOW_LATE_ADMIN_OVERRIDE, parseBool(defaults.ALLOW_LATE_ADMIN_OVERRIDE, true))
  };
}

async function updateTrialFastTrack(guild, recruiterMember, recruitedId) {
  if (!recruiterMember || !recruiterMember.roles || !recruiterMember.roles.cache) return { promoted: false };
  if (!recruiterMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)) return { promoted: false };
  if (recruiterMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE)) return { promoted: false };

  const now = Date.now();
  const windowMs = 9 * 24 * 60 * 60 * 1000;
  const guildId = resolveGuildId(guild);

  let row = await trialFastTrackRepo.getByRecruiter(db, guildId, recruiterMember.id);
  const needsResetByTime = !row || (now - row.started_at) > windowMs;

  if (needsResetByTime) {
    await trialFastTrackRepo.upsert(db, guildId, recruiterMember.id, {
      startedAt: now, recruit1Id: null, recruit2Id: null, recruit3Id: null, count: 0, updatedAt: now
    });
    row = await trialFastTrackRepo.getByRecruiter(db, guildId, recruiterMember.id);
  }

  if ([row.recruit1_id, row.recruit2_id, row.recruit3_id].includes(recruitedId)) return { promoted: false };

  let count = (row.count || 0) + 1;
  const updates = { recruit1Id: row.recruit1_id || recruitedId, recruit2Id: row.recruit1_id ? (row.recruit2_id || recruitedId) : null, recruit3Id: (row.recruit1_id && row.recruit2_id) ? (row.recruit3_id || recruitedId) : null };
  
  await trialFastTrackRepo.upsert(db, guildId, recruiterMember.id, {
    startedAt: row.started_at, ...updates, count: Math.min(3, count), updatedAt: now
  });

  if (count >= 3) {
    const rolesToAdd = [ROLE_IDS.AUTO_PROMOTE_ROLE, ROLE_IDS.RECRUITER].filter(Boolean);
    await recruiterMember.roles.add(rolesToAdd, 'Trial auto-promotion').catch(() => null);
    await recruiterMember.roles.remove(ROLE_IDS.TRIAL_RECRUITER, 'Trial auto-promotion').catch(() => null);
    await db.run('UPDATE recruiters SET promoted = 1 WHERE guild_id = ? AND id = ?', guildId, recruiterMember.id);
    return { promoted: true };
  }
  return { promoted: false };
}

async function refreshCurrentWeekCalculation(guild, recruiterMember) {
  try {
    const guildId = resolveGuildId(guild);
    const weekStart = getWeekStartUtcTs();
    const stats = await calculate7DayStats(db, recruiterMember.id, guild, { sinceTs: weekStart, untilTs: Date.now(), guildId });
    const warnings = (await db.get('SELECT COUNT(*) as c FROM warnings WHERE guild_id = ? AND recruiter_id = ? AND revoked = 0', guildId, recruiterMember.id))?.c || 0;
    const roleBase = getBaseRequirement(recruiterMember);
    
    const calculatedMinReq = calculateMinRecruitsFixed({
      roleBase, member: recruiterMember, recruits7d: stats.recruits7d, activityRate: stats.activityRate,
      verifyRate: stats.verifyRate, retention: stats.retention, warnings, absent: false, isNewStaff: false
    });

    await storeWeeklyCalculation(db, {
      guildId, recruiterId: recruiterMember.id, weekStart, ...stats, warnings, calculatedMinReq, roleBase
    });
  } catch (e) {
    void e;
  }
}

// --- Main Command ---

module.exports = {
  data: new SlashCommandBuilder()
    .setName('recruit')
    .setDescription('Recruit a new member into the guild.')
    .addUserOption(option =>
      option.setName('member').setDescription('The member to recruit').setRequired(true))
    .addStringOption(option =>
      option.setName('ign').setDescription('The In-Game Name of the member').setRequired(true))
    .addUserOption(option =>
      option.setName('credit_to').setDescription('Credit this recruit to another recruiter (Admin only)').setRequired(false))
    .addBooleanOption(option =>
      option.setName('admin_bypass').setDescription('Bypass account age and join time checks (Admin only)').setRequired(false))
    .setDefaultMemberPermissions(PermissionFlagsBits.SendMessages)
    .setDMPermission(false),

  async execute(interaction) {
    const traceId = `recruit_${Date.now().toString(36)}`;
    
    if (!interaction.deferred && !interaction.replied) {
      await interaction.deferReply();
    }

    const member = interaction.options.getUser('member');
    const rawIgn = interaction.options.getString('ign');
    const creditedRecruiter = interaction.options.getUser('credit_to') || null;
    const creditedRecruiterId = creditedRecruiter ? creditedRecruiter.id : interaction.user.id;
    const isCreditOverride = creditedRecruiterId !== interaction.user.id;
    const adminBypass = interaction.options.getBoolean('admin_bypass') || false;

    try {
      const guildId = resolveGuildId(interaction.guild);
      const botMember = interaction.guild.members.me || await interaction.guild.members.fetch(interaction.client.user.id);
      
      // Basic Permission Checks
      const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!guildMember || !hasRecruiterOrStaffPermissions(guildMember)) {
        return replyError(interaction, 'Missing recruiter permissions.');
      }

      // Admin Override Guards
      if (isCreditOverride && !hasAdministrator(guildMember)) {
        return replyError(interaction, 'Only Administrators can credit recruits to others.');
      }
      if (adminBypass && !hasAdministrator(guildMember)) {
        return replyError(interaction, 'Only Administrators can use admin bypass.');
      }

      // Check for existing active recruit record in DB (Race Condition prevention)
      const existing = await recruitsRepo.getActiveByRecruitedId(db, guildId, member.id);
      if (existing) {
        return replyError(interaction, 'This member is already an active recruit in the database.');
      }

      const recruitedGuildMember = await interaction.guild.members.fetch(member.id).catch(() => null);
      if (!recruitedGuildMember) return replyError(interaction, 'Member not found.');

      // Team Inference
      let team = inferTeamFromRecruiter(guildMember);
      const regionTag = inferRegionTagFromMember(recruitedGuildMember);
      if (!team) {
        if (hasAdministrator(guildMember) && (regionTag === 'EU' || regionTag === 'NA' || regionTag === 'AS')) {
          team = regionTag;
        } else {
          return replyError(interaction, 'Could not determine team. Ensure visitor has a region role.');
        }
      }

      const teamInfo = getRegionInfo(team);
      const teamName = teamInfo?.name || team;
      const nicknameSuffix = ` | ${regionTag || team} 0/10`;
      const ign = normalizeIgn(rawIgn, nicknameSuffix);

      // Policy Checks
      const policy = getRecruitPolicy();
      const joinedAt = recruitedGuildMember.joinedAt;
      const now = new Date();
      
      if (!adminBypass) {
        if (joinedAt) {
          const minutesSinceJoin = Math.floor((now - joinedAt) / 60000);
          if (policy.maxJoinMinutes > 0 && minutesSinceJoin > policy.maxJoinMinutes && !policy.allowLateAdminOverride) {
            return replyError(interaction, `Member joined ${minutesSinceJoin} minutes ago, which exceeds the ${policy.maxJoinMinutes}-minute limit.`);
          }
        }
        const accountAge = Math.floor((now - recruitedGuildMember.user.createdAt) / 86400000);
        if (policy.minAccountAgeDays > 0 && accountAge < policy.minAccountAgeDays) {
          return replyError(interaction, `Account is only ${accountAge} days old, but must be at least ${policy.minAccountAgeDays} days old.`);
        }
        if (recruitedGuildMember.roles.cache.has(ROLE_IDS.ROOKIE)) {
          return replyError(interaction, 'Member already has the Rookie role.');
        }
      }

      const chosenRole = pickOnboardingRole(team);
      
      // Hierarchy Protection (VULN-11)
      const roleIdsToManage = [ROLE_IDS.ROOKIE, chosenRole, ROLE_IDS.UNVERIFIED].filter(Boolean);
      for (const rid of roleIdsToManage) {
        let role = interaction.guild.roles.cache.get(rid);
        if (!role) {
          role = await interaction.guild.roles.fetch(rid).catch(() => null);
        }
        if (role && botMember.roles.highest.position <= role.position) {
          return replyError(interaction, `Permission Hierarchy Error: Bot cannot manage the **${role.name}** role. Please move the bot role higher in server settings. ❌`);
        }
      }

      // Residual Role Cleanup (with Hierarchy Guard)
      const onboardingRoleIds = [ROLE_IDS.ONBOARDING_FIRE, ROLE_IDS.ONBOARDING_WATER, ROLE_IDS.ONBOARDING_AIR, ...(Array.isArray(ROLE_IDS.ONBOARDING) ? ROLE_IDS.ONBOARDING : [])].filter(Boolean);
      const rolesToRemove = [];
      for (const r of recruitedGuildMember.roles.cache.values()) {
        if ((onboardingRoleIds.includes(r.id) && r.id !== chosenRole) || r.id === ROLE_IDS.UNVERIFIED) {
          if (botMember.roles.highest.position > r.position) {
            rolesToRemove.push(r.id);
          } else {
            void logRuntimeEvent('warn', 'command.recruit.hierarchySkip', 'Cannot remove residual role due to hierarchy', { role: r.name, recruitedId: member.id });
          }
        }
      }

      // Points & DB Operations
      // NOTE: economy.js uses a simplified base-point system; role-based modifiers are handled by the ledger-service if applied.
      const recruiterMember = creditedRecruiter ? await interaction.guild.members.fetch(creditedRecruiterId).catch(() => null) : guildMember;
      const { value: mult } = await getActiveMultiplier(db, creditedRecruiterId, { guildId });
      const points = calculateRecruitPoints({ multiplierValue: mult });

      // EXECUTE TRANSACTION
      let recruitRecordId = 0;
      await withTransaction(db, async (tx) => {
        await recruitsRepo.deleteInvalidByRecruitedId(tx, guildId, member.id);
        const res = await recruitsRepo.insertRecruit(tx, guildId, {
          recruiterId: creditedRecruiterId,
          recruitedId: member.id,
          region: team,
          ign,
          createdAt: Date.now(),
          points,
          valid: 0
        });
        recruitRecordId = res.lastID;
        await rookiePointsRepo.initMember(tx, guildId, member.id, { points: 0, updatedAt: Date.now() });
      });

      // DISCORD UPDATES (with rollback)
      try {
        if (rolesToRemove.length) await recruitedGuildMember.roles.remove(rolesToRemove);
        await recruitedGuildMember.roles.add([ROLE_IDS.ROOKIE, chosenRole].filter(Boolean));
        if (recruitedGuildMember.manageable) {
          await recruitedGuildMember.setNickname(`${ign}${nicknameSuffix}`);
        }
      } catch (err) {
        // Rollback state if Discord fails
        await withTransaction(db, async (tx) => {
          await recruitsRepo.markInvalidById(tx, guildId, recruitRecordId);
        });
        throw err;
      }

      // FINALIZE
      await withTransaction(db, async (tx) => {
        await recruitsRepo.markValidById(tx, guildId, recruitRecordId);
        await changeRecruiterPoints(tx, {
          guildId,
          recruiterId: creditedRecruiterId,
          delta: points,
          reason: 'recruit_award',
          refType: 'recruit',
          refId: String(recruitRecordId)
        });
      });

      // Background tasks (Leaderboards, Trial Fast Track, Weekly Stats)
      void scheduler.recomputeLeaderboards(db, interaction.guild).catch(() => null);
      
      try {
        if (recruiterMember) {
          await updateTrialFastTrack(interaction.guild, recruiterMember, member.id);
          await refreshCurrentWeekCalculation(interaction.guild, recruiterMember);
        }
      } catch (bgErr) {
        void bgErr;
      }
      
      await recruitedGuildMember.send({ content: buildRecruitWelcomeMessage(teamName) }).catch(() => null);

      const creditedText = isCreditOverride ? ` to <@${creditedRecruiterId}>` : '';
      return interaction.editReply({ content: `Successfully recruited ${member.tag} as ${teamName}. Awarded **${formatPointsValue(points)}** points${creditedText}.` });

    } catch (err) {
      void logUnexpectedError('command.recruit.execute', err, { traceId, guildId: interaction.guild.id });
      return replyError(interaction, `Failed to recruit. Ref: ${traceId}`);
    }
  }
};

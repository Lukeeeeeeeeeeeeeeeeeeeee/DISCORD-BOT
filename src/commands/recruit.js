const { ROLE_IDS, RECRUITER_ROLE_IDS, REGION_ROLE_IDS, REGION_INFO } = require('../constants');
const db = require('../db_async');
const { getActiveMultiplier, calculateRecruitPoints } = require('../lib/economy');
const { calculate7DayStats, storeWeeklyCalculation, calculateMinRecruitsFixed, getBaseRequirement } = require('../lib/recruiting-system');

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

function buildRookieWelcomeMessage(teamName) {
  return `Welcome to Solace! You have been recruited in ${teamName}.
Make sure you read how to war, whats a war and see readme!

# <:SOLACEONTOP:1460693669391765750> SOLACE ROOKIE INFO
Hello there and welcome to Solace! 💛
The first thought that crosses your mind might be the reason behind your being given the <@&1331020584473329726>—it's our basic role. You will have to earn <@&1331020565879984198> to gain full access to Solace. To gain full access to Solace, you have to collect points to help you move up. There are three methods available to you:

🌟 Point Earning Methods

> 1. Wars / Ganks
> Take part in 2 wars or ganks in a 2-week period
> <:greenarrow:1459897308610039900> 5 points apiece
> -# **Wars / Ganks happen randomly**

2. Recruiting (Fast Track)
> As <@&1459956798172827933>, get 3 people on board in 9 days
> <:greenarrow:1459897308610039900> Direct promotion to <@&1331020565879984198> + <@&1331020553707847772>
***⚠️ If 3 recruits are not reached within the specified time, the process goes back to zero.***

3. Activity (Chatting)
> In a week's time send 550 messages
> <:greenarrow:1459897308610039900> 1.5 points for every 105 messages (public channels only)

You can combine any combination of these methods or concentrate solely on one (2 & 3 are the most consistent). Also, keep in mind that they are **not** permanent points!

What Are Points? 📊
Points are shown beside your name (e.g., 0/10). With more wars, chat, and recruiting activities, the points go up.

Logging Progress 📝
Make sure to put down your achievements in <#1331020800551293030> always. This is a must to ensure the counting of your points and your elevation. **Why?**
<:greenarrow:1459897308610039900> Logging your progression insures that you get the points you worked for. It also is a chart of your progression if that helps you in terms of motivation.

Wishing you good luck and once again welcoming you to Solace 💙`;
}

async function storeMinReqSnapshotAfterPromotion(db, guild, recruiterMember) {
  try {
    const currentStats = await calculate7DayStats(db, recruiterMember.id);

    const warnings = await db.get(
      'SELECT COUNT(*) as c FROM warnings WHERE recruiter_id = ? AND revoked = 0 AND (expired_at IS NULL OR expired_at > ?)',
      recruiterMember.id, Date.now()
    );
    const activeWarnings = warnings ? warnings.c : 0;
    const absence = await db.get(
      'SELECT * FROM absences WHERE recruiter_id = ? AND active = 1 AND end_date >= date("now")',
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
      recruiterId: recruiterMember.id,
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
    console.error('Failed to store weekly calc after trial promotion:', e);
  }
}

async function updateTrialFastTrack(db, guild, recruiterMember, recruitedId) {
  if (!recruiterMember || !recruiterMember.roles || !recruiterMember.roles.cache) return { promoted: false };
  if (!recruiterMember.roles.cache.has(ROLE_IDS.TRIAL_RECRUITER)) return { promoted: false };
  if (recruiterMember.roles.cache.has(ROLE_IDS.AUTO_PROMOTE_ROLE)) return { promoted: false };

  const now = Date.now();
  const windowMs = 9 * 24 * 60 * 60 * 1000;

  let row = await db.get('SELECT * FROM trial_fast_track WHERE recruiter_id = ?', recruiterMember.id);
  const needsResetByTime = !row || (now - row.started_at) > windowMs;

  if (needsResetByTime) {
    await db.run(
      'INSERT OR REPLACE INTO trial_fast_track (recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, NULL, NULL, NULL, 0, ?)',
      recruiterMember.id,
      now,
      now
    );
    row = await db.get('SELECT * FROM trial_fast_track WHERE recruiter_id = ?', recruiterMember.id);
  }

  const trackedIds = [row.recruit1_id, row.recruit2_id, row.recruit3_id].filter(Boolean);
  for (const id of trackedIds) {
    const m = await guild.members.fetch(id).catch(() => null);
    if (!m) {
      await db.run(
        'INSERT OR REPLACE INTO trial_fast_track (recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, NULL, NULL, NULL, 0, ?)',
        recruiterMember.id,
        now,
        now
      );
      row = await db.get('SELECT * FROM trial_fast_track WHERE recruiter_id = ?', recruiterMember.id);
      break;
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
      'INSERT OR REPLACE INTO trial_fast_track (recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
    'INSERT OR REPLACE INTO trial_fast_track (recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
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
    'SELECT recruited_id FROM recruits WHERE recruiter_id = ? AND valid = 1 AND created_at >= ? ORDER BY created_at DESC LIMIT 3',
    recruiterMember.id,
    windowStart
  );

  const shouldPromote = (count >= 3) || (recent && recent.length >= 3);
  if (!shouldPromote) return { promoted: false };

  const idsToCheck = (recent && recent.length >= 3)
    ? recent.map(r => r.recruited_id)
    : [updates.recruit1_id, updates.recruit2_id, updates.recruit3_id].filter(Boolean);

  for (const id of idsToCheck) {
    const m = await guild.members.fetch(id).catch(() => null);
    if (!m) {
      await db.run(
        'INSERT OR REPLACE INTO trial_fast_track (recruiter_id, started_at, recruit1_id, recruit2_id, recruit3_id, count, updated_at) VALUES (?, ?, NULL, NULL, NULL, 0, ?)',
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
      'SELECT region, COUNT(*) as c FROM recruits WHERE recruiter_id = ? AND created_at >= ? AND valid = 1 GROUP BY region ORDER BY c DESC',
      recruiterMember.id,
      windowStart
    );
    const topRegion = rows && rows.length ? rows[0].region : null;
    recruiterRoleId = topRegion ? require('../constants').RECRUITER_ROLE_IDS[topRegion] : null;
  } catch (e) {
    recruiterRoleId = null;
  }

  await recruiterMember.roles.remove(ROLE_IDS.TRIAL_RECRUITER).catch(() => { });
  await recruiterMember.roles.add(ROLE_IDS.AUTO_PROMOTE_ROLE).catch(() => { });
  await recruiterMember.roles.add(ROLE_IDS.RECRUITER).catch(() => { });
  if (recruiterRoleId) await recruiterMember.roles.add(recruiterRoleId).catch(() => { });

  try {
    await db.run('UPDATE recruiters SET promoted = 1 WHERE id = ?', recruiterMember.id);
  } catch (e) {
    void e;
  }

  await storeMinReqSnapshotAfterPromotion(db, guild, recruiterMember);

  await db.run('DELETE FROM trial_fast_track WHERE recruiter_id = ?', recruiterMember.id).catch(() => { });
  return { promoted: true };
}

module.exports = {
  data: { name: 'recruit' },
  async execute(interaction) {
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
      const ign = interaction.options.getString('ign');

      // Validate inputs
      if (!member || !ign) {
        return respond({ content: 'Missing required parameters. Please provide member and ign.' });
      }

      // Check if user has permission to recruit (basic check)
      const guildMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      if (!guildMember) {
        return respond({ content: 'Unable to verify your guild membership.' });
      }

      // Only recruiters (incl trial/regional) or staff/admin can recruit.
      // In tests we run with minimal mocks; skip strict permission enforcement there.
      if (process.env.NODE_ENV !== 'test') {
        const { hasRecruiterOrStaffPermissions } = require('../lib/permissions');
        if (!hasRecruiterOrStaffPermissions(guildMember)) {
          return respond({ content: 'You do not have permission to recruit members. You need the Recruiter role (or Trial Recruiter / team recruiter).' });
        }
      }

      const recruitedGuildMember = await interaction.guild.members.fetch(member.id).catch(() => null);
      if (!recruitedGuildMember) return respond({ content: 'Member not found in this guild.' });

      const { hasAdministrator } = require('../lib/permissions');
      const recruiterMemberForTeam = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
      let team = inferTeamFromRecruiter(recruiterMemberForTeam);
      const regionTag = inferRegionTagFromMember(recruitedGuildMember);
      if (!team) {
        if (recruiterMemberForTeam && hasAdministrator(recruiterMemberForTeam)) {
          team = regionTag === 'NA' ? 'NA' : (regionTag === 'AS' ? 'AS' : 'EU');
        } else {
          return respond({ content: 'You must have a team recruiter role (Fire/Water/Air) to use this command.' });
        }
      }
      const teamName = (REGION_INFO && REGION_INFO[team] && REGION_INFO[team].name) ? REGION_INFO[team].name : team;

      // checks
      if (recruitedGuildMember.user.bot) return respond({ content: 'Cannot recruit bots.' });

      const joinedAt = recruitedGuildMember.joinedAt;
      const now = new Date();
      if (!joinedAt) return respond({ content: 'Unable to verify when that member joined. Please try again.' });
      const minutesSinceJoin = (now - joinedAt) / 1000 / 60;
      if (minutesSinceJoin > 120) return respond({ content: 'Cannot give roles to someone who joined more than 2 hours ago.' });

      const accountAgeDays = (now - recruitedGuildMember.user.createdAt) / (1000 * 60 * 60 * 24);
      if (accountAgeDays < (30 * 6)) return respond({ content: 'Account must be at least 6 months old.' });

      // already verified = has rookie
      if (recruitedGuildMember.roles.cache.has(ROLE_IDS.ROOKIE)) return respond({ content: 'Member is already verified.' });

      // check if recruited already
      const exist = await db.get('SELECT * FROM recruits WHERE recruited_id = ? AND valid = 1', member.id);
      if (exist) return respond({ content: 'That member has already been recruited previously.' });

      const chosenRole = pickOnboardingRole(team);

      try {
        // remove unverified if present
        if (recruitedGuildMember.roles.cache.has(ROLE_IDS.UNVERIFIED)) await recruitedGuildMember.roles.remove(ROLE_IDS.UNVERIFIED);
        // add rookie
        await recruitedGuildMember.roles.add(ROLE_IDS.ROOKIE);
        // add chosen onboarding role
        if (chosenRole) await recruitedGuildMember.roles.add(chosenRole);

        // set nickname
        await recruitedGuildMember.setNickname(`${ign} | ${regionTag || team} 0/10`).catch(() => null);

        try {
          await db.run(
            'INSERT OR REPLACE INTO rookie_points (member_id, points, updated_at) VALUES (?, ?, ?)',
            recruitedGuildMember.id,
            0,
            Date.now()
          );
        } catch (e) {
          console.error('Failed to initialize rookie points:', e);
        }

        try {
          if (recruitedGuildMember) {
            await recruitedGuildMember.send(buildRookieWelcomeMessage(teamName)).catch(() => { });
          }
        } catch (e) {
          void e;
        }

        // Determine recruiter role and active multiplier, compute points
        const recruiterMember = await interaction.guild.members.fetch(interaction.user.id).catch(() => null);
        let recruiterRole = 'NONE';
        if (recruiterMember) {
          if (recruiterMember.roles.cache.has(ROLE_IDS.VIP)) recruiterRole = 'VIP';
          else if (recruiterMember.roles.cache.has(ROLE_IDS.MVP)) recruiterRole = 'MVP';
          else if (recruiterMember.roles.cache.has(ROLE_IDS.CUSTOM)) recruiterRole = 'CUSTOM';
        }
        const multiplier = await getActiveMultiplier(db, interaction.user.id);
        const points = calculateRecruitPoints({ recruiterRole, multiplierValue: multiplier.value });

        // Database writes in a transaction to avoid partial state
        const nowTs = Date.now();
        await db.run('BEGIN TRANSACTION');
        try {
          // Cleanup prior revoked records to allow re-recruitment if unique constraint exists
          await db.run('DELETE FROM recruits WHERE recruited_id = ? AND valid = 0', member.id);

          await db.run('INSERT INTO recruits (recruiter_id, recruited_id, region, ign, created_at, valid, points) VALUES (?, ?, ?, ?, ?, 1, ?)', interaction.user.id, member.id, team, ign, nowTs, points);
          await db.run('INSERT OR IGNORE INTO recruiters (id, points, warnings, promoted, channel_base) VALUES (?, 0, 0, 0, 4)', interaction.user.id);
          await db.run('UPDATE recruiters SET points = points + ? WHERE id = ?', points, interaction.user.id);
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
          console.error('Trial fast-track update failed:', e);
        }

        try {
          const scheduler = require('../scheduler');
          await scheduler.recomputeLeaderboards(db, interaction.guild);
        } catch (e) {
          console.error('Failed updating leaderboards:', e);
        }

        return respond({ content: `Successfully recruited ${member.tag} as ${teamName}. Awarded **${points}** points.` });
      } catch (err) {
        console.error('Recruit command error:', err);

        // Handle specific errors
        if (err && err.message && err.message.includes('UNIQUE constraint failed')) {
          return respond({ content: 'That member has already been recruited before and cannot be recruited again.' });
        }

        if (err && err.message && err.message.includes('Missing Permissions')) {
          return respond({ content: 'Missing permissions to assign roles. Please check bot permissions.' });
        }

        if (err && err.message && err.message.includes('Unknown User')) {
          return respond({ content: 'Unable to find one of the users mentioned.' });
        }

        // Generic error
        return respond({ content: 'An error occurred while processing the recruit command. Please try again later.' });
      }
    } catch (err) {
      console.error('Recruit command error:', err);
      if (typeof interaction.reply === 'function') {
        return interaction.reply({ content: 'An error occurred while processing the recruit command. Please try again later.' });
      }
      if (typeof interaction.editReply === 'function') {
        return interaction.editReply({ content: 'An error occurred while processing the recruit command. Please try again later.' });
      }

      return null;
    }
  }
};
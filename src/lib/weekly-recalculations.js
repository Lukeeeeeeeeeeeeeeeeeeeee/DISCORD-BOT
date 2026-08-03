const db = require('../db_async');
const { EmbedBuilder } = require('discord.js');
const { getWeekStartUtcTs } = require('./week');
const { formatUtcDateOnly } = require('./time');
const {
  getPreviousMinReq,
  storeWeeklyCalculation,
  calculateMinRecruitsFixed,
  getBaseRequirement,
  getRoleLevel
} = require('../lib/recruiting-system');
const { CHANNELS, ROLE_IDS, RECRUITER_ROLE_IDS } = require('../constants');
const { resolveGuildId } = require('./guild');
const { withTransaction } = require('../lib/transactions');
const { loadRecruiterMeta } = require('../lib/leaderboard-utils');
const { logUnexpectedError, logRuntimeEvent } = require('../lib/logger');

const WEEK_ROLLOVER_OFFSET_MS = 5 * 60 * 1000;
const CALC_CONCURRENCY = Number.parseInt(process.env.RECALC_CONCURRENCY || '4', 10);

const { runWithConcurrency } = require('../lib/concurrency');

function getRetryAfterMs(error, fallbackMs) {
  const retryAfter = error && (error.retryAfter ?? error.retry_after ?? error.data?.retry_after ?? error.rawError?.retry_after);
  if (Number.isFinite(retryAfter)) {
    const value = Number(retryAfter);
    return value < 1000 ? Math.ceil(value * 1000) : Math.ceil(value);
  }
  return fallbackMs;
}

async function sendWithRetries(sendFn, opts = {}) {
  const maxRetries = Number.isFinite(opts.maxRetries) ? opts.maxRetries : 2;
  const baseDelayMs = Number.isFinite(opts.baseDelayMs) ? opts.baseDelayMs : 1500;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await sendFn();
    } catch (error) {
      const hardFail = error && (error.code === 50007 || error.code === 50013 || error.code === 50001);
      const rateLimited = error && (error.status === 429 || error.code === 429);
      if (hardFail || attempt >= maxRetries) throw error;
      const retryAfter = rateLimited
        ? getRetryAfterMs(error, baseDelayMs * (attempt + 1))
        : baseDelayMs * (attempt + 1);
      await new Promise(resolve => setTimeout(resolve, retryAfter));
    }
  }
  return null;
}

/**
 * Perform weekly recalculation for all recruiters.
 * Runs every Monday at 00:00 UTC via scheduler.js.
 *
 * E-06: NOTE — scheduler.js also calls runWeeklySnapshotAndReset() which performs overlapping work
 * (7-day stats, storeWeeklyCalculation, DMs). To avoid double-processing and duplicate DMs,
 * ensure only ONE of these two paths executes per Monday boundary. The scheduler.js
 * acquireSchedulerLock (keyed on weekStart) guards runWeeklySnapshotAndReset. If this function
 * is also called on the same schedule without a lock, recruiters may receive two DMs.
 * Audit: consider removing this function and routing fully to runWeeklySnapshotAndReset.
 */
async function performWeeklyRecalculations(guild) {
  const database = db;
  const guildId = resolveGuildId(guild);
  console.log('Starting weekly recruiter recalculation...');

  const weekStart = getWeekStartUtcTs(new Date(Date.now() + WEEK_ROLLOVER_OFFSET_MS));
  const weekWindowStart = weekStart - (7 * 24 * 60 * 60 * 1000);
  const statsWindow = { sinceTs: weekWindowStart, untilTs: weekStart, overrideWeekStart: weekStart };

  try {
    // Get all recruiters (staff roles + recruiter roles)
    const staffRoleIds = [
      ROLE_IDS.HELPER,
      ROLE_IDS.HELPER_PLUS,
      ROLE_IDS.MOD,
      ROLE_IDS.CHIEF,
      ROLE_IDS.CHIEF_OF_WAR,
      ROLE_IDS.CHIEF_OF_COMMUNITY,
      ROLE_IDS.CHIEF_OF_RECRUITMENT,
      ROLE_IDS.CO_LEADER,
      ROLE_IDS.LEADER,
      ROLE_IDS.HIGH_STAFF
    ];

    const recruiterRoleIds = [
      ROLE_IDS.RECRUITER,
      ROLE_IDS.TRIAL_RECRUITER,
      ...Object.values(RECRUITER_ROLE_IDS)
    ];

    const allRoleIds = [...staffRoleIds, ...recruiterRoleIds];

    const allStaff = [];
    for (const roleId of allRoleIds) {
      const role = guild.roles.cache.get(roleId);
      if (role) {
        role.members.forEach(member => {
          if (!allStaff.find(m => m.id === member.id)) {
            allStaff.push(member);
          }
        });
      }
    }

    console.log(`Found ${allStaff.length} staff members to recalculate`);
    const recruiterIds = allStaff.map(m => m.id);

    const { batchCalculate7DayStats, batchIsNewStaff } = require('./recruiter-stats');
    const allStats7dMap = await batchCalculate7DayStats(database, recruiterIds, guild, { ...statsWindow, guildId });
    const isNewStaffMap = await batchIsNewStaff(database, recruiterIds, guildId);
    
    // Batch fetch absences and warnings 
    const metaMap = await loadRecruiterMeta(database, recruiterIds, { guildId }).catch(() => ({ 
      absences: new Map(), 
      warnings: new Map(), 
      systemWarnings: new Map() 
    }));

    const calcResults = await runWithConcurrency(allStaff, CALC_CONCURRENCY, async (staffMember) => {
      try {
        // Get pre-fetched 7-day stats
        const stats7d = allStats7dMap.get(staffMember.id) || { recruits7d: 0, activityRate: 0, verifyRate: 0, retention: 0 };
        
        const previousMinReq = await getPreviousMinReq(database, staffMember.id, { guildId });
  
        // Look up absences and warnings from the batch map
        const absence = metaMap.absences.has(staffMember.id);
        const activeWarnings = metaMap.warnings.get(staffMember.id) || 0;
  
        // Get role base requirement
        const roleBase = getBaseRequirement(staffMember);
  
        // Check if new staff (look up from pre-calculated map)
        const newStaffCheck = isNewStaffMap.get(staffMember.id) ?? false;
  
        // Calculate and Store within a per-recruiter transaction block for atomic safety
        const newMinReq = await withTransaction(database, async (tx) => {
          const req = calculateMinRecruitsFixed({
            roleBase,
            member: staffMember,
            recruits7d: stats7d.recruits7d,
            activityRate: stats7d.activityRate,
            verifyRate: stats7d.verifyRate,
            retention: stats7d.retention,
            warnings: activeWarnings,
            previousMinReq,
            absent: !!absence,
            isNewStaff: newStaffCheck
          });
  
          await storeWeeklyCalculation(tx, {
            guildId,
            recruiterId: staffMember.id,
            weekStart,
            recruits7d: stats7d.recruits7d,
            activityRate: stats7d.activityRate,
            verifyRate: stats7d.verifyRate,
            retention: stats7d.retention,
            warnings: activeWarnings,
            absent: !!absence,
            previousMinReq,
            calculatedMinReq: req,
            roleBase
          });
          
          // P-04: Weekly Point Reset — Ensure points return to 0 for the new week window.
          await tx.run('UPDATE recruiters SET points = 0 WHERE guild_id = ? AND id = ?', guildId, staffMember.id);
  
          return req;
        });
  
        const result = {
          staffMember,
          newMinReq,
          stats7d,
          activeWarnings,
          absence,
          previousMinReq,
          roleBase
        };
  
        const roleLevel = getRoleLevel(staffMember);
        return { ok: true, result, notify: roleLevel > 0 };
      } catch (err) {
        void logUnexpectedError('service.weeklyRecalculations.perMember', err, {
          guildId,
          recruiterId: staffMember.id,
          weekStart
        });
        return { ok: false, error: err.message };
      }
    });

    const results = [];
    for (const entry of calcResults) {
      if (entry && entry.ok === false && entry.error) {
        console.error('Error recalculating staff member:', entry.error);
        continue;
      }
      if (!entry || !entry.ok || !entry.result) continue;
      results.push(entry.result);
    }

    // Check for expired absences and post return messages
    await handleExpiredAbsences(guild);

    void logRuntimeEvent('info', 'service.weeklyRecalculations.completed', 'Weekly recalculation completed successfully', {
      guildId,
      processedCount: results.length,
      weekStart
    });
    
    return results;

  } catch (error) {
    console.error('Weekly recalculation failed:', error);
    throw error;
  }
}

/**
 * Handle expired absences and post return messages
 */
async function handleExpiredAbsences(guild) {
  const guildId = resolveGuildId(guild);
  try {
    const expiredAbsences = await db.all(
      'SELECT * FROM absences WHERE guild_id = ? AND active = 1 AND end_date < date("now")',
      guildId
    );

    for (const absence of expiredAbsences) {
      // Mark as inactive
      await db.run('UPDATE absences SET active = 0 WHERE guild_id = ? AND id = ?', guildId, absence.id);

      // Get staff member
      const staffMember = await guild.members.fetch(absence.recruiter_id).catch(() => null);
      if (staffMember) {
        // Post return message to invites channel
        const embed = new EmbedBuilder()
          .setTitle('🎉 Return from Absence')
          .setDescription(`**${staffMember.user.tag}** has returned from absence and is now active for recruiting.`)
          .addFields(
            { name: 'Absence Period', value: `${absence.start_date} to ${absence.end_date}`, inline: true },
            { name: 'Status', value: 'Requirements reactivated', inline: true }
          )
          .setColor(0x51CF66)
          .setTimestamp();

        const invitesChannel = guild.channels.cache.get(CHANNELS.INVITES_OVERALL);
        if (invitesChannel) {
          await invitesChannel.send({ embeds: [embed] }).catch(err => {
            console.error('Failed to post absence return to invites channel:', err);
          });
        }

        // DM the staff member
        const dmEmbed = new EmbedBuilder()
          .setTitle('✅ Absence Ended')
          .setDescription('Your absence period has ended. Recruiting requirements are now reactivated.')
          .addFields(
            { name: 'End Date', value: absence.end_date, inline: true },
            { name: 'Next Action', value: 'Check your new requirements with /recruiter info', inline: true }
          )
          .setColor(0x51CF66)
          .setTimestamp();

        await staffMember.send({ embeds: [dmEmbed] }).catch(err => {
          console.error('Failed to DM absence return:', err);
        });
      }
    }

    if (expiredAbsences.length > 0) {
      console.log(`Processed ${expiredAbsences.length} expired absences`);
    }

  } catch (error) {
    console.error('Error handling expired absences:', error);
  }
}

module.exports = {
  performWeeklyRecalculations,
  handleExpiredAbsences
};

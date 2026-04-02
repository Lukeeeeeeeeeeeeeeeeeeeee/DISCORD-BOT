/**
 * DM Campaign Service - Control Plane
 *
 * Creates campaigns and target rows in the DB queue. The main bot calls this;
 * worker bots poll the queue and actually send DMs.
 */
'use strict';

const crypto = require('crypto');
const db = require('../../db_async');
const { envBool, envInt } = require('../../lib/env-utils');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');
const { withTransaction } = require('../../lib/transactions');
const { pickWorker } = require('./dm-worker-selector');

const DEFAULT_INSERT_BATCH_SIZE = 25;
const HARD_MAX_TARGETS = 50000;
const ASSIGNMENT_QUERY_CHUNK_SIZE = 400;
const DEFAULT_STICKY_WINDOW_HOURS = 24;
const DEFAULT_MAX_MISC_STREAK = 4;

const VALID_MESSAGE_TYPES = new Set(['misc', 'war_early', 'war_late', 'system_welcome', 'system_quota']);
const VALID_TARGET_MODES = new Set(['everyone', 'any_roles', 'all_roles', 'direct']);

function nowMs() {
    return Date.now();
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) {
        chunks.push(arr.slice(i, i + size));
    }
    return chunks;
}

function inClausePlaceholders(count) {
    return Array.from({ length: count }, () => '?').join(', ');
}

function getBatchingConfig() {
    const modeRaw = (process.env.DM_BATCH_STRATEGY || 'workers').toLowerCase();
    const mode = (modeRaw === 'fixed' || modeRaw === 'workers') ? modeRaw : 'workers';
    const fixedBatchSize = envInt('DM_INSERT_BATCH_SIZE', DEFAULT_INSERT_BATCH_SIZE, 1, 500);
    const batchesPerWorker = envInt('DM_BATCHES_PER_WORKER', 6, 1, 1000);
    const minBatchSize = envInt('DM_MIN_INSERT_BATCH_SIZE', 1, 1, 500);
    const maxBatchSize = envInt('DM_MAX_INSERT_BATCH_SIZE', 100, 1, 1000);
    return {
        mode,
        fixedBatchSize,
        batchesPerWorker,
        minBatchSize: Math.min(minBatchSize, maxBatchSize),
        maxBatchSize: Math.max(maxBatchSize, minBatchSize)
    };
}

async function getEnabledWorkerCount() {
    try {
        const row = await db.get('SELECT COUNT(*) AS worker_count FROM dm_workers WHERE enabled = 1');
        const count = Number(row && row.worker_count);
        return Number.isFinite(count) && count > 0 ? count : 1;
    } catch (err) {
        void logUnexpectedError('dm.campaign.workerCount', err);
        return 1;
    }
}

function hashMessage(message) {
    return crypto.createHash('sha256').update(String(message || '').trim()).digest('hex').slice(0, 24);
}

async function computeInsertBatchSize(totalTargets) {
    const cfg = getBatchingConfig();
    if (cfg.mode === 'fixed') return cfg.fixedBatchSize;

    const workerCount = await getEnabledWorkerCount();
    const desiredBatches = Math.max(1, workerCount * cfg.batchesPerWorker);
    const dynamicSize = Math.ceil(totalTargets / desiredBatches);
    return clamp(dynamicSize, cfg.minBatchSize, cfg.maxBatchSize);
}

async function loadEligibleWorkers(dbHandle) {
    const staleMs = envInt('DM_ASSIGNMENT_STALE_MS', 45000, 5000, 300000);
    const cutoff = nowMs() - staleMs;
    return dbHandle.all(
        `SELECT worker_id, display_name, weight, last_seen_at, status
         FROM dm_workers
         WHERE enabled = 1 AND status = 'online' AND last_seen_at >= ?
         ORDER BY worker_id ASC`,
        cutoff
    );
}

async function loadAffinityState(dbHandle, guildId, userIds) {
    const affinityByUserId = new Map();
    const blockedByUserId = new Map();

    for (const chunk of chunkArray(userIds, ASSIGNMENT_QUERY_CHUNK_SIZE)) {
        if (chunk.length === 0) continue;
        const placeholders = inClausePlaceholders(chunk.length);

        const affinityRows = await dbHandle.all(
            `SELECT *
             FROM dm_user_affinity
             WHERE guild_id = ?
               AND user_id IN (${placeholders})`,
            guildId,
            ...chunk
        );
        for (const row of affinityRows) {
            affinityByUserId.set(String(row.user_id), row);
        }

        const blockRows = await dbHandle.all(
            `SELECT user_id, worker_id
             FROM dm_worker_user_blocks
             WHERE guild_id = ?
               AND user_id IN (${placeholders})`,
            guildId,
            ...chunk
        );
        for (const row of blockRows) {
            const key = String(row.user_id);
            const blocked = blockedByUserId.get(key) || new Set();
            blocked.add(String(row.worker_id));
            blockedByUserId.set(key, blocked);
        }
    }

    return { affinityByUserId, blockedByUserId };
}

async function buildTargetAssignments(dbHandle, { guildId, userIds, messageType }) {
    if (!envBool('DM_PREASSIGN_TARGETS', true) || !Array.isArray(userIds) || userIds.length === 0) {
        return {
            assignedWorkerByUserId: new Map(),
            workerAssignmentCounts: {},
            assignedCount: 0,
            unassignedCount: userIds.length
        };
    }

    const eligibleWorkers = await loadEligibleWorkers(dbHandle);
    if (!eligibleWorkers || eligibleWorkers.length === 0) {
        return {
            assignedWorkerByUserId: new Map(),
            workerAssignmentCounts: {},
            assignedCount: 0,
            unassignedCount: userIds.length
        };
    }

    const { affinityByUserId, blockedByUserId } = await loadAffinityState(dbHandle, guildId, userIds);
    const stickyWindowMs = DEFAULT_STICKY_WINDOW_HOURS * 60 * 60 * 1000;
    const assignedWorkerByUserId = new Map();
    const workerAssignmentCounts = {};
    const now = nowMs();

    for (const userId of userIds) {
        const selectedWorkerId = pickWorker({
            messageType,
            affinity: affinityByUserId.get(userId) || null,
            eligibleWorkers,
            blockedWorkerIds: blockedByUserId.get(userId) || new Set(),
            stickyWindowMs,
            maxMiscStreak: DEFAULT_MAX_MISC_STREAK
        }, now);

        if (!selectedWorkerId) continue;
        assignedWorkerByUserId.set(userId, selectedWorkerId);
        workerAssignmentCounts[selectedWorkerId] = (workerAssignmentCounts[selectedWorkerId] || 0) + 1;
    }

    return {
        assignedWorkerByUserId,
        workerAssignmentCounts,
        assignedCount: assignedWorkerByUserId.size,
        unassignedCount: Math.max(0, userIds.length - assignedWorkerByUserId.size)
    };
}

async function buildCampaignTargetPlan(dbHandle, { guildId, messageHash, uniqueIds, isSystemMessage, threshold }) {
    let finalIds = uniqueIds;
    let excludedCount = 0;

    if (!isSystemMessage) {
        const activeDuplicate = await dbHandle.get(
            `SELECT id FROM dm_campaigns
             WHERE guild_id = ? AND message_hash = ? AND status IN ('queued', 'running')`,
            guildId,
            messageHash
        );
        if (activeDuplicate) {
            throw new Error(`An active campaign (ID: ${activeDuplicate.id}) already exists with this exact message in this server. Wait for it to finish or cancel it.`);
        }

        const alreadySentRows = await dbHandle.all(
            `SELECT DISTINCT user_id FROM dm_campaign_targets
             WHERE status IN ('sent', 'pending', 'claimed', 'sending', 'retry_wait')
             AND created_at > ?
             AND campaign_id IN (SELECT id FROM dm_campaigns WHERE message_hash = ? AND guild_id = ?)`,
            threshold,
            messageHash,
            guildId
        );
        const alreadySentSet = new Set(alreadySentRows.map((row) => String(row.user_id)));
        finalIds = uniqueIds.filter((id) => !alreadySentSet.has(id));
        excludedCount = uniqueIds.length - finalIds.length;
    }

    return { finalIds, excludedCount };
}

/**
 * Resolve target member IDs from guild based on target mode and role IDs.
 * Returns an array of unique user-ID strings with bots filtered out.
 */
async function resolveTargetMemberIds(guild, { targetMode, roleIds, directUserIds = [] }) {
    if (targetMode === 'direct') {
        return Array.isArray(directUserIds) ? directUserIds.map(String) : [];
    }

    let membersCol;
    try {
        membersCol = await guild.members.fetch();
    } catch (_err) {
        void logRuntimeEvent(
            'warn',
            'dm.resolveMembers.cacheFallback',
            'Failed to fetch guild members; falling back to local cache (may be stale).',
            { guildId: guild.id }
        );
        membersCol = guild.members.cache;
    }

    if (targetMode === 'everyone') {
        return Array.from(membersCol.filter((member) => !member.user.bot).values()).map((member) => member.id);
    }

    if (!Array.isArray(roleIds) || roleIds.length === 0) return [];
    const roleSet = new Set(roleIds.map(String));

    if (targetMode === 'all_roles') {
        return Array.from(
            membersCol
                .filter((member) => !member.user.bot && roleIds.every((roleId) => member.roles.cache.has(roleId)))
                .values()
        ).map((member) => member.id);
    }

    return Array.from(
        membersCol
            .filter((member) => !member.user.bot && member.roles.cache.some((role) => roleSet.has(role.id)))
            .values()
    ).map((member) => member.id);
}

/**
 * Create a new DM campaign and insert all target rows.
 */
async function createCampaign({
    guild,
    requestedBy,
    messageType,
    messageBody,
    targetMode,
    roleIds = [],
    directUserIds = [],
    reportChannelId = null,
    requestedChannelId = null,
    preview = false
} = {}) {
    if (!guild) throw new Error('guild is required');
    if (!requestedBy) throw new Error('requestedBy is required');
    if (!VALID_MESSAGE_TYPES.has(messageType)) {
        throw new Error(`Invalid message_type "${messageType}". Must be one of: ${[...VALID_MESSAGE_TYPES].join(', ')}`);
    }
    if (!messageBody || typeof messageBody !== 'string') throw new Error('messageBody is required');
    if (messageBody.length > 3000) throw new Error('messageBody must be <= 3000 characters');
    if (!VALID_TARGET_MODES.has(targetMode)) {
        throw new Error(`Invalid target_mode "${targetMode}". Must be one of: ${[...VALID_TARGET_MODES].join(', ')}`);
    }
    if (targetMode !== 'everyone' && targetMode !== 'direct' && (!Array.isArray(roleIds) || roleIds.length === 0)) {
        throw new Error('At least one roleId required when target_mode is not "everyone" or "direct".');
    }
    if (targetMode === 'direct' && (!Array.isArray(directUserIds) || directUserIds.length === 0)) {
        throw new Error('directUserIds required when target_mode is "direct".');
    }

    const memberIds = await resolveTargetMemberIds(guild, { targetMode, roleIds, directUserIds });
    const uniqueIds = [...new Set(memberIds.map(String))];
    if (uniqueIds.length === 0) {
        return { campaignId: null, totalTargets: 0, totalBatches: 0, preview };
    }
    if (uniqueIds.length > HARD_MAX_TARGETS) {
        throw new Error(`Total resolved targets ${uniqueIds.length} exceeds the hard safety limit of ${HARD_MAX_TARGETS}. Refine your filters.`);
    }

    const messageHash = hashMessage(messageBody);
    const threshold = nowMs() - (14 * 24 * 60 * 60 * 1000);
    const isSystemMessage = messageType === 'system_welcome' || messageType === 'system_quota';

    if (preview) {
        const { finalIds, excludedCount } = await buildCampaignTargetPlan(db, {
            guildId: guild.id,
            messageHash,
            uniqueIds,
            isSystemMessage,
            threshold
        });
        if (finalIds.length === 0) {
            return {
                campaignId: null,
                totalTargets: 0,
                totalBatches: 0,
                preview: true,
                excludedByDedupe: excludedCount
            };
        }

        const insertBatchSize = await computeInsertBatchSize(finalIds.length);
        const totalBatches = Math.ceil(finalIds.length / insertBatchSize);
        return {
            campaignId: null,
            totalTargets: finalIds.length,
            totalBatches,
            preview: true,
            sampleUserIds: finalIds.slice(0, 10),
            excludedByDedupe: excludedCount
        };
    }

    const now = nowMs();
    const writeResult = await withTransaction(db, async (tx) => {
        const { finalIds, excludedCount } = await buildCampaignTargetPlan(tx, {
            guildId: guild.id,
            messageHash,
            uniqueIds,
            isSystemMessage,
            threshold
        });
        if (finalIds.length === 0) {
            return {
                inserted: false,
                campaignId: null,
                totalTargets: 0,
                totalBatches: 0,
                excludedByDedupe: excludedCount
            };
        }

        const insertBatchSize = await computeInsertBatchSize(finalIds.length);
        const totalBatches = Math.ceil(finalIds.length / insertBatchSize);
        const assignmentPlan = await buildTargetAssignments(tx, {
            guildId: guild.id,
            userIds: finalIds,
            messageType
        });
        const campaignResult = await tx.run(
            `INSERT INTO dm_campaigns
           (guild_id, requested_by, message_type, message_body, message_hash, target_mode, target_role_ids,
            status, report_channel_id, requested_channel_id,
            total_targets, total_batches, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
            guild.id,
            requestedBy,
            messageType,
            messageBody,
            messageHash,
            targetMode,
            JSON.stringify(roleIds),
            reportChannelId,
            requestedChannelId,
            finalIds.length,
            totalBatches,
            now,
            now
        );

        const campaignId = campaignResult.lastID;
        const batches = chunkArray(finalIds, insertBatchSize);
        for (let batchNo = 0; batchNo < batches.length; batchNo++) {
            const batch = batches[batchNo];
            const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?, ?)').join(', ');
            const params = [];
            for (const userId of batch) {
                params.push(
                    campaignId,
                    guild.id,
                    userId,
                    assignmentPlan.assignedWorkerByUserId.get(userId) || null,
                    batchNo + 1,
                    now,
                    now
                );
            }
            await tx.run(
                `INSERT OR IGNORE INTO dm_campaign_targets
                 (campaign_id, guild_id, user_id, assigned_worker_id, batch_no, created_at, updated_at)
                 VALUES ${placeholders}`,
                ...params
            );
        }

        return {
            inserted: true,
            campaignId,
            totalTargets: finalIds.length,
            totalBatches,
            excludedByDedupe: excludedCount,
            insertBatchSize,
            preassignedTargets: assignmentPlan.assignedCount,
            unassignedTargets: assignmentPlan.unassignedCount,
            workerAssignmentCounts: assignmentPlan.workerAssignmentCounts
        };
    }, { immediate: true });

    if (!writeResult.inserted) {
        return {
            campaignId: null,
            totalTargets: 0,
            totalBatches: 0,
            preview: false,
            excludedByDedupe: writeResult.excludedByDedupe
        };
    }

    void logRuntimeEvent('info', 'dm.campaign.created', 'DM campaign created', {
        campaignId: writeResult.campaignId,
        guildId: guild.id,
        requestedBy,
        messageType,
        targetMode,
        totalTargets: writeResult.totalTargets,
        totalResolvedTargets: uniqueIds.length,
        totalBatches: writeResult.totalBatches,
        insertBatchSize: writeResult.insertBatchSize,
        preassignedTargets: writeResult.preassignedTargets,
        unassignedTargets: writeResult.unassignedTargets,
        workerAssignmentCounts: writeResult.workerAssignmentCounts
    });

    return {
        campaignId: writeResult.campaignId,
        totalTargets: writeResult.totalTargets,
        totalBatches: writeResult.totalBatches,
        preview: false,
        excludedByDedupe: writeResult.excludedByDedupe,
        preassignedTargets: writeResult.preassignedTargets,
        unassignedTargets: writeResult.unassignedTargets,
        workerAssignmentCounts: writeResult.workerAssignmentCounts
    };
}

/**
 * Get live campaign status with per-status counts.
 */
async function getCampaignStatus(campaignId) {
    const campaign = await db.get('SELECT * FROM dm_campaigns WHERE id = ?', campaignId);
    if (!campaign) return null;

    const statusCounts = await db.all(
        `SELECT status, COUNT(*) as count
         FROM dm_campaign_targets
         WHERE campaign_id = ?
         GROUP BY status`,
        campaignId
    );

    const workerCounts = await db.all(
        `SELECT assigned_worker_id, status, COUNT(*) as count
         FROM dm_campaign_targets
         WHERE campaign_id = ? AND assigned_worker_id IS NOT NULL
         GROUP BY assigned_worker_id, status`,
        campaignId
    );

    return {
        campaign,
        statusCounts: statusCounts.reduce((acc, row) => {
            acc[row.status] = row.count;
            return acc;
        }, {}),
        workerCounts
    };
}

/**
 * Cancel a campaign and mark queued work as cancelled.
 */
async function cancelCampaign(campaignId) {
    const now = nowMs();
    const result = await db.run(
        `UPDATE dm_campaign_targets
         SET status = 'cancelled',
             assigned_worker_id = NULL,
             claim_id = NULL,
             claim_expires_at = NULL,
             next_attempt_at = NULL,
             updated_at = ?
         WHERE campaign_id = ? AND status IN ('pending', 'claimed', 'retry_wait')`,
        now,
        campaignId
    );

    await db.run(
        `UPDATE dm_campaigns
         SET status = 'cancelled', updated_at = ?, finished_at = ?
         WHERE id = ? AND status NOT IN ('completed', 'completed_with_errors', 'failed')`,
        now,
        now,
        campaignId
    );

    void logRuntimeEvent('info', 'dm.campaign.cancelled', 'DM campaign cancelled', {
        campaignId,
        cancelledTargets: result.changes || 0
    });

    return { cancelledTargets: result.changes || 0 };
}

/**
 * Build report data for a completed campaign.
 */
async function getReport(campaignId) {
    const campaign = await db.get('SELECT * FROM dm_campaigns WHERE id = ?', campaignId);
    if (!campaign) return null;

    const statusCounts = await db.all(
        `SELECT status, COUNT(*) as count
         FROM dm_campaign_targets
         WHERE campaign_id = ?
         GROUP BY status`,
        campaignId
    );

    const workerBreakdown = await db.all(
        `SELECT
           da.worker_id,
           da.result,
           COUNT(*) as count
         FROM dm_delivery_attempts da
         WHERE da.campaign_id = ?
         GROUP BY da.worker_id, da.result`,
        campaignId
    );

    const blockedUsers = await db.all(
        `SELECT user_id, blocked_by_worker_id, NULL as assigned_worker_id, last_error_code, last_error_message
         FROM dm_campaign_targets
         WHERE campaign_id = ? AND status = 'blocked'`,
        campaignId
    );

    const undeliverableUsers = await db.all(
        `SELECT user_id, NULL as assigned_worker_id, last_error_code, last_error_message
         FROM dm_campaign_targets
         WHERE campaign_id = ? AND status = 'undeliverable'`,
        campaignId
    );

    const failedUsers = await db.all(
        `SELECT user_id, assigned_worker_id, last_error_code, last_error_message
         FROM dm_campaign_targets
         WHERE campaign_id = ? AND status = 'failed'`,
        campaignId
    );

    const sentUsers = await db.all(
        `SELECT user_id, assigned_worker_id, NULL as last_error_code, NULL as last_error_message
         FROM dm_campaign_targets
         WHERE campaign_id = ? AND status = 'sent'`,
        campaignId
    );

    return {
        campaign,
        statusCounts: statusCounts.reduce((acc, row) => {
            acc[row.status] = row.count;
            return acc;
        }, {}),
        workerBreakdown,
        blockedUsers,
        undeliverableUsers,
        failedUsers,
        sentUsers
    };
}

async function markReportPosted(campaignId) {
    const now = nowMs();
    await db.run(
        'UPDATE dm_campaigns SET report_posted = 1, report_posted_at = ?, updated_at = ? WHERE id = ?',
        now,
        now,
        campaignId
    );
}

async function incrementReportAttempts(campaignId) {
    await db.run(
        'UPDATE dm_campaigns SET report_attempts = report_attempts + 1, updated_at = ? WHERE id = ?',
        Date.now(),
        campaignId
    );
}

async function getUnreportedCampaigns() {
    return db.all(
        `SELECT * FROM dm_campaigns
         WHERE status IN ('completed', 'completed_with_errors')
           AND report_posted = 0
         ORDER BY finished_at ASC`
    );
}

async function getRunningCampaigns() {
    return db.all('SELECT * FROM dm_campaigns WHERE status = \'running\'');
}

async function updateCampaignNotificationThreshold(campaignId, percentage) {
    await db.run(
        'UPDATE dm_campaigns SET last_notified_percentage = ?, updated_at = ? WHERE id = ?',
        percentage,
        Date.now(),
        campaignId
    );
}

async function listWorkers() {
    return db.all('SELECT * FROM dm_workers ORDER BY display_name ASC, worker_id ASC');
}

async function setWorkerEnabled(workerId, enabled) {
    const now = nowMs();
    await db.run(
        'UPDATE dm_workers SET enabled = ?, last_seen_at = ? WHERE worker_id = ?',
        enabled ? 1 : 0,
        now,
        workerId
    );
}

async function unblockUserForWorker(guildId, userId, workerId) {
    await db.run(
        'DELETE FROM dm_worker_user_blocks WHERE guild_id = ? AND user_id = ? AND worker_id = ?',
        guildId,
        userId,
        workerId
    );
}

async function unblockUserForAllWorkers(guildId, userId) {
    await db.run(
        'DELETE FROM dm_worker_user_blocks WHERE guild_id = ? AND user_id = ?',
        guildId,
        userId
    );
}

module.exports = {
    createCampaign,
    getCampaignStatus,
    cancelCampaign,
    getReport,
    markReportPosted,
    incrementReportAttempts,
    getUnreportedCampaigns,
    getRunningCampaigns,
    updateCampaignNotificationThreshold,
    listWorkers,
    setWorkerEnabled,
    unblockUserForWorker,
    unblockUserForAllWorkers,
    resolveTargetMemberIds,
    computeInsertBatchSize
};

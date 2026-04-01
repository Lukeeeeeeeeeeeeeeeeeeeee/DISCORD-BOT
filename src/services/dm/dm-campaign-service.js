/**
 * DM Campaign Service — Control Plane
 *
 * Creates campaigns + targets in the DB queue.  The main bot calls this;
 * worker bots poll the queue and actually send DMs.
 */
'use strict';

const db = require('../../db_async');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');

// ── Tunables ────────────────────────────────────────────────────────────────
const DEFAULT_INSERT_BATCH_SIZE = 25; // rows per INSERT batch
const HARD_MAX_TARGETS = 50000;

const VALID_MESSAGE_TYPES = new Set(['misc', 'war_early', 'war_late']);
const VALID_TARGET_MODES = new Set(['everyone', 'any_roles', 'all_roles']);
const VALID_CAMPAIGN_STATUSES = new Set(['queued', 'running', 'completed', 'completed_with_errors', 'cancelled', 'failed']);

// ── Helpers ─────────────────────────────────────────────────────────────────
function nowMs() { return Date.now(); }

function envInt(key, fallback, min = 1, max = Number.MAX_SAFE_INTEGER) {
    const parsed = Number.parseInt(process.env[key], 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(max, Math.max(min, parsed));
}

function clamp(value, min, max) {
    return Math.min(max, Math.max(min, value));
}

function chunkArray(arr, size) {
    const chunks = [];
    for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
    return chunks;
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

async function computeInsertBatchSize(totalTargets) {
    const cfg = getBatchingConfig();
    if (cfg.mode === 'fixed') return cfg.fixedBatchSize;

    const workerCount = await getEnabledWorkerCount();
    const desiredBatches = Math.max(1, workerCount * cfg.batchesPerWorker);
    const dynamicSize = Math.ceil(totalTargets / desiredBatches);
    return clamp(dynamicSize, cfg.minBatchSize, cfg.maxBatchSize);
}

/**
 * Resolve target member IDs from guild based on target mode and role IDs.
 * Returns an array of unique user-ID strings (no bots).
 */
async function resolveTargetMemberIds(guild, { targetMode, roleIds }) {
    let membersCol;
    try {
        membersCol = await guild.members.fetch();
    } catch (_err) {
        membersCol = guild.members.cache;
    }

    if (targetMode === 'everyone') {
        return Array.from(membersCol.filter(m => !m.user.bot).values()).map(m => m.id);
    }

    if (!Array.isArray(roleIds) || roleIds.length === 0) return [];
    const roleSet = new Set(roleIds.map(String));

    if (targetMode === 'all_roles') {
        // Intersection: member must have ALL specified roles
        return Array.from(
            membersCol.filter(m => !m.user.bot && roleIds.every(rid => m.roles.cache.has(rid))).values()
        ).map(m => m.id);
    }

    // Default: any_roles — union of members who have at least one role
    return Array.from(
        membersCol.filter(m => !m.user.bot && m.roles.cache.some(r => roleSet.has(r.id))).values()
    ).map(m => m.id);
}

// ── Campaign CRUD ───────────────────────────────────────────────────────────

/**
 * Create a new DM campaign and insert all target rows.
 *
 * @param {object} opts
 * @param {object} opts.guild           Discord guild object (must support members.fetch)
 * @param {string} opts.requestedBy     User ID of requester
 * @param {string} opts.messageType     'misc' | 'war_early' | 'war_late'
 * @param {string} opts.messageBody     Message text (≤ 2000 chars)
 * @param {string} opts.targetMode      'everyone' | 'any_roles' | 'all_roles'
 * @param {string[]} opts.roleIds       Role IDs (ignored if targetMode='everyone')
 * @param {string} [opts.reportChannelId]
 * @param {string} [opts.requestedChannelId]
 * @param {boolean} [opts.preview=false]  If true, return stats without writing.
 * @returns {{ campaignId, totalTargets, totalBatches, preview, targets? }}
 */
async function createCampaign({
    guild,
    requestedBy,
    messageType,
    messageBody,
    targetMode,
    roleIds = [],
    reportChannelId = null,
    requestedChannelId = null,
    preview = false
} = {}) {
    // ── validation ──
    if (!guild) throw new Error('guild is required');
    if (!requestedBy) throw new Error('requestedBy is required');
    if (!VALID_MESSAGE_TYPES.has(messageType)) {
        throw new Error(`Invalid message_type "${messageType}". Must be one of: ${[...VALID_MESSAGE_TYPES].join(', ')}`);
    }
    if (!messageBody || typeof messageBody !== 'string') throw new Error('messageBody is required');
    if (messageBody.length > 2000) throw new Error('messageBody must be ≤ 2000 characters');
    if (!VALID_TARGET_MODES.has(targetMode)) {
        throw new Error(`Invalid target_mode "${targetMode}". Must be one of: ${[...VALID_TARGET_MODES].join(', ')}`);
    }
    if (targetMode !== 'everyone' && (!Array.isArray(roleIds) || roleIds.length === 0)) {
        throw new Error('At least one roleId required when target_mode is not "everyone".');
    }

    // ── resolve targets ──
    const memberIds = await resolveTargetMemberIds(guild, { targetMode, roleIds });
    // Dedupe (should already be unique, but belt-and-suspenders)
    const uniqueIds = [...new Set(memberIds.map(String))];

    if (uniqueIds.length === 0) {
        return { campaignId: null, totalTargets: 0, totalBatches: 0, preview };
    }
    if (uniqueIds.length > HARD_MAX_TARGETS) {
        throw new Error(`Target count ${uniqueIds.length} exceeds hard max ${HARD_MAX_TARGETS}. Narrow your target or raise limit.`);
    }

    const insertBatchSize = await computeInsertBatchSize(uniqueIds.length);
    const totalBatches = Math.ceil(uniqueIds.length / insertBatchSize);

    if (preview) {
        const sample = uniqueIds.slice(0, 10);
        return {
            campaignId: null,
            totalTargets: uniqueIds.length,
            totalBatches,
            preview: true,
            sampleUserIds: sample
        };
    }

    // ── write campaign row ──
    const now = nowMs();
    const campaignResult = await db.run(
        `INSERT INTO dm_campaigns
       (guild_id, requested_by, message_type, message_body, target_mode, target_role_ids,
        status, report_channel_id, requested_channel_id,
        total_targets, total_batches, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?, ?, ?, ?, ?)`,
        guild.id,
        requestedBy,
        messageType,
        messageBody,
        targetMode,
        JSON.stringify(roleIds),
        reportChannelId,
        requestedChannelId,
        uniqueIds.length,
        totalBatches,
        now,
        now
    );

    const campaignId = campaignResult.lastID;

    // ── insert target rows in batches ──
    const batches = chunkArray(uniqueIds, insertBatchSize);
    for (let batchNo = 0; batchNo < batches.length; batchNo++) {
        const batch = batches[batchNo];
        const placeholders = batch.map(() => '(?, ?, ?, ?, ?, ?)').join(', ');
        const params = [];
        for (const userId of batch) {
            params.push(campaignId, guild.id, userId, batchNo + 1, now, now);
        }
        await db.run(
            `INSERT OR IGNORE INTO dm_campaign_targets
         (campaign_id, guild_id, user_id, batch_no, created_at, updated_at)
       VALUES ${placeholders}`,
            ...params
        );
    }

    void logRuntimeEvent('info', 'dm.campaign.created', 'DM campaign created', {
        campaignId,
        guildId: guild.id,
        requestedBy,
        messageType,
        targetMode,
        totalTargets: uniqueIds.length,
        totalBatches,
        insertBatchSize
    });

    return { campaignId, totalTargets: uniqueIds.length, totalBatches, preview: false };
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
        statusCounts: statusCounts.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {}),
        workerCounts
    };
}

/**
 * Cancel a campaign — mark all pending/claimed targets as cancelled.
 */
async function cancelCampaign(campaignId) {
    const now = nowMs();
    const result = await db.run(
        `UPDATE dm_campaign_targets
     SET status = 'cancelled', updated_at = ?
     WHERE campaign_id = ? AND status IN ('pending', 'claimed')`,
        now, campaignId
    );

    await db.run(
        `UPDATE dm_campaigns
     SET status = 'cancelled', updated_at = ?, finished_at = ?
     WHERE id = ? AND status NOT IN ('completed', 'completed_with_errors', 'failed')`,
        now, now, campaignId
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
        `SELECT t.user_id, t.blocked_by_worker_id, t.last_error_code, t.last_error_message
     FROM dm_campaign_targets t
     WHERE t.campaign_id = ? AND t.status = 'blocked'`,
        campaignId
    );

    const undeliverableUsers = await db.all(
        `SELECT t.user_id, t.last_error_code, t.last_error_message
     FROM dm_campaign_targets t
     WHERE t.campaign_id = ? AND t.status = 'undeliverable'`,
        campaignId
    );

    const failedUsers = await db.all(
        `SELECT t.user_id, t.assigned_worker_id, t.last_error_code, t.last_error_message
     FROM dm_campaign_targets t
     WHERE t.campaign_id = ? AND t.status = 'failed'`,
        campaignId
    );

    const sentUsers = await db.all(
        `SELECT t.user_id, t.assigned_worker_id
     FROM dm_campaign_targets t
     WHERE t.campaign_id = ? AND t.status = 'sent'`,
        campaignId
    );

    return {
        campaign,
        statusCounts: statusCounts.reduce((acc, r) => { acc[r.status] = r.count; return acc; }, {}),
        workerBreakdown,
        blockedUsers,
        undeliverableUsers,
        failedUsers,
        sentUsers
    };
}

/**
 * Mark a campaign's report as posted.
 */
async function markReportPosted(campaignId) {
    const now = nowMs();
    await db.run(
        `UPDATE dm_campaigns SET report_posted = 1, report_posted_at = ?, updated_at = ? WHERE id = ?`,
        now, now, campaignId
    );
}

/**
 * Find campaigns that are done but report not yet posted.
 */
async function getUnreportedCampaigns() {
    return db.all(
        `SELECT * FROM dm_campaigns
     WHERE status IN ('completed', 'completed_with_errors')
       AND report_posted = 0
     ORDER BY finished_at ASC`
    );
}

/**
 * List/manage workers.
 */
async function listWorkers() {
    return db.all('SELECT * FROM dm_workers ORDER BY display_name ASC, worker_id ASC');
}

async function setWorkerEnabled(workerId, enabled) {
    const now = nowMs();
    await db.run(
        `UPDATE dm_workers SET enabled = ?, last_seen_at = ? WHERE worker_id = ?`,
        enabled ? 1 : 0, now, workerId
    );
}

async function unblockUserForWorker(guildId, userId, workerId) {
    await db.run(
        `DELETE FROM dm_worker_user_blocks WHERE guild_id = ? AND user_id = ? AND worker_id = ?`,
        guildId, userId, workerId
    );
}

async function unblockUserForAllWorkers(guildId, userId) {
    await db.run(
        `DELETE FROM dm_worker_user_blocks WHERE guild_id = ? AND user_id = ?`,
        guildId, userId
    );
}

module.exports = {
    createCampaign,
    getCampaignStatus,
    cancelCampaign,
    getReport,
    markReportPosted,
    getUnreportedCampaigns,
    listWorkers,
    setWorkerEnabled,
    unblockUserForWorker,
    unblockUserForAllWorkers,
    // Exposed for testing
    resolveTargetMemberIds,
    computeInsertBatchSize,
    VALID_MESSAGE_TYPES,
    VALID_TARGET_MODES,
    HARD_MAX_TARGETS
};

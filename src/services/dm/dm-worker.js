/**
 * DM Worker Runtime — Data Plane
 *
 * Each worker bot runs this module to poll the DB queue, claim targets,
 * send DMs, and record results.  Started with BOT_RUNTIME_MODE=dm_worker.
 */
'use strict';

const db = require('../../db_async');
const { pickWorker, classifyDmError, getRetryAfterMs } = require('./dm-worker-selector');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');

// ── Tunables (env) ──────────────────────────────────────────────────────────
function envInt(key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const v = Number.parseInt(process.env[key], 10);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

const POLL_MS = envInt('DM_QUEUE_POLL_MS', 1500, 500, 30000);
const CLAIM_BATCH = envInt('DM_CLAIM_BATCH_SIZE', 1, 1, 100);
const SEND_DELAY_MS = envInt('DM_MIN_DELAY_MS', 500, 100, 5000);
const RETRY_LIMIT = envInt('DM_RETRY_LIMIT', 2, 0, 5);
const HEARTBEAT_MS = envInt('DM_HEARTBEAT_MS', 15000, 5000, 60000);
const CLAIM_LEASE_MS = envInt('DM_CLAIM_LEASE_MS', 60000, 10000, 300000);

// ── State ───────────────────────────────────────────────────────────────────
let _running = false;
let _pollTimer = null;
let _heartbeatTimer = null;

// ── Heartbeat ───────────────────────────────────────────────────────────────

async function heartbeat(workerId, displayName) {
    const now = Date.now();
    await db.run(
        `INSERT INTO dm_workers (worker_id, display_name, enabled, weight, started_at, last_seen_at, status)
     VALUES (?, ?, 1, 1, ?, ?, 'online')
     ON CONFLICT(worker_id) DO UPDATE SET
       last_seen_at = excluded.last_seen_at,
       status = 'online'`,
        workerId, displayName || workerId, now, now
    );
}

// ── Queue claim ─────────────────────────────────────────────────────────────

/**
 * Claim up to N pending targets from the queue in a single transaction.
 * Returns the array of claimed target rows.
 */
async function claimTargets(workerId, batchSize) {
    const now = Date.now();
    const leaseExpiry = now + CLAIM_LEASE_MS;

    // Revert stale claims first (claim expired without completion)
    await db.run(
        `UPDATE dm_campaign_targets
     SET status = 'pending', assigned_worker_id = NULL, updated_at = ?
     WHERE status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
        now, now
    );

    // Select claimable rows
    const rows = await db.all(
        `SELECT t.id, t.campaign_id, t.guild_id, t.user_id, t.batch_no, t.attempts, t.worker_switches,
            c.message_type, c.message_body, c.max_misc_streak, c.sticky_window_hours
     FROM dm_campaign_targets t
     JOIN dm_campaigns c ON c.id = t.campaign_id
     WHERE t.status = 'pending'
       AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ?)
       AND (t.claim_expires_at IS NULL OR t.claim_expires_at <= ?)
       AND (t.assigned_worker_id IS NULL OR t.assigned_worker_id = ?)
       AND c.status IN ('queued', 'running')
     ORDER BY t.batch_no ASC, t.id ASC
     LIMIT ?`,
        now, now, workerId, batchSize
    );

    if (rows.length === 0) return [];

    const ids = rows.map(r => r.id);
    const placeholders = ids.map(() => '?').join(', ');

    await db.run(
        `UPDATE dm_campaign_targets
     SET status = 'claimed',
         assigned_worker_id = ?,
         claim_expires_at = ?,
         updated_at = ?
     WHERE id IN (${placeholders}) AND status = 'pending'`,
        workerId, leaseExpiry, now, ...ids
    );

    // Mark campaigns as running if still queued
    const uniqueCampaigns = [...new Set(rows.map(r => r.campaign_id))];
    for (const cid of uniqueCampaigns) {
        await db.run(
            `UPDATE dm_campaigns SET status = 'running', started_at = COALESCE(started_at, ?), updated_at = ?
       WHERE id = ? AND status = 'queued'`,
            now, now, cid
        );
    }

    return rows;
}

// ── Send logic ──────────────────────────────────────────────────────────────

/**
 * Get the affinity row for a (guild, user) pair.
 */
async function getAffinity(guildId, userId) {
    return db.get(
        'SELECT * FROM dm_user_affinity WHERE guild_id = ? AND user_id = ?',
        guildId, userId
    );
}

/**
 * Get blocked workers for a (guild, user) pair.
 */
async function getBlockedWorkerIds(guildId, userId) {
    const rows = await db.all(
        'SELECT worker_id FROM dm_worker_user_blocks WHERE guild_id = ? AND user_id = ?',
        guildId, userId
    );
    return new Set(rows.map(r => r.worker_id));
}

/**
 * Get eligible (enabled, recent heartbeat) workers.
 */
async function getEligibleWorkers(staleMs = 60000) {
    const cutoff = Date.now() - staleMs;
    return db.all(
        `SELECT * FROM dm_workers WHERE enabled = 1 AND last_seen_at >= ?`,
        cutoff
    );
}

/**
 * Update affinity after a successful send.
 */
async function updateAffinity(guildId, userId, workerId, messageType) {
    const now = Date.now();
    const isWar = messageType === 'war_early' || messageType === 'war_late';

    const existing = await getAffinity(guildId, userId);

    if (!existing) {
        // Insert new
        await db.run(
            `INSERT INTO dm_user_affinity
         (guild_id, user_id, preferred_worker_id, preferred_worker_last_dm_at,
          consecutive_misc_count, war_worker_id, war_last_dm_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            guildId, userId,
            isWar ? null : workerId,
            isWar ? null : now,
            isWar ? 0 : 1,
            isWar ? workerId : null,
            isWar ? now : null,
            now
        );
        return;
    }

    if (isWar) {
        await db.run(
            `UPDATE dm_user_affinity
       SET war_worker_id = ?, war_last_dm_at = ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ?`,
            workerId, now, now, guildId, userId
        );
    } else {
        const sameWorker = existing.preferred_worker_id === workerId;
        const newStreak = sameWorker ? (existing.consecutive_misc_count || 0) + 1 : 1;
        await db.run(
            `UPDATE dm_user_affinity
       SET preferred_worker_id = ?, preferred_worker_last_dm_at = ?,
           consecutive_misc_count = ?, updated_at = ?
       WHERE guild_id = ? AND user_id = ?`,
            workerId, now, newStreak, now, guildId, userId
        );
    }
}

/**
 * Record a block for a (guild, user, worker) triple.
 */
async function recordBlock(guildId, userId, workerId, reason, errorCode) {
    const now = Date.now();
    await db.run(
        `INSERT INTO dm_worker_user_blocks
       (guild_id, user_id, worker_id, reason, error_code, blocked_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(guild_id, user_id, worker_id) DO UPDATE SET
       reason = excluded.reason,
       error_code = excluded.error_code,
       updated_at = excluded.updated_at`,
        guildId, userId, workerId, reason, errorCode, now, now
    );
}

/**
 * Record a delivery attempt.
 */
async function recordAttempt(campaignId, targetId, guildId, userId, workerId, attemptNo, result, errorCode, errorMessage) {
    await db.run(
        `INSERT INTO dm_delivery_attempts
       (campaign_id, target_id, guild_id, user_id, worker_id, attempt_no, result, error_code, error_message, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        campaignId, targetId, guildId, userId, workerId, attemptNo, result, errorCode, errorMessage, Date.now()
    );
}

/**
 * Update a target row status after processing.
 */
async function updateTargetStatus(targetId, status, updates = {}) {
    const now = Date.now();
    const sets = ['status = ?', 'updated_at = ?'];
    const params = [status, now];

    if (updates.lastErrorCode !== undefined) {
        sets.push('last_error_code = ?');
        params.push(updates.lastErrorCode);
    }
    if (updates.lastErrorMessage !== undefined) {
        sets.push('last_error_message = ?');
        params.push(updates.lastErrorMessage);
    }
    if (updates.attempts !== undefined) {
        sets.push('attempts = ?');
        params.push(updates.attempts);
    }
    if (updates.nextAttemptAt !== undefined) {
        sets.push('next_attempt_at = ?');
        params.push(updates.nextAttemptAt);
    }
    if (updates.assignedWorkerId !== undefined) {
        sets.push('assigned_worker_id = ?');
        params.push(updates.assignedWorkerId);
    }
    if (updates.claimExpiresAt !== undefined) {
        sets.push('claim_expires_at = ?');
        params.push(updates.claimExpiresAt);
    }
    if (updates.blockedByWorkerId !== undefined) {
        sets.push('blocked_by_worker_id = ?');
        params.push(updates.blockedByWorkerId);
    }
    if (updates.lastWorkerId !== undefined) {
        sets.push('last_worker_id = ?');
        params.push(updates.lastWorkerId);
    }
    if (updates.workerSwitches !== undefined) {
        sets.push('worker_switches = ?');
        params.push(updates.workerSwitches);
    }

    params.push(targetId);
    await db.run(`UPDATE dm_campaign_targets SET ${sets.join(', ')} WHERE id = ?`, ...params);
}

function toPositiveInt(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
    return parsed;
}

async function routeTargetToWorker(target, selfWorkerId) {
    const affinity = await getAffinity(target.guild_id, target.user_id);
    const blockedWorkerIds = await getBlockedWorkerIds(target.guild_id, target.user_id);
    const eligibleWorkers = await getEligibleWorkers();

    const stickyWindowHours = toPositiveInt(target.sticky_window_hours, 24);
    const maxMiscStreak = toPositiveInt(target.max_misc_streak, 4);

    const selectedWorkerId = pickWorker({
        messageType: target.message_type,
        affinity,
        eligibleWorkers,
        blockedWorkerIds,
        stickyWindowMs: stickyWindowHours * 60 * 60 * 1000,
        maxMiscStreak
    });

    if (!selectedWorkerId) {
        return { selectedWorkerId: null, action: 'undeliverable_no_worker' };
    }

    if (selectedWorkerId !== selfWorkerId) {
        const newSwitchCount = (Number(target.worker_switches) || 0) + 1;
        await updateTargetStatus(target.id, 'pending', {
            assignedWorkerId: selectedWorkerId,
            claimExpiresAt: null,
            lastWorkerId: selfWorkerId,
            workerSwitches: newSwitchCount
        });
        return { selectedWorkerId, action: 'reassigned' };
    }

    return { selectedWorkerId, action: 'send' };
}

/**
 * Process a single claimed target: select worker, send DM, record result.
 *
 * @param {object} target   Claimed target row + campaign info
 * @param {object} client   discord.js Client
 * @param {string} selfWorkerId  This worker's ID
 */
async function processTarget(target, client, selfWorkerId) {
    const { id: targetId, campaign_id, guild_id, user_id, message_type, message_body, attempts } = target;
    const attemptNo = (attempts || 0) + 1;

    const route = await routeTargetToWorker(target, selfWorkerId);
    if (route.action === 'reassigned') {
        return { ok: true, sent: false, reassignedTo: route.selectedWorkerId };
    }
    if (route.action === 'undeliverable_no_worker') {
        await updateTargetStatus(targetId, 'undeliverable', {
            claimExpiresAt: null,
            lastErrorCode: 'NO_ELIGIBLE_WORKER',
            lastErrorMessage: 'No eligible worker available for this target.'
        });
        await db.run(
            'UPDATE dm_campaigns SET total_undeliverable = total_undeliverable + 1, updated_at = ? WHERE id = ?',
            Date.now(),
            campaign_id
        );
        return { ok: false, sent: false, category: 'no_eligible_worker' };
    }

    try {
        // Fetch guild + member
        const guild = await client.guilds.fetch(guild_id);
        const member = await guild.members.fetch(user_id);

        // Send DM
        await member.send(message_body);

        // Success
        await recordAttempt(campaign_id, targetId, guild_id, user_id, selfWorkerId, attemptNo, 'sent', null, null);
        await updateTargetStatus(targetId, 'sent', {
            attempts: attemptNo,
            assignedWorkerId: selfWorkerId,
            claimExpiresAt: null,
            lastWorkerId: selfWorkerId
        });
        await updateAffinity(guild_id, user_id, selfWorkerId, message_type);

        // Update campaign counters
        await db.run('UPDATE dm_campaigns SET total_sent = total_sent + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);

        return { ok: true, sent: true };
    } catch (err) {
        const classified = classifyDmError(err);

        await recordAttempt(
            campaign_id, targetId, guild_id, user_id, selfWorkerId, attemptNo,
            classified.category,
            err.code ? String(err.code) : null,
            err.message ? err.message.slice(0, 500) : null
        );

        if (classified.shouldBlock) {
            // Record block for this worker+user
            await recordBlock(guild_id, user_id, selfWorkerId, classified.category, err.code ? String(err.code) : null);

            // Check if ALL workers are blocked for this user
            const eligibleWorkers = await getEligibleWorkers();
            const blockedWorkerIds = await getBlockedWorkerIds(guild_id, user_id);
            const anyEligible = eligibleWorkers.some(w => !blockedWorkerIds.has(w.worker_id));

            if (!anyEligible) {
                // All workers exhausted — undeliverable
                await updateTargetStatus(targetId, 'undeliverable', {
                    attempts: attemptNo,
                    assignedWorkerId: selfWorkerId,
                    claimExpiresAt: null,
                    lastWorkerId: selfWorkerId,
                    lastErrorCode: err.code ? String(err.code) : null,
                    lastErrorMessage: err.message ? err.message.slice(0, 500) : null,
                    blockedByWorkerId: selfWorkerId
                });
                await db.run('UPDATE dm_campaigns SET total_undeliverable = total_undeliverable + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);
            } else {
                // Requeue for another worker
                await updateTargetStatus(targetId, 'pending', {
                    attempts: attemptNo,
                    assignedWorkerId: null,
                    claimExpiresAt: null,
                    lastWorkerId: selfWorkerId,
                    lastErrorCode: err.code ? String(err.code) : null,
                    lastErrorMessage: err.message ? err.message.slice(0, 500) : null,
                    blockedByWorkerId: selfWorkerId
                });
                await db.run('UPDATE dm_campaigns SET total_blocked = total_blocked + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);
            }

            return { ok: false, category: classified.category };
        }

        if (classified.shouldRetry && attemptNo <= RETRY_LIMIT) {
            const retryDelay = classified.category === 'rate_limited'
                ? getRetryAfterMs(err, SEND_DELAY_MS * 3)
                : SEND_DELAY_MS * 2 * attemptNo;

            await updateTargetStatus(targetId, 'pending', {
                attempts: attemptNo,
                nextAttemptAt: Date.now() + retryDelay,
                assignedWorkerId: null,
                claimExpiresAt: null,
                lastWorkerId: selfWorkerId,
                lastErrorCode: err.code ? String(err.code) : null,
                lastErrorMessage: err.message ? err.message.slice(0, 500) : null
            });
            await db.run('UPDATE dm_campaigns SET total_retries = total_retries + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);
            return { ok: false, category: classified.category, willRetry: true };
        }

        // Exhausted retries — mark failed
        await updateTargetStatus(targetId, 'failed', {
            attempts: attemptNo,
            assignedWorkerId: selfWorkerId,
            claimExpiresAt: null,
            lastWorkerId: selfWorkerId,
            lastErrorCode: err.code ? String(err.code) : null,
            lastErrorMessage: err.message ? err.message.slice(0, 500) : null
        });
        await db.run('UPDATE dm_campaigns SET total_failed = total_failed + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);
        return { ok: false, category: classified.category };
    }
}

/**
 * Check if a campaign is fully done and update its status accordingly.
 */
async function checkCampaignCompletion(campaignId) {
    const remaining = await db.get(
        `SELECT COUNT(*) as cnt FROM dm_campaign_targets
     WHERE campaign_id = ? AND status IN ('pending', 'claimed', 'retry_wait')`,
        campaignId
    );

    if (remaining && remaining.cnt > 0) return false;

    const failures = await db.get(
        `SELECT COUNT(*) as cnt FROM dm_campaign_targets
     WHERE campaign_id = ? AND status IN ('failed', 'undeliverable', 'blocked')`,
        campaignId
    );

    const now = Date.now();
    const newStatus = (failures && failures.cnt > 0) ? 'completed_with_errors' : 'completed';

    await db.run(
        `UPDATE dm_campaigns SET status = ?, finished_at = ?, updated_at = ?
     WHERE id = ? AND status IN ('queued', 'running')`,
        newStatus, now, now, campaignId
    );

    void logRuntimeEvent('info', 'dm.campaign.completed', 'DM campaign completed', {
        campaignId,
        status: newStatus,
        hasErrors: failures && failures.cnt > 0
    });

    return true;
}

// ── Main poll loop ──────────────────────────────────────────────────────────

/**
 * Single poll iteration: claim + process targets.
 */
async function pollOnce(client, workerId) {
    const claimed = await claimTargets(workerId, CLAIM_BATCH);
    if (claimed.length === 0) return 0;

    let processed = 0;
    const campaignsToCheck = new Set();

    for (const target of claimed) {
        const result = await processTarget(target, client, workerId);
        processed++;
        campaignsToCheck.add(target.campaign_id);

        // Delay between sends
        if (processed < claimed.length && result && result.sent) {
            const jitter = Math.floor(Math.random() * 200);
            await new Promise(r => setTimeout(r, SEND_DELAY_MS + jitter));
        }
    }

    // Check completion for affected campaigns
    for (const cid of campaignsToCheck) {
        await checkCampaignCompletion(cid);
    }

    return processed;
}

/**
 * Start the worker poll loop.
 *
 * @param {object} client  discord.js Client (logged in)
 * @param {string} workerId  Unique worker identifier
 * @param {string} [displayName]  Human-readable name
 */
function startWorker(client, workerId, displayName) {
    if (_running) return;
    _running = true;

    void logRuntimeEvent('info', 'dm.worker.start', 'DM worker started', { workerId, displayName });

    // Heartbeat
    void heartbeat(workerId, displayName);
    _heartbeatTimer = setInterval(() => {
        void heartbeat(workerId, displayName).catch(err => {
            void logUnexpectedError('dm.worker.heartbeat', err, { workerId });
        });
    }, HEARTBEAT_MS);

    // Poll loop
    const poll = async () => {
        if (!_running) return;
        try {
            await pollOnce(client, workerId);
        } catch (err) {
            void logUnexpectedError('dm.worker.poll', err, { workerId });
        }
        if (_running) {
            _pollTimer = setTimeout(poll, POLL_MS);
        }
    };
    _pollTimer = setTimeout(poll, POLL_MS);
}

/**
 * Stop the worker.
 */
async function stopWorker(workerId) {
    _running = false;
    if (_pollTimer) { clearTimeout(_pollTimer); _pollTimer = null; }
    if (_heartbeatTimer) { clearInterval(_heartbeatTimer); _heartbeatTimer = null; }

    if (workerId) {
        try {
            await db.run(
                `UPDATE dm_workers SET status = 'offline', last_seen_at = ? WHERE worker_id = ?`,
                Date.now(), workerId
            );
        } catch (_e) { /* best-effort */ }
    }

    void logRuntimeEvent('info', 'dm.worker.stop', 'DM worker stopped', { workerId });
}

module.exports = {
    startWorker,
    stopWorker,
    // Exposed for testing
    pollOnce,
    claimTargets,
    processTarget,
    checkCampaignCompletion,
    heartbeat,
    getAffinity,
    getBlockedWorkerIds,
    getEligibleWorkers,
    updateAffinity,
    recordBlock,
    recordAttempt,
    updateTargetStatus,
    routeTargetToWorker
};

/**
 * DM Worker Runtime — Data Plane [v2.1.0-STABILIZED-FINAL]
 *
 * Each worker bot runs this module to poll the DB queue, claim targets,
 * send DMs, and record results.
 */
'use strict';

const db = require('../../db_async');
const { pickWorker, classifyDmError, getRetryAfterMs } = require('./dm-worker-selector');
const { logUnexpectedError, logRuntimeEvent } = require('../../lib/logger');

// ── Tunables (env) ──────────────────────────────────────────────────────────
function envInt(key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const raw = process.env[key];
    if (raw === undefined || raw === null || raw.trim() === '') return fallback;
    const v = Number.parseInt(raw, 10);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

const POLL_MS = envInt('DM_QUEUE_POLL_MS', 800, 200, 30000);
const CLAIM_BATCH = 1; // Atomic Sync: Only 1 DM at a time per worker to force parallel fleet distribution
const SEND_DELAY_MS = envInt('DM_MIN_DELAY_MS', 2000, 100, 5000);
const RETRY_LIMIT = 3;
const HEARTBEAT_MS = envInt('DM_HEARTBEAT_MS', 15000, 5000, 60000);
const CLAIM_LEASE_MS = envInt('DM_CLAIM_LEASE_MS', 60000, 10000, 300000);

// ── Shared Registry ─────────────────────────────────────────────────────────
const activeWorkers = new Map();

class DMWorker {
    constructor(client, workerId, displayName) {
        this.client = client;
        this.workerId = workerId;
        this.displayName = displayName || workerId;
        this.running = false;
        this.pollTimer = null;
        this.heartbeatTimer = null;
        this.cancellationTimer = null;
        this.lastCancellationId = 0;
    }

    async heartbeat() {
        const now = Date.now();
        await db.run(
            `INSERT INTO dm_workers (worker_id, display_name, enabled, weight, started_at, last_seen_at, status)
             VALUES (?, ?, 1, 1, ?, ?, 'online')
             ON CONFLICT(worker_id) DO UPDATE SET
               last_seen_at = excluded.last_seen_at,
               status = 'online'`,
            this.workerId, this.displayName, now, now
        );

        // CLEANUP: Best-effort removal of dead workers (older than 24h) to keep selector fast
        const expiry = now - (24 * 60 * 60 * 1000);
        await db.run('DELETE FROM dm_workers WHERE last_seen_at < ? AND status = \'offline\'', expiry).catch(() => null);
    }

    async claimTargets(batchSize) {
        // COORDINATED: Consult the global database backoff clock
        const globalRecord = await db.get('SELECT backoff_until FROM dm_global_backoff WHERE id = 1');
        if (globalRecord && Date.now() < globalRecord.backoff_until) return [];


        const now = Date.now();
        const leaseExpiry = now + CLAIM_LEASE_MS;
        const claimId = `claim_${this.workerId}_${now}_${Math.random().toString(36).slice(2, 7)}`;

        // ATOMIC CLAIM: Use a transaction to ensure stale cleanup and new claims are atomic
        try {
            await db.run('BEGIN IMMEDIATE');

            // 1. Expire stale claims
            await db.run(
                `UPDATE dm_campaign_targets
                 SET status = 'pending', assigned_worker_id = NULL, claim_id = NULL, updated_at = ?
                 WHERE status = 'claimed' AND claim_expires_at IS NOT NULL AND claim_expires_at <= ?`,
                now, now
            );

            // 2. Claim new targets
            await db.run(
                `UPDATE dm_campaign_targets
                 SET status = 'claimed',
                     assigned_worker_id = ?,
                     claim_id = ?,
                     claim_expires_at = ?,
                     updated_at = ?
                 WHERE id IN (
                     SELECT t.id
                     FROM dm_campaign_targets t
                     JOIN dm_campaigns c ON c.id = t.campaign_id
                     WHERE (t.status = 'pending' OR (t.status = 'sending' AND t.claim_expires_at <= ?))
                       AND (t.next_attempt_at IS NULL OR t.next_attempt_at <= ?)
                       AND c.status IN ('queued', 'running')
                     ORDER BY t.batch_no ASC, t.id ASC
                     LIMIT ?
                 ) AND (status = 'pending' OR status = 'sending')`,
                this.workerId, claimId, leaseExpiry, now, now, now, batchSize
            );

            await db.run('COMMIT');
        } catch (err) {
            await db.run('ROLLBACK').catch(() => null);
            throw err;
        }

        const rows = await db.all(
            `SELECT t.id, t.campaign_id, t.guild_id, t.user_id, t.batch_no, t.attempts, t.worker_switches,
                    c.message_type, c.message_body, c.max_misc_streak, c.sticky_window_hours
             FROM dm_campaign_targets t
             JOIN dm_campaigns c ON c.id = t.campaign_id
             WHERE t.claim_id = ?`,
            claimId
        );

        if (rows.length === 0) return [];

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

    async processTarget(target) {
        const { id: targetId, campaign_id, guild_id, user_id, message_type, message_body, attempts } = target;
        const attemptNo = (attempts || 0) + 1;

        const route = await routeTargetToWorker(target, this.workerId);
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

        const leaseRefresher = setInterval(() => {
            void updateTargetStatus(targetId, 'claimed', {
                claimExpiresAt: Date.now() + CLAIM_LEASE_MS
            }).catch(err => {
                void logUnexpectedError('dm.worker.leaseRefresher', err, { targetId });
            });
        }, HEARTBEAT_MS);

        try {
            const campaign = await db.get('SELECT status FROM dm_campaigns WHERE id = ?', campaign_id);
            if (campaign && campaign.status === 'cancelled') {
                clearInterval(leaseRefresher);
                await updateTargetStatus(targetId, 'cancelled', {
                    claimExpiresAt: null,
                    assignedWorkerId: null
                });
                return { ok: false, sent: false, category: 'campaign_cancelled' };
            }

            // IDEMPOTENCY: Mark as 'sending' in DB BEFORE making the external network call
            await updateTargetStatus(targetId, 'sending', {
                claimExpiresAt: Date.now() + 60000 // Ensure lease is fresh for this send
            });

            const guild = await this.client.guilds.fetch(guild_id);
            const member = await guild.members.fetch(user_id);

            // ACT: The external side effect
            const msg = await member.send(message_body);
            clearInterval(leaseRefresher);

            // RESOLVE: Record success and store the message ID for surgical cancellation
            await recordAttempt(campaign_id, targetId, guild_id, user_id, this.workerId, attemptNo, 'sent', null, null, msg.id);
            await updateTargetStatus(targetId, 'sent', {
                attempts: attemptNo,
                assignedWorkerId: this.workerId,
                claimExpiresAt: null,
                lastWorkerId: this.workerId
            });
            await updateAffinity(guild_id, user_id, this.workerId, message_type);

            await db.run('UPDATE dm_campaigns SET total_sent = total_sent + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);

            void logRuntimeEvent('info', 'dm.worker.sent', 'DM delivered successfully', { 
                workerId: this.workerId, targetId, campaign_id, user_id 
            });

            return { ok: true, sent: true };
        } catch (err) {
            clearInterval(leaseRefresher);
            const classified = classifyDmError(err);
            
            // EMERGENCY: Apply global backoff if rate limited
            if (classified.category === 'rate_limited') {
                const retryAfter = getRetryAfterMs(err, 5000);
                const backoffUntil = Date.now() + retryAfter;
                
                // MULTI-WORKER UPSERT: Use MAX() logic to ensure longest backoff always wins
                await db.run(
                    `INSERT INTO dm_global_backoff (id, backoff_until, updated_at) VALUES (1, ?, ?)
                     ON CONFLICT(id) DO UPDATE SET 
                       backoff_until = MAX(backoff_until, excluded.backoff_until),
                       updated_at = excluded.updated_at`,
                    backoffUntil, Date.now()
                );

                void logRuntimeEvent('warn', 'dm.worker.backoff', 'Emergency 429 backoff active', { 
                    workerId: this.workerId, retryAfterMs: retryAfter 
                });
            }

            await recordAttempt(
                campaign_id, targetId, guild_id, user_id, this.workerId, attemptNo,
                classified.category,
                err.code ? String(err.code) : null,
                err.message ? err.message.slice(0, 500) : null
            );

            if (classified.shouldBlock) {
                await recordBlock(guild_id, user_id, this.workerId, classified.category, err.code ? String(err.code) : null);
                const eligibleWorkers = await getEligibleWorkers();
                const blockedWorkerIds = await getBlockedWorkerIds(guild_id, user_id);
                const anyEligible = eligibleWorkers.some(w => !blockedWorkerIds.has(w.worker_id));

                if (!anyEligible) {
                    await updateTargetStatus(targetId, 'undeliverable', {
                        attempts: attemptNo,
                        assignedWorkerId: this.workerId,
                        claimExpiresAt: null,
                        lastWorkerId: this.workerId,
                        lastErrorCode: err.code ? String(err.code) : null,
                        lastErrorMessage: err.message ? err.message.slice(0, 500) : null,
                        blockedByWorkerId: this.workerId
                    });
                    await db.run('UPDATE dm_campaigns SET total_undeliverable = total_undeliverable + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);
                } else {
                    await updateTargetStatus(targetId, 'pending', {
                        attempts: attemptNo,
                        assignedWorkerId: null,
                        claimExpiresAt: null,
                        lastWorkerId: this.workerId,
                        lastErrorCode: err.code ? String(err.code) : null,
                        lastErrorMessage: err.message ? err.message.slice(0, 500) : null,
                        blockedByWorkerId: this.workerId
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
                    lastWorkerId: this.workerId,
                    lastErrorCode: err.code ? String(err.code) : null,
                    lastErrorMessage: err.message ? err.message.slice(0, 500) : null
                });
                await db.run('UPDATE dm_campaigns SET total_retries = total_retries + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);
                return { ok: false, category: classified.category, willRetry: true };
            }

            await updateTargetStatus(targetId, 'failed', {
                attempts: attemptNo,
                assignedWorkerId: this.workerId,
                claimExpiresAt: null,
                lastWorkerId: this.workerId,
                lastErrorCode: err.code ? String(err.code) : null,
                lastErrorMessage: err.message ? err.message.slice(0, 500) : null
            });
            await db.run('UPDATE dm_campaigns SET total_failed = total_failed + 1, updated_at = ? WHERE id = ?', Date.now(), campaign_id);
            return { ok: false, category: classified.category };
        }
    }

    async pollOnce() {
        const claimed = await this.claimTargets(CLAIM_BATCH);
        if (claimed.length === 0) return 0;

        let processed = 0;
        const campaignsToCheck = new Set();

        for (const target of claimed) {
            const result = await this.processTarget(target);
            processed++;
            campaignsToCheck.add(target.campaign_id);

            if (result && result.sent) {
                const jitter = Math.floor(Math.random() * 150);
                await new Promise(r => setTimeout(r, SEND_DELAY_MS + jitter));
            }
        }

        for (const cid of campaignsToCheck) {
            await checkCampaignCompletion(cid);
        }

        return processed;
    }

    async executeCancellation(cancellation) {
        // SURGICAL: Filter by campaign_id if available to prevent broad deletions
        const campaignId = cancellation.campaign_id;
        if (!campaignId) return;

        // Fetch attempts with potential message IDs for surgical deletion
        const attempts = await db.all(
            `SELECT user_id, message_id FROM dm_delivery_attempts 
             WHERE worker_id = ? AND campaign_id = ? AND result = 'sent' AND created_at >= ?`,
            this.workerId, campaignId, Date.now() - (48 * 60 * 60 * 1000)
        );
        
        if (!attempts || attempts.length === 0) return;
        
        let deletedCount = 0;
        for (const record of attempts) {
            try {
                const user = await this.client.users.fetch(record.user_id).catch(() => null);
                if (!user) continue;
                
                const channel = user.dmChannel || await user.createDM().catch(() => null);
                if (!channel) continue;

                // SURGICAL: If we have the message_id, delete it directly (lightning fast)
                if (record.message_id) {
                    try {
                        const msg = await channel.messages.fetch(record.message_id).catch(() => null);
                        if (msg) {
                            await msg.delete();
                            deletedCount++;
                            continue; // Skip the scraping fall-back
                        }
                    } catch (e) {
                        if (e && (e.status === 429 || e.code === 429)) throw e; // Pass to rate-limit handler
                    }
                }
                
                // FALL-BACK: Scrape (for older messages or missing IDs)
                const messages = await channel.messages.fetch({ limit: 12 }).catch(() => null);
                if (!messages) continue;
                
                for (const [, msg] of messages) {
                    if (msg.author.id !== this.client.user.id) continue;
                    
                    let shouldDelete = false;
                    if (cancellation.mode === 'all') shouldDelete = true;
                    else if (cancellation.mode === 'recent') shouldDelete = true;
                    else if (cancellation.mode === 'phrase' && cancellation.phrase) {
                        if (msg.content.includes(cancellation.phrase)) shouldDelete = true;
                    }
                    
                    if (shouldDelete) {
                        try {
                            await msg.delete();
                            deletedCount++;
                            if (cancellation.mode === 'recent') break;
                        } catch(e) {
                            if (e && (e.status === 429 || e.code === 429)) throw e;
                        }
                    }
                }
                await new Promise(r => setTimeout(r, 600));
            } catch (err) {
                if (err && (err.status === 429 || err.code === 429)) {
                    const retryAfter = getRetryAfterMs(err, 5000);
                    const backoffUntil = Date.now() + retryAfter;
                    
                    await db.run(
                        `INSERT INTO dm_global_backoff (id, backoff_until, updated_at) VALUES (1, ?, ?)
                         ON CONFLICT(id) DO UPDATE SET 
                           backoff_until = MAX(backoff_until, excluded.backoff_until),
                           updated_at = excluded.updated_at`,
                        backoffUntil, Date.now()
                    );
                    break; // Exhausted rate limit, stop the current cancellation pass
                }
            }
        }
        
        void logRuntimeEvent('info', 'dm.cancellation', 'Processed message cancellation', {
            workerId: this.workerId,
            mode: cancellation.mode,
            deletedCount
        });
    }

    async pollCancellations() {
        let rows;
        try {
            rows = await db.all(
                `SELECT * FROM dm_cancellations WHERE id > ? AND (target_worker_id = 'all' OR target_worker_id = ?)`,
                this.lastCancellationId, this.workerId
            );
        } catch (err) {
            if (err && err.message && err.message.includes('no such table')) return;
            throw err;
        }
        
        if (!rows || rows.length === 0) return;
        
        for (const row of rows) {
            if (row.id > this.lastCancellationId) this.lastCancellationId = row.id;
            await this.executeCancellation(row);
        }
    }

    start() {
        if (this.running) return;
        this.running = true;

        void logRuntimeEvent('info', 'dm.worker.start', 'DM worker started', { workerId: this.workerId, displayName: this.displayName });

        void this.heartbeat();
        this.heartbeatTimer = setInterval(() => {
            void this.heartbeat().catch(err => {
                void logUnexpectedError('dm.worker.heartbeat', err, { workerId: this.workerId });
            });
        }, HEARTBEAT_MS);

        const poll = async () => {
            if (!this.running) return;
            try {
                await this.pollOnce();
            } catch (err) {
                void logUnexpectedError('dm.worker.poll', err, { workerId: this.workerId });
            }
            if (this.running) {
                this.pollTimer = setTimeout(poll, POLL_MS);
            }
        };
        this.pollTimer = setTimeout(poll, POLL_MS);

        const pollCancel = async () => {
            if (!this.running) return;
            try {
                await this.pollCancellations();
            } catch (err) {
                void logUnexpectedError('dm.worker.cancelpoll', err, { workerId: this.workerId });
            }
            if (this.running) {
                this.cancellationTimer = setTimeout(pollCancel, 10000);
            }
        };
        this.cancellationTimer = setTimeout(pollCancel, 5000);
    }

    async stop() {
        this.running = false;
        if (this.pollTimer) clearTimeout(this.pollTimer);
        if (this.heartbeatTimer) clearInterval(this.heartbeatTimer);
        if (this.cancellationTimer) clearTimeout(this.cancellationTimer);

        try {
            await db.run(
                `UPDATE dm_workers SET status = 'offline', last_seen_at = ? WHERE worker_id = ?`,
                Date.now(), this.workerId
            );
        } catch (_e) { }

        activeWorkers.delete(this.workerId);
        void logRuntimeEvent('info', 'dm.worker.stop', 'DM worker stopped', { workerId: this.workerId });
    }
}

// ── Static Helpers ──────────────────────────────────────────────────────────

async function getAffinity(guildId, userId) {
    return db.get('SELECT * FROM dm_user_affinity WHERE guild_id = ? AND user_id = ?', guildId, userId);
}

async function getBlockedWorkerIds(guildId, userId) {
    const rows = await db.all('SELECT worker_id FROM dm_worker_user_blocks WHERE guild_id = ? AND user_id = ?', guildId, userId);
    return new Set(rows.map(r => r.worker_id));
}

let eligibleWorkersCache = { data: null, expiresAt: 0 };

async function getEligibleWorkers(staleMs = 60000) {
    const now = Date.now();
    if (eligibleWorkersCache.data && now < eligibleWorkersCache.expiresAt) return eligibleWorkersCache.data;
    const cutoff = now - staleMs;
    const workers = await db.all(`SELECT * FROM dm_workers WHERE enabled = 1 AND last_seen_at >= ?`, cutoff);
    eligibleWorkersCache.data = workers;
    eligibleWorkersCache.expiresAt = now + 2000;
    return workers;
}

async function updateAffinity(guildId, userId, workerId, messageType) {
    const now = Date.now();
    const isWar = messageType === 'war_early' || messageType === 'war_late';
    const existing = await getAffinity(guildId, userId);

    if (!existing) {
        await db.run(
            `INSERT INTO dm_user_affinity
             (guild_id, user_id, preferred_worker_id, preferred_worker_last_dm_at,
              consecutive_misc_count, war_worker_id, war_last_dm_at, updated_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            guildId, userId, isWar ? null : workerId, isWar ? null : now, isWar ? 0 : 1, isWar ? workerId : null, isWar ? now : null, now
        );
        return;
    }

    if (isWar) {
        await db.run(`UPDATE dm_user_affinity SET war_worker_id = ?, war_last_dm_at = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?`, workerId, now, now, guildId, userId);
    } else {
        const sameWorker = existing.preferred_worker_id === workerId;
        const newStreak = sameWorker ? (existing.consecutive_misc_count || 0) + 1 : 1;
        await db.run(`UPDATE dm_user_affinity SET preferred_worker_id = ?, preferred_worker_last_dm_at = ?, consecutive_misc_count = ?, updated_at = ? WHERE guild_id = ? AND user_id = ?`, workerId, now, newStreak, now, guildId, userId);
    }
}

async function recordBlock(guildId, userId, workerId, reason, errorCode) {
    const now = Date.now();
    await db.run(
        `INSERT INTO dm_worker_user_blocks (guild_id, user_id, worker_id, reason, error_code, blocked_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(guild_id, user_id, worker_id) DO UPDATE SET reason = excluded.reason, error_code = excluded.error_code, updated_at = excluded.updated_at`,
        guildId, userId, workerId, reason, errorCode, now, now
    );
}

async function recordAttempt(campaignId, targetId, guildId, userId, workerId, attemptNo, result, errorCode, errorMessage, messageId = null) {
    await db.run(
        `INSERT INTO dm_delivery_attempts (campaign_id, target_id, guild_id, user_id, worker_id, attempt_no, result, error_code, error_message, message_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        campaignId, targetId, guildId, userId, workerId, attemptNo, result, errorCode, errorMessage, messageId, Date.now()
    );
}

async function updateTargetStatus(targetId, status, updates = {}) {
    const now = Date.now();
    const sets = ['status = ?', 'updated_at = ?'];
    const params = [status, now];

    const fields = {
        lastErrorCode: 'last_error_code',
        lastErrorMessage: 'last_error_message',
        attempts: 'attempts',
        nextAttemptAt: 'next_attempt_at',
        assignedWorkerId: 'assigned_worker_id',
        claimExpiresAt: 'claim_expires_at',
        blockedByWorkerId: 'blocked_by_worker_id',
        lastWorkerId: 'last_worker_id',
        workerSwitches: 'worker_switches'
    };

    for (const [key, dbField] of Object.entries(fields)) {
        if (updates[key] !== undefined) {
            sets.push(`${dbField} = ?`);
            params.push(updates[key]);
        }
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
    if (target.assigned_worker_id === selfWorkerId) return { selectedWorkerId: selfWorkerId, action: 'send' };
    const affinity = await getAffinity(target.guild_id, target.user_id);
    const blockedWorkerIds = await getBlockedWorkerIds(target.guild_id, target.user_id);
    const eligibleWorkers = await getEligibleWorkers();
    const now = Date.now();
    const selectedWorkerId = pickWorker({
        messageType: target.message_type,
        affinity,
        eligibleWorkers,
        blockedWorkerIds,
        stickyWindowMs: toPositiveInt(target.sticky_window_hours, 24) * 60 * 60 * 1000,
        maxMiscStreak: toPositiveInt(target.max_misc_streak, 4)
    }, now);
    if (!selectedWorkerId) return { selectedWorkerId: null, action: 'undeliverable_no_worker' };
    if (selectedWorkerId !== selfWorkerId) {
        await updateTargetStatus(target.id, 'pending', {
            assignedWorkerId: selectedWorkerId,
            claimExpiresAt: null,
            lastWorkerId: selfWorkerId,
            workerSwitches: (Number(target.worker_switches) || 0) + 1
        });
        return { selectedWorkerId, action: 'reassigned' };
    }
    return { selectedWorkerId, action: 'send' };
}

async function checkCampaignCompletion(campaignId) {
    const remaining = await db.get(
        `SELECT COUNT(*) as cnt FROM dm_campaign_targets 
         WHERE campaign_id = ? AND status IN ('pending', 'claimed', 'sending', 'retry_wait')`,
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

    // ATOMIC COMPLETION: Only update if status is still 'queued' or 'running'
    // result.changes will be 1 only for the *first* worker to finish the campaign
    const result = await db.run(
        `UPDATE dm_campaigns SET status = ?, finished_at = ?, updated_at = ? 
         WHERE id = ? AND status IN ('queued', 'running')`,
        newStatus, now, now, campaignId
    );

    if (result.changes > 0) {
        void logRuntimeEvent('info', 'dm.campaign.completed', 'DM campaign completed', {
            campaignId,
            status: newStatus,
            hasErrors: failures && failures.cnt > 0
        });
    }
    return true;
}

function startWorker(client, workerId, displayName) {
    if (activeWorkers.has(workerId)) return activeWorkers.get(workerId);
    const worker = new DMWorker(client, workerId, displayName);
    activeWorkers.set(workerId, worker);
    worker.start();
    return worker;
}

async function stopWorker(workerId) {
    const worker = activeWorkers.get(workerId);
    if (worker) await worker.stop();
}

async function stopAllWorkers() {
    const workers = Array.from(activeWorkers.values());
    await Promise.all(workers.map(w => w.stop()));
}

module.exports = {
    startWorker, stopWorker, stopAllWorkers, DMWorker,
    checkCampaignCompletion, getAffinity, getBlockedWorkerIds,
    getEligibleWorkers, updateAffinity, recordBlock, recordAttempt,
    updateTargetStatus, routeTargetToWorker
};

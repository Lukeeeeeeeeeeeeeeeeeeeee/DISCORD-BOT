/**
 * DM Worker Selector — Routing & Affinity Logic
 *
 * Decides which worker bot should send a DM to a given user,
 * based on message type, affinity history, block records, and rotation rules.
 */
'use strict';

// ── Registry [Singleton Alert] ───────────────────────────────────────────────
// In a single-process environment, this cache is shared. For multi-process
// horizontal scaling, this should be moved to a distributed store (e.g. Redis).
let eligibleWorkersCache = { data: null, expiresAt: 0 };
const { envInt } = require('../../lib/env-utils');
const WEIGHTED_STALE_MS = envInt('DM_SELECTOR_STALE_MS', 60000);
const DEFAULT_STICKY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_MISC_STREAK = 4;
const MAIN_WORKER_ID = 'main';

/**
 * Perform proportional weighted random selection from a list of worker candidates.
 * 
 * @param {Array} candidates
 * @returns {string|null}
 */
function pickWorkerWeightedRandom(candidates) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].worker_id;

    // Proportional Weighting: The "Cumulative Weight Wheel" Algorithm
    const weights = candidates.map(c => Math.max(1, Number(c.weight) || 1));
    const totalWeight = weights.reduce((sum, w) => sum + w, 0);
    
    let random = Math.random() * totalWeight;
    for (let i = 0; i < candidates.length; i++) {
        random -= weights[i];
        if (random < 0) return candidates[i].worker_id;
    }
    
    return candidates[0].worker_id;
}

/**
 * Deterministic selector used by compatibility tests and routing fallbacks.
 * Prefer the highest weight, then the oldest last_seen_at to spread load.
 *
 * @param {Array} candidates
 * @returns {string|null}
 */
function pickLeastRecentlyUsedWeighted(candidates) {
    if (!candidates || candidates.length === 0) return null;
    if (candidates.length === 1) return candidates[0].worker_id;

    const ranked = [...candidates].sort((a, b) => {
        const weightDelta = (Number(b.weight) || 1) - (Number(a.weight) || 1);
        if (weightDelta !== 0) return weightDelta;

        const aLastSeen = Number.isFinite(Number(a.last_seen_at)) ? Number(a.last_seen_at) : Number.POSITIVE_INFINITY;
        const bLastSeen = Number.isFinite(Number(b.last_seen_at)) ? Number(b.last_seen_at) : Number.POSITIVE_INFINITY;
        if (aLastSeen !== bLastSeen) return aLastSeen - bLastSeen;

        return String(a.worker_id || '').localeCompare(String(b.worker_id || ''));
    });

    return ranked[0] ? ranked[0].worker_id : null;
}

/**
 * Fetch enabled and online workers from the database with a local cache.
 * 
 * @param {number} [staleThresholdMs=120000] 
 * @returns {Promise<Array>}
 */
async function getEligibleWorkers(staleThresholdMs = 120000) {
    const now = Date.now();
    
    // CACHE HIT: Use WEIGHTED_STALE_MS from env or default (60s)
    if (eligibleWorkersCache.data && now < eligibleWorkersCache.expiresAt) {
        return eligibleWorkersCache.data;
    }

    try {
        const db = require('../../db_async');
        const rows = await db.all(
            `SELECT worker_id, display_name, weight, status FROM dm_workers 
             WHERE enabled = 1 AND status = 'online' AND last_seen_at >= ?`,
            now - staleThresholdMs
        );
        eligibleWorkersCache = { data: rows, expiresAt: now + WEIGHTED_STALE_MS };
        return rows;
    } catch (err) {
        const { logUnexpectedError } = require('../../lib/logger');
        logUnexpectedError('dm.selector.getEligibleWorkers', err);
        return [];
    }
}

/**
 * Core selector: choose which worker should handle a DM for a target user.
 *
 * @param {object} opts
 * @param {string} opts.messageType         'misc' | 'war_early' | 'war_late'
 * @param {object|null} opts.affinity       Row from dm_user_affinity (or null if new user)
 * @param {object[]} opts.eligibleWorkers   Array of dm_workers rows that are enabled + online
 * @param {Set<string>|Array<string>} opts.blockedWorkerIds  Worker IDs that are blocked for this user
 * @param {number} [opts.stickyWindowMs]    Override for 24h sticky window
 * @param {number} [opts.maxMiscStreak]     Override for max consecutive misc sends
 * @param {number} [now=Date.now()]         Current timestamp for affinity windows
 * @returns {string|null}                   Selected worker_id, or null if all blocked
 */
function pickWorker({
    messageType,
    affinity,
    eligibleWorkers,
    blockedWorkerIds,
    stickyWindowMs = DEFAULT_STICKY_WINDOW_MS,
    maxMiscStreak = DEFAULT_MAX_MISC_STREAK
}, now = Date.now()) {
    if (!eligibleWorkers || eligibleWorkers.length === 0) return null;

    const blockedSet = blockedWorkerIds instanceof Set ? blockedWorkerIds : new Set(blockedWorkerIds || []);
    const candidates = eligibleWorkers.filter(w => !blockedSet.has(w.worker_id));
    if (candidates.length === 0) return null;

    const aff = affinity || {};

    if (messageType === 'system_welcome' || messageType === 'system_quota') {
        const mainWorker = candidates.find((worker) => worker.worker_id === MAIN_WORKER_ID);
        if (mainWorker) return MAIN_WORKER_ID;
    }

    // ── War messages: sticky to war_worker_id ──
    if (messageType === 'war_early' || messageType === 'war_late') {
        if (aff.war_worker_id && candidates.some(w => w.worker_id === aff.war_worker_id)) {
            return aff.war_worker_id;
        }
        // War worker unavailable — fallback to weighted random.
        return pickWorkerWeightedRandom(candidates);
    }

    // ── Misc messages: affinity + rotation ──
    const preferredDmAt = aff.preferred_worker_last_dm_at || 0;
    const within24h = preferredDmAt > 0 && (now - preferredDmAt) <= stickyWindowMs;
    const underStreakCap = (aff.consecutive_misc_count || 0) < maxMiscStreak;
    const preferredEligible = aff.preferred_worker_id
        && candidates.some(w => w.worker_id === aff.preferred_worker_id);

    if (within24h && underStreakCap && preferredEligible) {
        return aff.preferred_worker_id;
    }

    // Rotate: pick from candidates excluding current preferred
    const rotated = pickWorkerWeightedRandom(
        candidates.filter(w => w.worker_id !== aff.preferred_worker_id)
    );
    if (rotated) return rotated;

    // All candidates are the same as preferred (single worker), allow it
    return pickWorkerWeightedRandom(candidates);
}

/**
 * Classify a Discord API error for DM sending.
 *
 * @param {Error} err
 * @returns {{ category: string, shouldBlock: boolean, shouldRetry: boolean }}
 */
function classifyDmError(err) {
    if (!err) return { category: 'unknown_failure', shouldBlock: false, shouldRetry: false };

    const code = err.code;
    const status = err.status || err.httpStatus;

    // Cannot send to user — blocked or DMs closed
    if (code === 50007 || code === 10013 || code === 10003) {
        return { category: 'blocked_or_closed_dm', shouldBlock: true, shouldRetry: false };
    }

    if (code === 50278) {
        return { category: 'no_mutual_guild', shouldBlock: true, shouldRetry: false };
    }

    // Missing access, permissions, or forbidden
    if (code === 50001 || code === 50013 || status === 403) {
        return { category: 'missing_access_or_perms', shouldBlock: true, shouldRetry: false };
    }

    // Rate limited
    if (status === 429 || code === 429) {
        return { category: 'rate_limited', shouldBlock: false, shouldRetry: true };
    }

    // Transient / network errors
    if (err.name === 'AbortError' || err.code === 'ECONNRESET' || err.code === 'ETIMEDOUT' || err.code === 'ENOTFOUND') {
        return { category: 'transient_network', shouldBlock: false, shouldRetry: true };
    }

    return { category: 'unknown_failure', shouldBlock: false, shouldRetry: false };
}

/**
 * Compute the retry-after delay from a Discord rate-limit error.
 */
function getRetryAfterMs(error, fallbackMs = 2000) {
    const retryAfter = error && (
        error.retryAfter ??
        error.retry_after ??
        (error.data && error.data.retry_after) ??
        (error.rawError && error.rawError.retry_after)
    );
    if (Number.isFinite(retryAfter)) {
        const value = Number(retryAfter);
        // Heuristic: If under 120s, it's likely raw seconds.
        return value < 120 ? Math.ceil(value * 1000) : Math.ceil(value);
    }
    return fallbackMs;
}

module.exports = {
    getEligibleWorkers,
    pickWorker,
    pickLeastRecentlyUsedWeighted,
    pickWorkerWeightedRandom,
    classifyDmError,
    getRetryAfterMs,
    DEFAULT_STICKY_WINDOW_MS,
    DEFAULT_MAX_MISC_STREAK
};

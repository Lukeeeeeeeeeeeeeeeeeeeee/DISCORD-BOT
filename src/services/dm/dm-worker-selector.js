/**
 * DM Worker Selector — Routing & Affinity Logic
 *
 * Decides which worker bot should send a DM to a given user,
 * based on message type, affinity history, block records, and rotation rules.
 */
'use strict';

// ── Configuration defaults ──────────────────────────────────────────────────
const DEFAULT_STICKY_WINDOW_MS = 24 * 60 * 60 * 1000; // 24 hours
const DEFAULT_MAX_MISC_STREAK = 4;

/**
 * Pick the highest-weight worker from candidates.
 * If multiple workers share the highest weight, randomly pick to guarantee even load balancing.
 */
function pickLeastRecentlyUsedWeighted(candidates) {
    if (!candidates || candidates.length === 0) return null;
    
    // Find the maximum weight
    const maxWeight = Math.max(...candidates.map(c => c.weight || 1));
    
    // Get all candidates with the max weight
    const bestCandidates = candidates.filter(c => (c.weight || 1) === maxWeight);
    
    // Randomize to distribute load evenly instead of relying on heartbeat timestamps
    const randomIndex = Math.floor(Math.random() * bestCandidates.length);
    return bestCandidates[randomIndex].worker_id;
}

/**
 * Core selector: choose which worker should handle a DM for a target user.
 *
 * @param {object} opts
 * @param {string} opts.messageType         'misc' | 'war_early' | 'war_late'
 * @param {object|null} opts.affinity       Row from dm_user_affinity (or null if new user)
 * @param {object[]} opts.eligibleWorkers   Array of dm_workers rows that are enabled + online
 * @param {Set<string>} opts.blockedWorkerIds  Worker IDs that are blocked for this user
 * @param {number} [opts.stickyWindowMs]    Override for 24h sticky window
 * @param {number} [opts.maxMiscStreak]     Override for max consecutive misc sends
 * @returns {string|null}                   Selected worker_id, or null if all blocked
 */
function pickWorker({
    messageType,
    affinity,
    eligibleWorkers,
    blockedWorkerIds,
    stickyWindowMs = DEFAULT_STICKY_WINDOW_MS,
    maxMiscStreak = DEFAULT_MAX_MISC_STREAK
} = {}) {
    if (!eligibleWorkers || eligibleWorkers.length === 0) return null;

    const blockedSet = blockedWorkerIds instanceof Set ? blockedWorkerIds : new Set(blockedWorkerIds || []);
    const candidates = eligibleWorkers.filter(w => !blockedSet.has(w.worker_id));
    if (candidates.length === 0) return null;

    const aff = affinity || {};

    // ── War messages: sticky to war_worker_id ──
    if (messageType === 'war_early' || messageType === 'war_late') {
        if (aff.war_worker_id && candidates.some(w => w.worker_id === aff.war_worker_id)) {
            return aff.war_worker_id;
        }
        // War worker unavailable — fallback to LRU weighted
        return pickLeastRecentlyUsedWeighted(candidates);
    }

    // ── Misc messages: affinity + rotation ──
    const now = Date.now();
    const preferredDmAt = aff.preferred_worker_last_dm_at || 0;
    const within24h = preferredDmAt > 0 && (now - preferredDmAt) <= stickyWindowMs;
    const underStreakCap = (aff.consecutive_misc_count || 0) < maxMiscStreak;
    const preferredEligible = aff.preferred_worker_id
        && candidates.some(w => w.worker_id === aff.preferred_worker_id);

    if (within24h && underStreakCap && preferredEligible) {
        return aff.preferred_worker_id;
    }

    // Rotate: pick from candidates excluding current preferred
    const rotated = pickLeastRecentlyUsedWeighted(
        candidates.filter(w => w.worker_id !== aff.preferred_worker_id)
    );
    if (rotated) return rotated;

    // All candidates are the same as preferred (single worker), allow it
    return pickLeastRecentlyUsedWeighted(candidates);
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
    if (code === 50007) {
        return { category: 'blocked_or_closed_dm', shouldBlock: true, shouldRetry: false };
    }

    // Missing access or permissions
    if (code === 50001 || code === 50013) {
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
        return value < 1000 ? Math.ceil(value * 1000) : Math.ceil(value);
    }
    return fallbackMs;
}

module.exports = {
    pickWorker,
    pickLeastRecentlyUsedWeighted,
    classifyDmError,
    getRetryAfterMs,
    DEFAULT_STICKY_WINDOW_MS,
    DEFAULT_MAX_MISC_STREAK
};

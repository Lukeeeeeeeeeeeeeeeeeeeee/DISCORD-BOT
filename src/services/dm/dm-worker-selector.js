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
 * Core selector: choose which worker should handle a DM for a target user.
 *
 * @param {object} opts
 * @param {string} opts.messageType         'misc' | 'war_early' | 'war_late'
 * @param {object|null} opts.affinity       Row from dm_user_affinity (or null if new user)
 * @param {object[]} opts.eligibleWorkers   Array of dm_workers rows that are enabled + online
 * @param {Set<string>} opts.blockedWorkerIds  Worker IDs that are blocked for this user
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

    // ── War messages: sticky to war_worker_id ──
    if (messageType === 'war_early' || messageType === 'war_late') {
        if (aff.war_worker_id && candidates.some(w => w.worker_id === aff.war_worker_id)) {
            return aff.war_worker_id;
        }
        // War worker unavailable — fallback to Weighted Random
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
    pickWorker,
    pickWorkerWeightedRandom,
    classifyDmError,
    getRetryAfterMs,
    DEFAULT_STICKY_WINDOW_MS,
    DEFAULT_MAX_MISC_STREAK
};

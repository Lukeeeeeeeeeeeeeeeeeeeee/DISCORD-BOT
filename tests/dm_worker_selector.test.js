/**
 * Tests for DM Worker Selector — routing / affinity / error classification
 */
'use strict';

const {
    pickWorker,
    pickLeastRecentlyUsedWeighted,
    classifyDmError,
    getRetryAfterMs
} = require('../src/services/dm/dm-worker-selector');

function makeWorker(id, { weight = 1, enabled = 1, last_seen_at = Date.now() } = {}) {
    return { worker_id: id, weight, enabled, last_seen_at, status: 'online' };
}

describe('dm-worker-selector', () => {
    describe('pickLeastRecentlyUsedWeighted', () => {
        test('returns null for empty array', () => {
            expect(pickLeastRecentlyUsedWeighted([])).toBeNull();
        });

        test('returns the only candidate', () => {
            expect(pickLeastRecentlyUsedWeighted([makeWorker('w1')])).toBe('w1');
        });

        test('prefers higher weight', () => {
            const result = pickLeastRecentlyUsedWeighted([
                makeWorker('w1', { weight: 1, last_seen_at: 1000 }),
                makeWorker('w2', { weight: 5, last_seen_at: 2000 })
            ]);
            expect(result).toBe('w2');
        });

        test('breaks tie by oldest last_seen_at', () => {
            const result = pickLeastRecentlyUsedWeighted([
                makeWorker('w1', { weight: 1, last_seen_at: 5000 }),
                makeWorker('w2', { weight: 1, last_seen_at: 1000 })
            ]);
            expect(result).toBe('w2');
        });
    });

    describe('pickWorker — war messages', () => {
        test('uses war_worker_id from affinity when eligible', () => {
            const workers = [makeWorker('w1'), makeWorker('w2'), makeWorker('w3')];
            const affinity = { war_worker_id: 'w2' };
            const result = pickWorker({
                messageType: 'war_early',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            });
            expect(result).toBe('w2');
        });

        test('war_late also uses war_worker_id', () => {
            const workers = [makeWorker('w1'), makeWorker('w2')];
            const affinity = { war_worker_id: 'w2' };
            expect(pickWorker({
                messageType: 'war_late',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            })).toBe('w2');
        });

        test('falls back to LRU if war_worker_id is blocked', () => {
            const workers = [
                makeWorker('w1', { last_seen_at: 1000 }),
                makeWorker('w2', { last_seen_at: 2000 })
            ];
            const affinity = { war_worker_id: 'w2' };
            const result = pickWorker({
                messageType: 'war_early',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set(['w2'])
            });
            expect(result).toBe('w1');
        });

        test('returns null when all workers blocked for war', () => {
            const workers = [makeWorker('w1')];
            const result = pickWorker({
                messageType: 'war_early',
                affinity: { war_worker_id: 'w1' },
                eligibleWorkers: workers,
                blockedWorkerIds: new Set(['w1'])
            });
            expect(result).toBeNull();
        });

        test('falls back to LRU when war_worker_id not in eligible list', () => {
            const workers = [makeWorker('w3', { last_seen_at: 1000 })];
            const affinity = { war_worker_id: 'w99' };
            expect(pickWorker({
                messageType: 'war_early',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            })).toBe('w3');
        });
    });

    describe('pickWorker — misc messages', () => {
        test('reuses preferred worker within 24h and under streak cap', () => {
            const workers = [makeWorker('w1'), makeWorker('w2')];
            const affinity = {
                preferred_worker_id: 'w1',
                preferred_worker_last_dm_at: Date.now() - 1000, // 1s ago
                consecutive_misc_count: 2
            };
            expect(pickWorker({
                messageType: 'misc',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            })).toBe('w1');
        });

        test('rotates when consecutive_misc_count reaches max (4)', () => {
            const workers = [
                makeWorker('w1', { last_seen_at: 2000 }),
                makeWorker('w2', { last_seen_at: 1000 })
            ];
            const affinity = {
                preferred_worker_id: 'w1',
                preferred_worker_last_dm_at: Date.now() - 1000,
                consecutive_misc_count: 4 // at cap
            };
            const result = pickWorker({
                messageType: 'misc',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            });
            expect(result).toBe('w2'); // rotated away from w1
        });

        test('rotates when preferred_worker_last_dm_at is older than 24h', () => {
            const workers = [
                makeWorker('w1', { last_seen_at: 2000 }),
                makeWorker('w2', { last_seen_at: 1000 })
            ];
            const affinity = {
                preferred_worker_id: 'w1',
                preferred_worker_last_dm_at: Date.now() - (25 * 60 * 60 * 1000), // 25h ago
                consecutive_misc_count: 1
            };
            const result = pickWorker({
                messageType: 'misc',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            });
            expect(result).toBe('w2');
        });

        test('rotates when preferred worker is blocked', () => {
            const workers = [makeWorker('w1'), makeWorker('w2')];
            const affinity = {
                preferred_worker_id: 'w1',
                preferred_worker_last_dm_at: Date.now() - 1000,
                consecutive_misc_count: 1
            };
            const result = pickWorker({
                messageType: 'misc',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set(['w1'])
            });
            expect(result).toBe('w2');
        });

        test('returns single worker when it is the only candidate', () => {
            const workers = [makeWorker('w1')];
            const affinity = {
                preferred_worker_id: 'w1',
                preferred_worker_last_dm_at: Date.now() - (25 * 60 * 60 * 1000),
                consecutive_misc_count: 5
            };
            expect(pickWorker({
                messageType: 'misc',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            })).toBe('w1');
        });

        test('handles null/missing affinity (new user)', () => {
            const workers = [
                makeWorker('w1', { last_seen_at: 2000 }),
                makeWorker('w2', { last_seen_at: 1000 })
            ];
            const result = pickWorker({
                messageType: 'misc',
                affinity: null,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            });
            expect(result).not.toBeNull();
        });

        test('respects custom stickyWindowMs', () => {
            const workers = [makeWorker('w1'), makeWorker('w2', { last_seen_at: 1000 })];
            const affinity = {
                preferred_worker_id: 'w1',
                preferred_worker_last_dm_at: Date.now() - 5000, // 5s ago
                consecutive_misc_count: 1
            };
            // With 3s window, 5s ago is outside → rotate
            const result = pickWorker({
                messageType: 'misc',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set(),
                stickyWindowMs: 3000
            });
            expect(result).toBe('w2');
        });

        test('respects custom maxMiscStreak', () => {
            const workers = [makeWorker('w1'), makeWorker('w2', { last_seen_at: 1000 })];
            const affinity = {
                preferred_worker_id: 'w1',
                preferred_worker_last_dm_at: Date.now() - 1000,
                consecutive_misc_count: 2
            };
            // With maxMiscStreak=2, count=2 means rotate
            const result = pickWorker({
                messageType: 'misc',
                affinity,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set(),
                maxMiscStreak: 2
            });
            expect(result).toBe('w2');
        });
    });

    describe('pickWorker — system messages', () => {
        test('prefers the main worker for system welcome messages when available', () => {
            const workers = [makeWorker('worker_node_1'), makeWorker('main'), makeWorker('worker_node_2')];

            const result = pickWorker({
                messageType: 'system_welcome',
                affinity: null,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set()
            });

            expect(result).toBe('main');
        });

        test('falls back when the main worker is blocked for a system message', () => {
            const workers = [makeWorker('main'), makeWorker('worker_node_1')];

            const result = pickWorker({
                messageType: 'system_quota',
                affinity: null,
                eligibleWorkers: workers,
                blockedWorkerIds: new Set(['main'])
            });

            expect(result).toBe('worker_node_1');
        });
    });

    describe('classifyDmError', () => {
        test('classifies code 50007 as blocked', () => {
            const err = new Error('Cannot send messages to this user');
            err.code = 50007;
            const result = classifyDmError(err);
            expect(result.category).toBe('blocked_or_closed_dm');
            expect(result.shouldBlock).toBe(true);
            expect(result.shouldRetry).toBe(false);
        });

        test('classifies code 50001 as missing access', () => {
            const err = new Error('Missing Access');
            err.code = 50001;
            const result = classifyDmError(err);
            expect(result.category).toBe('missing_access_or_perms');
            expect(result.shouldBlock).toBe(true);
        });

        test('classifies code 50013 as missing permissions', () => {
            const err = new Error('Missing Permissions');
            err.code = 50013;
            expect(classifyDmError(err).category).toBe('missing_access_or_perms');
        });

        test('classifies code 50278 as no mutual guild', () => {
            const err = new Error('Cannot send messages to this user due to having no mutual guilds');
            err.code = 50278;
            err.status = 403;
            const result = classifyDmError(err);
            expect(result.category).toBe('no_mutual_guild');
            expect(result.shouldBlock).toBe(true);
            expect(result.shouldRetry).toBe(false);
        });

        test('classifies status 429 as rate limited', () => {
            const err = new Error('Rate limited');
            err.status = 429;
            const result = classifyDmError(err);
            expect(result.category).toBe('rate_limited');
            expect(result.shouldRetry).toBe(true);
            expect(result.shouldBlock).toBe(false);
        });

        test('classifies ECONNRESET as transient', () => {
            const err = new Error('read ECONNRESET');
            err.code = 'ECONNRESET';
            expect(classifyDmError(err).category).toBe('transient_network');
        });

        test('classifies unknown errors', () => {
            const err = new Error('Something weird');
            err.code = 99999;
            expect(classifyDmError(err).category).toBe('unknown_failure');
        });

        test('handles null/undefined error', () => {
            expect(classifyDmError(null).category).toBe('unknown_failure');
        });
    });

    describe('getRetryAfterMs', () => {
        test('extracts retryAfter from error', () => {
            const err = { retryAfter: 1.5 };
            expect(getRetryAfterMs(err)).toBe(1500);
        });

        test('returns fallback when no retryAfter', () => {
            expect(getRetryAfterMs({}, 5000)).toBe(5000);
        });

        test('handles retryAfter already in ms', () => {
            const err = { retryAfter: 3000 };
            expect(getRetryAfterMs(err)).toBe(3000);
        });
    });
});

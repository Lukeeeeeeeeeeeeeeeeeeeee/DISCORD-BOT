/**
 * Integration-style tests for DM worker routing enforcement.
 */
'use strict';

const mockState = {
    affinityByUser: new Map(),
    blockedByUser: new Map(),
    workers: [],
    targetUpdates: [],
    campaignCounters: {
        sent: 0,
        failed: 0,
        blocked: 0,
        undeliverable: 0,
        retries: 0
    }
};

function mockUserKey(guildId, userId) {
    return `${guildId}:${userId}`;
}

jest.mock('../src/db_async', () => ({
    get: jest.fn(async (sql, ...params) => {
        if (sql.includes('FROM dm_user_affinity')) {
            const [guildId, userId] = params;
            return mockState.affinityByUser.get(mockUserKey(guildId, userId)) || null;
        }
        return null;
    }),
    all: jest.fn(async (sql, ...params) => {
        if (sql.includes('SELECT worker_id FROM dm_worker_user_blocks')) {
            const [guildId, userId] = params;
            const key = mockUserKey(guildId, userId);
            const blocked = mockState.blockedByUser.get(key) || new Set();
            return [...blocked].map((worker_id) => ({ worker_id }));
        }
        if (sql.includes('SELECT * FROM dm_workers WHERE enabled = 1 AND last_seen_at >= ?')) {
            const [cutoff] = params;
            return mockState.workers.filter((w) => Number(w.enabled) === 1 && Number(w.last_seen_at) >= Number(cutoff));
        }
        return [];
    }),
    run: jest.fn(async (sql, ...params) => {
        if (sql.includes('UPDATE dm_campaign_targets SET')) {
            const setClause = sql.split('SET')[1].split('WHERE')[0];
            const fields = setClause.split(',').map((part) => part.trim().split('=')[0].trim());
            const values = params.slice(0, fields.length);
            const targetId = params[fields.length];
            const update = {};
            fields.forEach((field, idx) => { update[field] = values[idx]; });
            mockState.targetUpdates.push({ targetId, update });
            return { changes: 1 };
        }
        if (sql.includes('INSERT INTO dm_delivery_attempts')) {
            return { changes: 1 };
        }
        if (sql.includes('UPDATE dm_campaigns SET total_sent = total_sent + 1')) {
            mockState.campaignCounters.sent += 1;
            return { changes: 1 };
        }
        if (sql.includes('UPDATE dm_campaigns SET total_failed = total_failed + 1')) {
            mockState.campaignCounters.failed += 1;
            return { changes: 1 };
        }
        if (sql.includes('UPDATE dm_campaigns SET total_blocked = total_blocked + 1')) {
            mockState.campaignCounters.blocked += 1;
            return { changes: 1 };
        }
        if (sql.includes('UPDATE dm_campaigns SET total_undeliverable = total_undeliverable + 1')) {
            mockState.campaignCounters.undeliverable += 1;
            return { changes: 1 };
        }
        if (sql.includes('UPDATE dm_campaigns SET total_retries = total_retries + 1')) {
            mockState.campaignCounters.retries += 1;
            return { changes: 1 };
        }
        if (sql.includes('INSERT INTO dm_worker_user_blocks')) {
            const [guildId, userId, workerId] = params;
            const key = mockUserKey(guildId, userId);
            const blocked = mockState.blockedByUser.get(key) || new Set();
            blocked.add(workerId);
            mockState.blockedByUser.set(key, blocked);
            return { changes: 1 };
        }
        return { changes: 1 };
    })
}));

jest.mock('../src/lib/logger', () => ({
    logUnexpectedError: jest.fn(),
    logRuntimeEvent: jest.fn()
}));

const dmWorker = require('../src/services/dm/dm-worker');

function makeWorkers(now) {
    return [
        { worker_id: 'w1', enabled: 1, weight: 1, last_seen_at: now - 1000, status: 'online' },
        { worker_id: 'w2', enabled: 1, weight: 1, last_seen_at: now - 500, status: 'online' }
    ];
}

function makeTarget(overrides = {}) {
    return {
        id: 1,
        campaign_id: 100,
        guild_id: 'g1',
        user_id: 'u1',
        message_type: 'misc',
        message_body: 'hello',
        attempts: 0,
        worker_switches: 0,
        max_misc_streak: 4,
        sticky_window_hours: 24,
        ...overrides
    };
}

function makeClient(sendImpl = null) {
    const send = sendImpl || jest.fn().mockResolvedValue(true);
    const member = { send };
    const guild = { members: { fetch: jest.fn().mockResolvedValue(member) } };
    return {
        send,
        memberFetch: guild.members.fetch,
        client: {
            guilds: {
                fetch: jest.fn().mockResolvedValue(guild)
            }
        }
    };
}

describe('dm-worker integration routing', () => {
    const fixedNow = 1762150000000;

    beforeEach(() => {
        jest.clearAllMocks();
        mockState.affinityByUser = new Map();
        mockState.blockedByUser = new Map();
        mockState.workers = makeWorkers(fixedNow);
        mockState.targetUpdates = [];
        mockState.campaignCounters = {
            sent: 0,
            failed: 0,
            blocked: 0,
            undeliverable: 0,
            retries: 0
        };
        jest.spyOn(Date, 'now').mockReturnValue(fixedNow);
    });

    afterEach(() => {
        Date.now.mockRestore();
    });

    test('uses preferred worker for misc within 24h (sticky)', async () => {
        mockState.affinityByUser.set(mockUserKey('g1', 'u1'), {
            preferred_worker_id: 'w1',
            preferred_worker_last_dm_at: fixedNow - (2 * 60 * 60 * 1000),
            consecutive_misc_count: 2
        });
        const t = makeTarget({ message_type: 'misc', user_id: 'u1' });
        const { client, send } = makeClient();

        const result = await dmWorker.processTarget(t, client, 'w1');

        expect(result.ok).toBe(true);
        expect(result.sent).toBe(true);
        expect(client.guilds.fetch).toHaveBeenCalledWith('g1');
        expect(send).toHaveBeenCalledWith('hello');
        expect(mockState.campaignCounters.sent).toBe(1);
    });

    test('reassigns misc target to preferred worker when claimed by different worker', async () => {
        mockState.affinityByUser.set(mockUserKey('g1', 'u1'), {
            preferred_worker_id: 'w1',
            preferred_worker_last_dm_at: fixedNow - (60 * 60 * 1000),
            consecutive_misc_count: 1
        });
        const t = makeTarget({ message_type: 'misc', user_id: 'u1' });
        const { client, send } = makeClient();

        const result = await dmWorker.processTarget(t, client, 'w2');

        expect(result.ok).toBe(true);
        expect(result.sent).toBe(false);
        expect(result.reassignedTo).toBe('w1');
        expect(send).not.toHaveBeenCalled();
        const reassignUpdate = mockState.targetUpdates.find((u) =>
            u.targetId === 1
            && u.update.status === 'pending'
            && u.update.assigned_worker_id === 'w1'
        );
        expect(reassignUpdate).toBeTruthy();
    });

    test('rotates misc after streak cap (4 consecutive)', async () => {
        mockState.affinityByUser.set(mockUserKey('g1', 'u1'), {
            preferred_worker_id: 'w1',
            preferred_worker_last_dm_at: fixedNow - (5 * 60 * 1000),
            consecutive_misc_count: 4
        });
        const t = makeTarget({ message_type: 'misc', user_id: 'u1' });
        const { client, send } = makeClient();

        const result = await dmWorker.processTarget(t, client, 'w1');

        expect(result.ok).toBe(true);
        expect(result.sent).toBe(false);
        expect(result.reassignedTo).toBe('w2');
        expect(send).not.toHaveBeenCalled();
    });

    test('keeps war messages sticky to war worker', async () => {
        mockState.affinityByUser.set(mockUserKey('g1', 'u1'), {
            war_worker_id: 'w2',
            war_last_dm_at: fixedNow - (3 * 60 * 60 * 1000)
        });
        const t = makeTarget({ message_type: 'war_late', user_id: 'u1' });
        const { client, send } = makeClient();

        const result = await dmWorker.processTarget(t, client, 'w1');

        expect(result.ok).toBe(true);
        expect(result.sent).toBe(false);
        expect(result.reassignedTo).toBe('w2');
        expect(send).not.toHaveBeenCalled();
    });

    test('reassigns to another worker when preferred is blocked for user', async () => {
        mockState.affinityByUser.set(mockUserKey('g1', 'u1'), {
            preferred_worker_id: 'w1',
            preferred_worker_last_dm_at: fixedNow - (10 * 60 * 1000),
            consecutive_misc_count: 1
        });
        mockState.blockedByUser.set(mockUserKey('g1', 'u1'), new Set(['w1']));
        const t = makeTarget({ message_type: 'misc', user_id: 'u1' });
        const { client, send } = makeClient();

        const result = await dmWorker.processTarget(t, client, 'w1');

        expect(result.ok).toBe(true);
        expect(result.sent).toBe(false);
        expect(result.reassignedTo).toBe('w2');
        expect(send).not.toHaveBeenCalled();
    });

    test('marks undeliverable when no eligible worker exists', async () => {
        mockState.blockedByUser.set(mockUserKey('g1', 'u1'), new Set(['w1', 'w2']));
        const t = makeTarget({ message_type: 'misc', user_id: 'u1' });
        const { client, send } = makeClient();

        const result = await dmWorker.processTarget(t, client, 'w1');

        expect(result.ok).toBe(false);
        expect(result.sent).toBe(false);
        expect(result.category).toBe('no_eligible_worker');
        expect(send).not.toHaveBeenCalled();
        expect(mockState.campaignCounters.undeliverable).toBe(1);
        const terminal = mockState.targetUpdates.find((u) =>
            u.targetId === 1
            && u.update.status === 'undeliverable'
            && u.update.last_error_code === 'NO_ELIGIBLE_WORKER'
        );
        expect(terminal).toBeTruthy();
    });
});

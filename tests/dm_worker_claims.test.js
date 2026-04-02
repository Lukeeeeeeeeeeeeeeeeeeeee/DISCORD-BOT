'use strict';

const mockState = {
    claimSql: null
};

jest.mock('../src/db_async', () => ({
    get: jest.fn(async (sql) => {
        if (sql.includes('FROM dm_global_backoff')) return null;
        return null;
    }),
    all: jest.fn(async (sql) => {
        if (sql.includes('WHERE t.claim_id = ?')) {
            return [{
                id: 1,
                campaign_id: 10,
                guild_id: 'g1',
                user_id: 'u1',
                batch_no: 1,
                attempts: 0,
                worker_switches: 0,
                message_type: 'misc',
                message_body: 'hello',
                max_misc_streak: 4,
                sticky_window_hours: 24
            }];
        }
        return [];
    }),
    run: jest.fn(async (sql) => {
        if (sql.includes("SET status = 'claimed'")) {
            mockState.claimSql = sql;
        }
        return { changes: 1 };
    })
}));

jest.mock('../src/lib/logger', () => ({
    logUnexpectedError: jest.fn(),
    logRuntimeEvent: jest.fn()
}));

const { DMWorker } = require('../src/services/dm/dm-worker');

describe('dm-worker claim compatibility', () => {
    beforeEach(() => {
        mockState.claimSql = null;
    });

    test('claimTargets can claim legacy retry_wait targets', async () => {
        const worker = new DMWorker({}, 'w1', 'Worker 1');

        const rows = await worker.claimTargets(1);

        expect(rows).toHaveLength(1);
        expect(mockState.claimSql).toContain("status IN ('pending', 'retry_wait')");
    });
});

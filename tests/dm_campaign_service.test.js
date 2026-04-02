/**
 * Tests for DM Campaign Service — campaign creation, status, cancel, report
 */
'use strict';

// Mock db_async before requiring the service
jest.mock('../src/db_async', () => {
    let lastId = 0;
    let mockWorkerCount = 1;

    return {
        run: jest.fn(async (sql, ...params) => {
            if (sql.includes('INSERT INTO dm_campaigns')) {
                lastId++;
                return { lastID: lastId, changes: 1 };
            }
            if (sql.includes('INSERT OR IGNORE INTO dm_campaign_targets')) {
                return { changes: params.length / 7 };
            }
            if (sql.includes('UPDATE dm_campaign_targets')) {
                return { changes: 3 };
            }
            if (sql.includes('UPDATE dm_campaigns')) {
                return { changes: 1 };
            }
            if (sql.includes('DELETE FROM dm_worker_user_blocks')) {
                return { changes: 1 };
            }
            return { changes: 0 };
        }),
        get: jest.fn(async (sql, ...params) => {
            if (sql.includes('COUNT(*) AS worker_count FROM dm_workers')) {
                return { worker_count: mockWorkerCount };
            }
            if (sql.includes("status IN ('queued', 'running')") || sql.includes('message_hash')) {
                return null;
            }
            if (sql.includes('FROM dm_campaigns')) {
                return {
                    id: params[0],
                    guild_id: 'g1',
                    requested_by: 'u1',
                    message_type: 'misc',
                    message_body: 'test',
                    target_mode: 'everyone',
                    status: 'completed',
                    total_targets: 5,
                    total_sent: 3,
                    total_failed: 1,
                    total_blocked: 1,
                    total_retries: 2,
                    created_at: Date.now(),
                    finished_at: Date.now()
                };
            }
            return null;
        }),
        all: jest.fn(async (sql) => {
            if (sql.includes('GROUP BY status')) {
                return [
                    { status: 'sent', count: 3 },
                    { status: 'failed', count: 1 },
                    { status: 'blocked', count: 1 }
                ];
            }
            if (sql.includes('GROUP BY assigned_worker_id')) {
                return [{ assigned_worker_id: 'w1', status: 'sent', count: 3 }];
            }
            if (sql.includes('GROUP BY da.worker_id')) {
                return [{ worker_id: 'w1', result: 'sent', count: 3 }];
            }
            if (sql.includes('FROM dm_user_affinity')) {
                return [];
            }
            if (sql.includes('FROM dm_worker_user_blocks')) {
                return [];
            }
            if (sql.includes("status = 'blocked'")) {
                return [{ user_id: 'u99', blocked_by_worker_id: 'w1', last_error_code: '50007' }];
            }
            if (sql.includes("status = 'undeliverable'")) {
                return [{ user_id: 'u77', last_error_code: '50007' }];
            }
            if (sql.includes("status = 'failed'")) {
                return [{ user_id: 'u55', assigned_worker_id: 'w2', last_error_code: 'TIMEOUT' }];
            }
            if (sql.includes('FROM dm_workers')) {
                if (sql.includes("status = 'online'")) {
                    return [
                        { worker_id: 'w1', display_name: 'Worker 1', enabled: 1, weight: 1, status: 'online', last_seen_at: Date.now() }
                    ];
                }
                return [
                    { worker_id: 'w1', display_name: 'Worker 1', enabled: 1, weight: 1, status: 'online', last_seen_at: Date.now() },
                    { worker_id: 'w2', display_name: 'Worker 2', enabled: 1, weight: 1, status: 'offline', last_seen_at: Date.now() }
                ];
            }
            if (sql.includes('report_posted = 0')) {
                return [];
            }
            return [];
        }),
        _reset: () => { lastId = 0; mockWorkerCount = 1; },
        _setWorkerCount: (count) => { mockWorkerCount = Number(count) || 1; }
    };
});

// Mock logger
jest.mock('../src/lib/logger', () => ({
    logUnexpectedError: jest.fn(),
    logRuntimeEvent: jest.fn()
}));

const { Collection } = require('discord.js');

const campaignService = require('../src/services/dm/dm-campaign-service');
const db = require('../src/db_async');

function makeGuild(members = []) {
    const col = new Collection(members.map(m => [m.id, m]));
    return {
        id: 'guild-1',
        members: {
            cache: col,
            fetch: jest.fn().mockResolvedValue(col)
        }
    };
}

function makeMember(id, roleIds = [], bot = false) {
    return {
        id,
        user: { bot },
        roles: {
            cache: {
                has: (rid) => roleIds.includes(rid),
                some: (fn) => roleIds.some(rid => fn({ id: rid })),
                filter: (fn) => roleIds.filter(rid => fn({ id: rid }))
            }
        }
    };
}

describe('dm-campaign-service', () => {
    const envSnapshot = {
        DM_BATCH_STRATEGY: process.env.DM_BATCH_STRATEGY,
        DM_BATCHES_PER_WORKER: process.env.DM_BATCHES_PER_WORKER,
        DM_INSERT_BATCH_SIZE: process.env.DM_INSERT_BATCH_SIZE,
        DM_MIN_INSERT_BATCH_SIZE: process.env.DM_MIN_INSERT_BATCH_SIZE,
        DM_MAX_INSERT_BATCH_SIZE: process.env.DM_MAX_INSERT_BATCH_SIZE,
        DM_PREASSIGN_TARGETS: process.env.DM_PREASSIGN_TARGETS
    };

    beforeEach(() => {
        jest.clearAllMocks();
        db._reset();
        process.env.DM_BATCH_STRATEGY = 'fixed';
        process.env.DM_INSERT_BATCH_SIZE = '25';
        process.env.DM_PREASSIGN_TARGETS = 'true';
        delete process.env.DM_BATCHES_PER_WORKER;
        delete process.env.DM_MIN_INSERT_BATCH_SIZE;
        delete process.env.DM_MAX_INSERT_BATCH_SIZE;
    });

    afterAll(() => {
        if (envSnapshot.DM_BATCH_STRATEGY === undefined) delete process.env.DM_BATCH_STRATEGY;
        else process.env.DM_BATCH_STRATEGY = envSnapshot.DM_BATCH_STRATEGY;
        if (envSnapshot.DM_BATCHES_PER_WORKER === undefined) delete process.env.DM_BATCHES_PER_WORKER;
        else process.env.DM_BATCHES_PER_WORKER = envSnapshot.DM_BATCHES_PER_WORKER;
        if (envSnapshot.DM_INSERT_BATCH_SIZE === undefined) delete process.env.DM_INSERT_BATCH_SIZE;
        else process.env.DM_INSERT_BATCH_SIZE = envSnapshot.DM_INSERT_BATCH_SIZE;
        if (envSnapshot.DM_MIN_INSERT_BATCH_SIZE === undefined) delete process.env.DM_MIN_INSERT_BATCH_SIZE;
        else process.env.DM_MIN_INSERT_BATCH_SIZE = envSnapshot.DM_MIN_INSERT_BATCH_SIZE;
        if (envSnapshot.DM_MAX_INSERT_BATCH_SIZE === undefined) delete process.env.DM_MAX_INSERT_BATCH_SIZE;
        else process.env.DM_MAX_INSERT_BATCH_SIZE = envSnapshot.DM_MAX_INSERT_BATCH_SIZE;
        if (envSnapshot.DM_PREASSIGN_TARGETS === undefined) delete process.env.DM_PREASSIGN_TARGETS;
        else process.env.DM_PREASSIGN_TARGETS = envSnapshot.DM_PREASSIGN_TARGETS;
    });

    describe('createCampaign', () => {
        test('creates campaign and targets for role-based targeting', async () => {
            const members = [
                makeMember('u1', ['role-a']),
                makeMember('u2', ['role-a']),
                makeMember('u3', ['role-b']),
                makeMember('bot1', ['role-a'], true)
            ];
            const guild = makeGuild(members);

            const result = await campaignService.createCampaign({
                guild,
                requestedBy: 'admin1',
                messageType: 'misc',
                messageBody: 'Hello everyone!',
                targetMode: 'any_roles',
                roleIds: ['role-a']
            });

            expect(result.campaignId).toBe(1);
            expect(result.totalTargets).toBe(2); // u1, u2 (not bot, not u3)
            expect(result.totalBatches).toBe(1);
            expect(result.preview).toBe(false);
        });

        test('wraps campaign writes in a transaction', async () => {
            const guild = makeGuild([makeMember('u1', ['role-a'])]);

            await campaignService.createCampaign({
                guild,
                requestedBy: 'admin1',
                messageType: 'misc',
                messageBody: 'Atomic write test',
                targetMode: 'any_roles',
                roleIds: ['role-a']
            });

            const sqls = db.run.mock.calls.map((call) => call[0]);
            expect(sqls).toContain('BEGIN IMMEDIATE');
            expect(sqls).toContain('COMMIT');
        });

        test('preview does not write to DB', async () => {
            const members = [makeMember('u1', ['r1']), makeMember('u2', ['r1'])];
            const guild = makeGuild(members);

            const result = await campaignService.createCampaign({
                guild,
                requestedBy: 'admin1',
                messageType: 'misc',
                messageBody: 'Preview test',
                targetMode: 'any_roles',
                roleIds: ['r1'],
                preview: true
            });

            expect(result.preview).toBe(true);
            expect(result.campaignId).toBeNull();
            expect(result.totalTargets).toBe(2);
            expect(result.sampleUserIds).toEqual(['u1', 'u2']);
            // DB run should not have been called for campaign insert
            const insertCalls = db.run.mock.calls.filter(c => c[0].includes('INSERT INTO dm_campaigns'));
            expect(insertCalls.length).toBe(0);
        });

        test('targets everyone mode', async () => {
            const members = [
                makeMember('u1', []),
                makeMember('u2', []),
                makeMember('bot1', [], true)
            ];
            const guild = makeGuild(members);

            const result = await campaignService.createCampaign({
                guild,
                requestedBy: 'admin1',
                messageType: 'war_early',
                messageBody: 'War in 1 day!',
                targetMode: 'everyone',
                roleIds: []
            });

            expect(result.totalTargets).toBe(2); // no bots
        });

        test('returns 0 targets when no matches', async () => {
            const guild = makeGuild([makeMember('bot1', [], true)]);

            const result = await campaignService.createCampaign({
                guild,
                requestedBy: 'admin1',
                messageType: 'misc',
                messageBody: 'test',
                targetMode: 'everyone'
            });

            expect(result.totalTargets).toBe(0);
            expect(result.campaignId).toBeNull();
        });

        test('validates message type', async () => {
            const guild = makeGuild([]);
            await expect(campaignService.createCampaign({
                guild,
                requestedBy: 'a',
                messageType: 'invalid',
                messageBody: 'x',
                targetMode: 'everyone'
            })).rejects.toThrow('Invalid message_type');
        });

        test('validates target mode', async () => {
            const guild = makeGuild([]);
            await expect(campaignService.createCampaign({
                guild,
                requestedBy: 'a',
                messageType: 'misc',
                messageBody: 'x',
                targetMode: 'bad_mode'
            })).rejects.toThrow('Invalid target_mode');
        });

        test('validates message length', async () => {
            const guild = makeGuild([]);
            await expect(campaignService.createCampaign({
                guild,
                requestedBy: 'a',
                messageType: 'misc',
                messageBody: 'x'.repeat(3001),
                targetMode: 'everyone'
            })).rejects.toThrow('3000 characters');
        });

        test('requires roleIds when not everyone mode', async () => {
            const guild = makeGuild([]);
            await expect(campaignService.createCampaign({
                guild,
                requestedBy: 'a',
                messageType: 'misc',
                messageBody: 'x',
                targetMode: 'any_roles',
                roleIds: []
            })).rejects.toThrow('At least one roleId');
        });

        test('supports worker-based batch splitting for parallel worker fleets', async () => {
            process.env.DM_BATCH_STRATEGY = 'workers';
            process.env.DM_BATCHES_PER_WORKER = '2';
            process.env.DM_MIN_INSERT_BATCH_SIZE = '1';
            process.env.DM_MAX_INSERT_BATCH_SIZE = '100';
            db._setWorkerCount(2);

            const members = Array.from({ length: 10 }).map((_, idx) => makeMember(`u${idx + 1}`, ['role-a']));
            const guild = makeGuild(members);

            const result = await campaignService.createCampaign({
                guild,
                requestedBy: 'admin1',
                messageType: 'misc',
                messageBody: 'Parallel workers test',
                targetMode: 'any_roles',
                roleIds: ['role-a']
            });

            expect(result.totalTargets).toBe(10);
            expect(result.totalBatches).toBe(4);
        });

        test('preassigns target rows to online workers when queue preassignment is enabled', async () => {
            const members = [
                makeMember('u1', ['role-a']),
                makeMember('u2', ['role-a'])
            ];
            const guild = makeGuild(members);

            await campaignService.createCampaign({
                guild,
                requestedBy: 'admin1',
                messageType: 'misc',
                messageBody: 'Preassign test',
                targetMode: 'any_roles',
                roleIds: ['role-a']
            });

            const targetInsert = db.run.mock.calls.find((call) =>
                call[0].includes('INSERT OR IGNORE INTO dm_campaign_targets')
            );
            expect(targetInsert).toBeTruthy();
            expect(targetInsert[0]).toContain('assigned_worker_id');
            expect(targetInsert[4]).toBe('w1');
            expect(targetInsert[11]).toBe('w1');
        });
    });

    describe('getCampaignStatus', () => {
        test('returns campaign with status counts', async () => {
            const result = await campaignService.getCampaignStatus(1);
            expect(result).not.toBeNull();
            expect(result.campaign.id).toBe(1);
            expect(result.statusCounts.sent).toBe(3);
            expect(result.statusCounts.failed).toBe(1);
        });
    });

    describe('cancelCampaign', () => {
        test('cancels pending targets', async () => {
            const result = await campaignService.cancelCampaign(1);
            expect(result.cancelledTargets).toBe(3);
            expect(db.run).toHaveBeenCalledWith(
                expect.stringContaining("status = 'cancelled'"),
                expect.any(Number),
                1
            );
            expect(db.run.mock.calls[0][0]).toContain("'retry_wait'");
            expect(db.run.mock.calls[0][0]).toContain('claim_id = NULL');
            expect(db.run.mock.calls[0][0]).toContain('next_attempt_at = NULL');
        });
    });

    describe('getReport', () => {
        test('returns full report with all user lists', async () => {
            const result = await campaignService.getReport(1);
            expect(result).not.toBeNull();
            expect(result.blockedUsers).toHaveLength(1);
            expect(result.undeliverableUsers).toHaveLength(1);
            expect(result.failedUsers).toHaveLength(1);
        });
    });

    describe('listWorkers', () => {
        test('returns worker list', async () => {
            const result = await campaignService.listWorkers();
            expect(result).toHaveLength(2);
            expect(result[0].worker_id).toBe('w1');
        });
    });

    describe('setWorkerEnabled', () => {
        test('disables a worker', async () => {
            await campaignService.setWorkerEnabled('w1', false);
            expect(db.run).toHaveBeenCalledWith(
                expect.stringContaining('UPDATE dm_workers SET enabled'),
                0,
                expect.any(Number),
                'w1'
            );
        });
    });

    describe('unblockUserForWorker', () => {
        test('deletes block record', async () => {
            await campaignService.unblockUserForWorker('g1', 'u1', 'w1');
            expect(db.run).toHaveBeenCalledWith(
                expect.stringContaining('DELETE FROM dm_worker_user_blocks'),
                'g1', 'u1', 'w1'
            );
        });
    });
});

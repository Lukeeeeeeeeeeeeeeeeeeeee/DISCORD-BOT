'use strict';

jest.mock('../src/db_async', () => ({
    get: jest.fn(),
    all: jest.fn(),
    run: jest.fn()
}));

jest.mock('../src/services/dm/dm-campaign-service', () => ({
    getReport: jest.fn(),
    markReportPosted: jest.fn(),
    incrementReportAttempts: jest.fn(),
    getUnreportedCampaigns: jest.fn(),
    getRunningCampaigns: jest.fn(),
    updateCampaignNotificationThreshold: jest.fn()
}));

jest.mock('../src/lib/logger', () => ({
    logUnexpectedError: jest.fn(),
    logRuntimeEvent: jest.fn()
}));

const { buildReportEmbed } = require('../src/services/dm/dm-reporter');

describe('dm-reporter', () => {
    test('renders explicit worker failure categories and corrected user sections', () => {
        const embed = buildReportEmbed({
            campaign: {
                id: 10,
                message_type: 'system_welcome',
                requested_by: '123',
                target_mode: 'direct',
                total_targets: 1,
                total_retries: 0,
                created_at: Date.now(),
                finished_at: Date.now()
            },
            statusCounts: {
                undeliverable: 1
            },
            workerBreakdown: [
                { worker_id: 'worker_node_1', result: 'no_mutual_guild', count: 1 },
                { worker_id: 'worker_node_1', result: 'missing_access_or_perms', count: 2 }
            ],
            blockedUsers: [],
            undeliverableUsers: [
                { user_id: 'u1', last_error_code: '50278' }
            ],
            failedUsers: [
                { user_id: 'u2', assigned_worker_id: 'main', last_error_code: '50013' }
            ],
            sentUsers: []
        });

        const overviewField = embed.fields.find((field) => field.name === '📋 Overview');
        const workerField = embed.fields.find((field) => field.name === '🤖 Worker Breakdown');
        const undeliverableField = embed.fields.find((field) => field.name === '❌ Undeliverable Users (1)');
        const failedField = embed.fields.find((field) => field.name === '⚠️ Failed Users (1)');

        expect(overviewField.value).toContain('👋 System Welcome');
        expect(workerField.value).toContain('`worker_node_1`: 🔗 1 | 🔒 2');
        expect(undeliverableField.value).toContain('<@u1> — all workers exhausted (50278)');
        expect(failedField.value).toContain('<@u2> — via `main` (50013)');
    });
});

'use strict';

const { buildRuntimeConfig } = require('../src/lib/runtime-config');

describe('runtime-config', () => {
    const originalEnableInternalWorker = process.env.ENABLE_INTERNAL_WORKER;

    afterEach(() => {
        if (originalEnableInternalWorker === undefined) delete process.env.ENABLE_INTERNAL_WORKER;
        else process.env.ENABLE_INTERNAL_WORKER = originalEnableInternalWorker;
    });

    test('disables the internal worker by default', () => {
        delete process.env.ENABLE_INTERNAL_WORKER;
        const config = buildRuntimeConfig({});
        expect(config.enableInternalWorker).toBe(false);
    });

    test('allows enabling the internal worker explicitly', () => {
        process.env.ENABLE_INTERNAL_WORKER = 'true';
        const config = buildRuntimeConfig({});
        expect(config.enableInternalWorker).toBe(true);
    });
});

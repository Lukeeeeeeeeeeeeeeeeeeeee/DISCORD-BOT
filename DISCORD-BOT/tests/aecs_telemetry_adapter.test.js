const { TelemetryAdapter } = require('../src/lib/aecs/telemetry-adapter');

function makeRecord(overrides = {}) {
  return {
    timestamp: Date.now(),
    code: 'DB-104',
    title: 'Constraint Violation',
    message: 'write failed',
    severity: 'ERROR',
    impact: 95,
    domain: 'DB',
    scope: 'service.recruit.execute',
    supportId: 'EAFSRHD',
    traceId: 'tx-123',
    meta: { table: 'recruits' },
    stack: 'Error: write failed',
    ...overrides
  };
}

describe('AECS telemetry adapter', () => {
  test('routes fatal events to fatal webhook and includes support lookup', async () => {
    const calls = [];
    const adapter = new TelemetryAdapter({
      defaultWebhookUrl: 'https://example.com/default',
      fatalWebhookUrl: 'https://example.com/fatal',
      highImpactWebhookUrl: 'https://example.com/high',
      channelId: '1412808632176869523',
      impactThreshold: 90,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 204 };
      }
    });

    await adapter.send(makeRecord({ severity: 'FATAL', impact: 100 }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/fatal');

    const payload = JSON.parse(calls[0].init.body);
    expect(payload.content).toContain('Support ID: EAFSRHD');
    const lookupField = payload.embeds[0].fields.find((field) => field.name === 'Lookup');
    expect(lookupField.value).toContain('<#1412808632176869523>');
    expect(lookupField.value).toContain('EAFSRHD');
  });

  test('routes high-impact non-fatal events to high-impact webhook', async () => {
    const calls = [];
    const adapter = new TelemetryAdapter({
      defaultWebhookUrl: 'https://example.com/default',
      highImpactWebhookUrl: 'https://example.com/high',
      impactThreshold: 90,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 204 };
      }
    });

    await adapter.send(makeRecord({ severity: 'ERROR', impact: 92 }));

    expect(calls).toHaveLength(1);
    expect(calls[0].url).toBe('https://example.com/high');
  });

  test('suppresses low-impact events by policy', async () => {
    const calls = [];
    const adapter = new TelemetryAdapter({
      defaultWebhookUrl: 'https://example.com/default',
      impactThreshold: 90,
      fetchImpl: async (url, init) => {
        calls.push({ url, init });
        return { ok: true, status: 204 };
      }
    });

    const result = await adapter.send(makeRecord({ severity: 'WARN', impact: 20 }));

    expect(result.sent).toBe(false);
    expect(result.reason).toBe('policy');
    expect(calls).toHaveLength(0);
  });
});

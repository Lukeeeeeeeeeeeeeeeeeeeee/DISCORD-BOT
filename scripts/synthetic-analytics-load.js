#!/usr/bin/env node
const analytics = require('../src/lib/analytics');

const EVENT_COUNT = Number.parseInt(process.env.SYNTH_ANALYTICS_EVENTS || '2000', 10);
const GUILD_ID = process.env.SYNTH_ANALYTICS_GUILD_ID || 'SYNTH_GUILD';
const MAX_LAG_MS = Number.parseInt(process.env.SYNTH_ANALYTICS_MAX_LAG_MS || '300', 10);

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function main() {
  const start = Date.now();
  let maxLagMs = 0;
  let expected = Date.now() + 100;
  const lagTimer = setInterval(() => {
    const now = Date.now();
    const lag = now - expected;
    if (lag > maxLagMs) maxLagMs = lag;
    expected = now + 100;
  }, 100);
  if (typeof lagTimer.unref === 'function') lagTimer.unref();

  for (let i = 0; i < EVENT_COUNT; i++) {
    await analytics.recordRoleChange({
      guildId: GUILD_ID,
      userId: `U${i % 250}`,
      roleId: `R${i % 30}`,
      roleName: `Role-${i % 30}`,
      action: i % 2 === 0 ? 'added' : 'removed',
      timestamp: Date.now()
    });
  }
  const enqueueMs = Date.now() - start;

  await analytics.flushRoleChanges({ forceAll: true });
  await analytics.flushAll();
  await sleep(125);
  clearInterval(lagTimer);

  const totalMs = Date.now() - start;
  console.log('Synthetic analytics load complete.', {
    events: EVENT_COUNT,
    enqueueMs,
    totalMs,
    maxLagMs
  });

  if (maxLagMs > MAX_LAG_MS) {
    console.error('Event loop lag exceeded threshold', { maxLagMs, thresholdMs: MAX_LAG_MS });
    process.exitCode = 1;
  }
}

main().catch((err) => {
  console.error('synthetic analytics load failed:', err);
  process.exit(1);
});

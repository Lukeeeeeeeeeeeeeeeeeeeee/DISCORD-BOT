require('dotenv').config();
const path = require('path');
const { ShardingManager } = require('discord.js');
const { sanitizeEnvToken, validateRuntimeEnvironment } = require('./lib/env');

validateRuntimeEnvironment({ minNodeMajor: 18 });

const token = sanitizeEnvToken(process.env.DISCORD_TOKEN);
if (!token) {
  console.error('FATAL: DISCORD_TOKEN is missing from environment.');
  process.exit(1);
}

const shardCountRaw = process.env.SHARD_COUNT;
const shardCount = shardCountRaw ? Number.parseInt(shardCountRaw, 10) : 'auto';

const manager = new ShardingManager(path.resolve(__dirname, 'index.js'), {
  token,
  totalShards: shardCount,
  respawn: true
});

const lastHeartbeat = new Map();
const respawnInProgress = new Set();

manager.on('shardCreate', shard => {
  console.log(`Launched shard ${shard.id}`);
  lastHeartbeat.set(shard.id, Date.now());
  shard.on('message', (msg) => {
    if (msg && msg.type === 'heartbeat') {
      lastHeartbeat.set(shard.id, Number(msg.timestamp) || Date.now());
    }
  });
  shard.on('death', () => {
    lastHeartbeat.delete(shard.id);
    respawnInProgress.delete(shard.id);
  });
});

const heartbeatCheckMs = Number.parseInt(process.env.SHARD_HEARTBEAT_CHECK_MS || '30000', 10);
const heartbeatTimeoutMs = Number.parseInt(process.env.SHARD_HEARTBEAT_TIMEOUT_MS || '180000', 10);
const safeHeartbeatCheckMs = Number.isFinite(heartbeatCheckMs) && heartbeatCheckMs > 0 ? heartbeatCheckMs : 30000;
const safeHeartbeatTimeoutMs = Number.isFinite(heartbeatTimeoutMs) && heartbeatTimeoutMs > 0 ? heartbeatTimeoutMs : 180000;

const heartbeatTimer = setInterval(async () => {
  const now = Date.now();
  for (const shard of manager.shards.values()) {
    const seenAt = lastHeartbeat.get(shard.id) || 0;
    if (respawnInProgress.has(shard.id)) continue;
    if (seenAt > 0 && (now - seenAt) <= safeHeartbeatTimeoutMs) continue;
    respawnInProgress.add(shard.id);
    console.error(`Shard ${shard.id} heartbeat stale. Respawning shard.`);
    try {
      try {
        await shard.send({ type: 'shutdown', signal: 'HEARTBEAT_STALE' });
        await new Promise(resolve => setTimeout(resolve, 2000));
      } catch (e) {
        // Best effort; continue with respawn even if graceful signal failed.
        console.error(e);
      }
      await shard.respawn({ delay: 1_000, timeout: 30_000 });
      lastHeartbeat.set(shard.id, Date.now());
    } catch (e) {
      console.error(`Failed to respawn shard ${shard.id}:`, e);
    } finally {
      respawnInProgress.delete(shard.id);
    }
  }
}, safeHeartbeatCheckMs);
if (typeof heartbeatTimer.unref === 'function') heartbeatTimer.unref();

let shuttingDown = false;
async function gracefulShutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`Shard manager received ${signal}. Sending graceful shutdown to shards...`);
  try {
    const tasks = [];
    for (const shard of manager.shards.values()) {
      tasks.push(
        Promise.resolve()
          .then(() => shard.send({ type: 'shutdown', signal }))
          .catch((e) => {
            console.error(`Failed to send shutdown signal to shard ${shard.id}:`, e);
          })
      );
    }
    await Promise.all(tasks);
    await new Promise(resolve => setTimeout(resolve, 3000));
  } finally {
    process.exit(0);
  }
}

process.on('SIGINT', () => gracefulShutdown('SIGINT').catch(err => console.error('Graceful shutdown (SIGINT) failed:', err)));
process.on('SIGTERM', () => gracefulShutdown('SIGTERM').catch(err => console.error('Graceful shutdown (SIGTERM) failed:', err)));

manager.spawn().catch(err => {
  console.error('Failed to spawn shards:', err);
  process.exit(1);
});


require('dotenv').config();
const path = require('path');
const { ShardingManager } = require('discord.js');

const rawToken = process.env.DISCORD_TOKEN;
const token = rawToken ? rawToken.trim().replace(/^"(.+)"$/, '$1') : null;
if (!token) {
  console.error('FATAL: DISCORD_TOKEN is missing from environment.');
  process.exit(1);
}

const shardCountRaw = process.env.SHARD_COUNT;
const shardCount = shardCountRaw ? Number.parseInt(shardCountRaw, 10) : 'auto';

const manager = new ShardingManager(path.join(__dirname, 'index.js'), {
  token,
  totalShards: shardCount,
  respawn: true
});

manager.on('shardCreate', shard => {
  console.log(`Launched shard ${shard.id}`);
});

manager.spawn().catch(err => {
  console.error('Failed to spawn shards:', err);
  process.exit(1);
});

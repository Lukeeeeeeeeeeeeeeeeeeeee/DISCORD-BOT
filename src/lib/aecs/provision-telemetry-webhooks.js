const { PermissionsBitField } = require('discord.js');

const WEBHOOK_URL_REGEX = /^https?:\/\/(?:canary\.|ptb\.)?discord(?:app)?\.com\/api\/webhooks\/(\d+)\/([^/?#]+)$/i;
const AUTO_CREATE_ENABLED_DEFAULT = true;

function toBool(value, fallback = AUTO_CREATE_ENABLED_DEFAULT) {
  if (value === undefined || value === null || String(value).trim() === '') return fallback;
  const normalized = String(value).trim().toLowerCase();
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function normalizeId(value) {
  if (value === undefined || value === null) return null;
  const text = String(value).trim();
  if (!text) return null;

  const mentionMatch = text.match(/^<#(\d+)>$/);
  if (mentionMatch) return mentionMatch[1];

  const channelUrlMatch = text.match(/\/channels\/\d+\/(\d+)/);
  if (channelUrlMatch) return channelUrlMatch[1];

  return text;
}

function parseWebhookUrl(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  const match = text.match(WEBHOOK_URL_REGEX);
  if (!match) return null;
  return {
    id: match[1],
    token: match[2],
    url: text
  };
}

function ensureUrlFromWebhook(webhook) {
  if (!webhook) return '';
  if (webhook.url) return String(webhook.url);
  if (webhook.id && webhook.token) {
    return `https://discord.com/api/webhooks/${webhook.id}/${webhook.token}`;
  }
  return '';
}

async function resolveTextChannel(client, channelId) {
  if (!client || !channelId) return null;
  const fromCache = client.channels && client.channels.cache
    ? client.channels.cache.get(channelId)
    : null;
  const channel = fromCache || await client.channels.fetch(channelId).catch(() => null);
  if (!channel) return null;
  if (typeof channel.isTextBased === 'function' && !channel.isTextBased()) return null;
  return channel;
}

function hasManageWebhooksPermission(channel, botUserId) {
  if (!channel || !botUserId || typeof channel.permissionsFor !== 'function') return true;
  const perms = channel.permissionsFor(botUserId);
  if (!perms || typeof perms.has !== 'function') return true;
  return perms.has(PermissionsBitField.Flags.ManageWebhooks);
}

function getCollectionEntry(collection, key) {
  if (!collection || !key) return null;
  if (typeof collection.get === 'function') {
    return collection.get(key) || null;
  }
  if (Array.isArray(collection)) {
    return collection.find((entry) => entry && String(entry.id) === String(key)) || null;
  }
  return null;
}

function findReusableWebhook(webhooks, { webhookId, name, botUserId }) {
  if (!webhooks) return null;

  if (webhookId) {
    const matchedById = getCollectionEntry(webhooks, webhookId);
    if (matchedById) return matchedById;
  }

  const values = typeof webhooks.values === 'function'
    ? Array.from(webhooks.values())
    : (Array.isArray(webhooks) ? webhooks : []);

  for (const webhook of values) {
    if (!webhook) continue;
    if (botUserId && webhook.owner && String(webhook.owner.id) !== String(botUserId)) continue;
    if (name && String(webhook.name || '').trim() !== String(name).trim()) continue;
    return webhook;
  }

  return null;
}

async function ensureWebhookForRoute({
  routeKey,
  client,
  channelId,
  existingUrl,
  name,
  cacheByChannel
}) {
  const resolvedChannelId = normalizeId(channelId);
  if (!resolvedChannelId) {
    return { routeKey, status: 'skipped', reason: 'missing_channel', url: existingUrl || '' };
  }

  const channel = await resolveTextChannel(client, resolvedChannelId);
  if (!channel) {
    return { routeKey, status: 'skipped', reason: 'channel_not_found', url: existingUrl || '' };
  }

  const botUserId = client && client.user ? client.user.id : null;
  if (!hasManageWebhooksPermission(channel, botUserId)) {
    return { routeKey, status: 'skipped', reason: 'missing_manage_webhooks', url: existingUrl || '' };
  }

  let webhooks = cacheByChannel.get(channel.id);
  if (!webhooks) {
    webhooks = await channel.fetchWebhooks().catch(() => null);
    cacheByChannel.set(channel.id, webhooks);
  }

  const parsedExisting = parseWebhookUrl(existingUrl);
  let webhook = findReusableWebhook(webhooks, {
    webhookId: parsedExisting ? parsedExisting.id : null,
    name,
    botUserId
  });

  if (!webhook) {
    webhook = await channel.createWebhook({
      name,
      reason: `AECS telemetry provisioning (${routeKey})`
    }).catch(() => null);
    if (!webhook) {
      return { routeKey, status: 'skipped', reason: 'create_failed', url: existingUrl || '' };
    }

    // Refresh cache after creation.
    webhooks = await channel.fetchWebhooks().catch(() => webhooks);
    cacheByChannel.set(channel.id, webhooks);
  }

  const url = ensureUrlFromWebhook(webhook);
  if (!url) {
    return { routeKey, status: 'skipped', reason: 'missing_webhook_token', url: existingUrl || '' };
  }

  const status = parsedExisting && parsedExisting.url === url ? 'reused' : (parsedExisting ? 'replaced' : 'created');
  return { routeKey, status, reason: null, url, channelId: channel.id, webhookId: webhook.id };
}

function buildRouteSpecFromEnv() {
  const defaultChannelId = normalizeId(process.env.AECS_TELEMETRY_CHANNEL_ID)
    || normalizeId(process.env.TELEMETRY_CHANNEL_ID)
    || normalizeId(process.env.LOG_CHANNEL_ID)
    || normalizeId(process.env.ANTINUKE_LOG_CHANNEL_ID)
    || normalizeId(process.env.DISCORD_LOG_CHANNEL_ID);
  const splitRoutes = toBool(process.env.AECS_TELEMETRY_SPLIT_WEBHOOKS, false);

  const fatalUrl = process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL || '';
  const highUrl = process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH || '';
  const fatalChannelExplicit = normalizeId(process.env.AECS_TELEMETRY_FATAL_CHANNEL_ID);
  const highChannelExplicit = normalizeId(process.env.AECS_TELEMETRY_HIGH_CHANNEL_ID);
  const fatalNameExplicit = process.env.AECS_TELEMETRY_WEBHOOK_NAME_FATAL || '';
  const highNameExplicit = process.env.AECS_TELEMETRY_WEBHOOK_NAME_HIGH || '';

  const provisionFatal = Boolean(fatalUrl || fatalChannelExplicit || fatalNameExplicit || splitRoutes);
  const provisionHigh = Boolean(highUrl || highChannelExplicit || highNameExplicit || splitRoutes);

  return [
    {
      key: 'default',
      url: process.env.AECS_TELEMETRY_WEBHOOK_URL || '',
      channelId: defaultChannelId,
      name: process.env.AECS_TELEMETRY_WEBHOOK_NAME || 'AECS Telemetry'
    },
    {
      key: 'fatal',
      url: fatalUrl,
      channelId: fatalChannelExplicit || (splitRoutes ? defaultChannelId : null),
      name: fatalNameExplicit || 'AECS Telemetry Fatal',
      provision: provisionFatal
    },
    {
      key: 'high',
      url: highUrl,
      channelId: highChannelExplicit || (splitRoutes ? defaultChannelId : null),
      name: highNameExplicit || 'AECS Telemetry High',
      provision: provisionHigh
    }
  ];
}

async function provisionTelemetryWebhooks(client, options = {}) {
  const autoCreate = options.autoCreate !== undefined
    ? Boolean(options.autoCreate)
    : toBool(process.env.AECS_AUTO_CREATE_WEBHOOK, AUTO_CREATE_ENABLED_DEFAULT);
  if (!autoCreate) {
    return { changed: false, skipped: true, reason: 'disabled', routes: [], config: null };
  }
  if (!client) {
    return { changed: false, skipped: true, reason: 'missing_client', routes: [], config: null };
  }

  const routeSpec = buildRouteSpecFromEnv();
  const routeSpecByKey = new Map(routeSpec.map((entry) => [entry.key, entry]));
  const cacheByChannel = new Map();
  const results = [];

  for (const route of routeSpec) {
    if (route.key !== 'default' && route.provision === false && !route.url) {
      results.push({
        routeKey: route.key,
        status: 'skipped',
        reason: 'reuse_default',
        url: ''
      });
      continue;
    }
    const result = await ensureWebhookForRoute({
      routeKey: route.key,
      client,
      channelId: route.channelId,
      existingUrl: route.url,
      name: route.name,
      cacheByChannel
    });
    results.push(result);
  }

  const defaultRoute = results.find((entry) => entry.routeKey === 'default');
  const fatalRoute = results.find((entry) => entry.routeKey === 'fatal');
  const highRoute = results.find((entry) => entry.routeKey === 'high');

  const telemetryWebhookUrl = defaultRoute && defaultRoute.url ? defaultRoute.url : (process.env.AECS_TELEMETRY_WEBHOOK_URL || '');
  const telemetryFatalWebhookUrl = fatalRoute && fatalRoute.url
    ? fatalRoute.url
    : (process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL || telemetryWebhookUrl);
  const telemetryHighImpactWebhookUrl = highRoute && highRoute.url
    ? highRoute.url
    : (process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH || telemetryWebhookUrl);

  const primaryChannelId = (defaultRoute && defaultRoute.channelId) || normalizeId(process.env.AECS_TELEMETRY_CHANNEL_ID) || '';

  const config = {
    telemetryWebhookUrl,
    telemetryFatalWebhookUrl,
    telemetryHighImpactWebhookUrl,
    telemetryChannelId: primaryChannelId
  };

  const envDefaultUrl = process.env.AECS_TELEMETRY_WEBHOOK_URL || '';
  const envFatalUrl = process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL || '';
  const envHighUrl = process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH || '';
  const envChannelId = process.env.AECS_TELEMETRY_CHANNEL_ID || '';

  const fatalSpec = routeSpecByKey.get('fatal');
  const highSpec = routeSpecByKey.get('high');
  const shouldPersistFatal = Boolean((fatalSpec && fatalSpec.provision) || envFatalUrl);
  const shouldPersistHigh = Boolean((highSpec && highSpec.provision) || envHighUrl);

  const changed = results.some((entry) => entry && (entry.status === 'created' || entry.status === 'replaced'))
    || config.telemetryWebhookUrl !== envDefaultUrl
    || (shouldPersistFatal && config.telemetryFatalWebhookUrl !== envFatalUrl)
    || (shouldPersistHigh && config.telemetryHighImpactWebhookUrl !== envHighUrl)
    || config.telemetryChannelId !== envChannelId;

  process.env.AECS_TELEMETRY_WEBHOOK_URL = config.telemetryWebhookUrl || '';
  if (shouldPersistFatal) {
    process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL = config.telemetryFatalWebhookUrl || '';
  }
  if (shouldPersistHigh) {
    process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH = config.telemetryHighImpactWebhookUrl || '';
  }
  process.env.AECS_TELEMETRY_CHANNEL_ID = config.telemetryChannelId || '';

  return {
    changed,
    skipped: false,
    reason: null,
    routes: results,
    config
  };
}

module.exports = {
  provisionTelemetryWebhooks,
  parseWebhookUrl,
  ensureUrlFromWebhook
};

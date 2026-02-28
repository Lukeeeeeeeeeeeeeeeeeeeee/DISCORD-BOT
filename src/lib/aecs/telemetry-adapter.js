const { sanitizeForDiscordSink } = require('./privacy-policy');

const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_IMPACT_THRESHOLD = 70;
const DEFAULT_SENSITIVE_KEY_PATTERN = /(token|secret|password|authorization|cookie|api[_-]?key|session|bearer)/i;

function asInt(value, fallback) {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function truncateText(value, maxLen = 1000) {
  if (value === undefined || value === null) return '';
  const text = String(value);
  if (text.length <= maxLen) return text;
  return `${text.slice(0, maxLen)}...[truncated]`;
}

function toSeverity(value) {
  const upper = String(value || '').toUpperCase();
  if (upper === 'FATAL' || upper === 'ERROR' || upper === 'WARN' || upper === 'INFO') return upper;
  return 'INFO';
}

function formatSupportLookup(template, supportId, channelId) {
  const safeSupportId = supportId || 'N/A';
  const safeChannelId = channelId || '';

  if (template) {
    return String(template)
      .split('{{supportId}}').join(safeSupportId)
      .split('{{channelId}}').join(safeChannelId);
  }

  if (safeSupportId === 'N/A') return 'No support id available';
  if (safeChannelId) return `Search <#${safeChannelId}> for \`${safeSupportId}\``;
  return `Search telemetry logs for \`${safeSupportId}\``;
}

function toHexColor(severity) {
  if (severity === 'FATAL') return 0xCC0000;
  if (severity === 'ERROR') return 0xE14D2A;
  if (severity === 'WARN') return 0xE8AA42;
  return 0x3388DD;
}

function toBoolean(value, fallback = false) {
  if (value === undefined || value === null) return fallback;
  if (typeof value === 'boolean') return value;
  const normalized = String(value).trim().toLowerCase();
  if (!normalized) return fallback;
  if (normalized === '1' || normalized === 'true' || normalized === 'yes' || normalized === 'on') return true;
  if (normalized === '0' || normalized === 'false' || normalized === 'no' || normalized === 'off') return false;
  return fallback;
}

function normalizeSensitiveKeyPattern(value) {
  if (!value) return DEFAULT_SENSITIVE_KEY_PATTERN;
  try {
    return new RegExp(String(value), 'i');
  } catch (_error) {
    return DEFAULT_SENSITIVE_KEY_PATTERN;
  }
}

class TelemetryAdapter {
  constructor(options = {}) {
    this.defaultWebhookUrl = options.defaultWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL || '';
    this.fatalWebhookUrl = options.fatalWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL || '';
    this.highImpactWebhookUrl = options.highImpactWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH || '';
    this.channelId = options.channelId || process.env.AECS_TELEMETRY_CHANNEL_ID || '';
    this.supportLookupTemplate = options.supportLookupTemplate || process.env.AECS_SUPPORT_LOOKUP_TEMPLATE || '';

    this.impactThreshold = asInt(
      options.impactThreshold || process.env.AECS_WEBHOOK_IMPACT_THRESHOLD,
      DEFAULT_IMPACT_THRESHOLD
    );
    this.timeoutMs = asInt(options.timeoutMs || process.env.AECS_TELEMETRY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
    this.includeStack = toBoolean(
      options.includeStack !== undefined ? options.includeStack : process.env.AECS_TELEMETRY_INCLUDE_STACK,
      false
    );
    this.includeInternal = toBoolean(
      options.includeInternal !== undefined ? options.includeInternal : process.env.AECS_TELEMETRY_INCLUDE_INTERNAL,
      false
    );
    this.includeSensitive = toBoolean(
      options.includeSensitive !== undefined ? options.includeSensitive : process.env.AECS_TELEMETRY_INCLUDE_SENSITIVE,
      false
    );
    this.sensitiveKeyPattern = normalizeSensitiveKeyPattern(
      options.sensitiveKeyPattern || process.env.AECS_TELEMETRY_SENSITIVE_KEY_PATTERN
    );
  }

  hasAnyWebhook() {
    return Boolean(this.defaultWebhookUrl || this.fatalWebhookUrl || this.highImpactWebhookUrl);
  }

  shouldSend(record) {
    if (!record) return false;
    const severity = toSeverity(record.severity);
    if (severity === 'FATAL') return true;
    return Number(record.impact || 0) >= this.impactThreshold;
  }

  resolveWebhook(record) {
    if (!record) return '';
    const severity = toSeverity(record.severity);
    const impact = Number(record.impact || 0);

    if (severity === 'FATAL' && this.fatalWebhookUrl) {
      return this.fatalWebhookUrl;
    }
    if (impact >= this.impactThreshold && this.highImpactWebhookUrl) {
      return this.highImpactWebhookUrl;
    }
    return this.defaultWebhookUrl;
  }

  buildPayload(record) {
    const severity = toSeverity(record.severity);
    const supportId = record.supportId || 'N/A';
    const supportLookup = formatSupportLookup(this.supportLookupTemplate, record.supportId, this.channelId);
    const privacyView = sanitizeForDiscordSink(record, {
      includeStack: this.includeStack,
      includeInternal: this.includeInternal,
      includeSensitive: this.includeSensitive,
      sensitiveKeyPattern: this.sensitiveKeyPattern
    });
    const metaPreview = truncateText(JSON.stringify(privacyView.meta || {}), 950);
    const stackPreview = privacyView.stack ? truncateText(privacyView.stack, 950) : '';

    const fields = [
      { name: 'Support ID', value: supportId, inline: true },
      { name: 'Trace ID', value: record.traceId || 'N/A', inline: true },
      { name: 'Severity', value: severity, inline: true },
      { name: 'Impact', value: String(record.impact || 0), inline: true },
      { name: 'Domain', value: record.domain || 'SYS', inline: true },
      { name: 'Scope', value: record.scope || 'runtime', inline: true },
      {
        name: 'Privacy',
        value: `public:${privacyView.privacy.public} internal:${privacyView.privacy.internal} sensitive:${privacyView.privacy.sensitive}`,
        inline: false
      },
      { name: 'Lookup', value: truncateText(supportLookup, 1000), inline: false }
    ];

    if (metaPreview && metaPreview !== '{}') {
      fields.push({ name: 'Meta', value: `\`\`\`json\n${metaPreview}\n\`\`\``, inline: false });
    }
    if (stackPreview) {
      fields.push({ name: 'Stack', value: `\`\`\`\n${stackPreview}\n\`\`\``, inline: false });
    }

    return {
      username: 'AECS Telemetry',
      content: `AECS ${severity} ${record.code} | Support ID: ${supportId}`,
      embeds: [
        {
          title: `${record.code} ${record.title || 'Codex Error'}`,
          description: truncateText(record.message || '', 3000),
          color: toHexColor(severity),
          timestamp: new Date(record.timestamp || Date.now()).toISOString(),
          fields
        }
      ]
    };
  }

  async send(record) {
    if (!this.hasAnyWebhook()) {
      return { sent: false, reason: 'disabled' };
    }
    if (!this.shouldSend(record)) {
      return { sent: false, reason: 'policy' };
    }

    const webhookUrl = this.resolveWebhook(record);
    if (!webhookUrl) {
      return { sent: false, reason: 'no_route' };
    }
    if (typeof this.fetchImpl !== 'function') {
      return { sent: false, reason: 'fetch_unavailable' };
    }

    const payload = this.buildPayload(record);
    const supportsAbort = typeof AbortController !== 'undefined';
    const controller = supportsAbort ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), Math.max(250, this.timeoutMs))
      : null;

    try {
      const response = await this.fetchImpl(webhookUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      });

      if (!response || response.ok === false) {
        const status = response && response.status ? response.status : 0;
        throw new Error(`AECS telemetry webhook failed with status ${status}`);
      }
    } finally {
      if (timer) clearTimeout(timer);
    }

    return { sent: true, reason: 'ok' };
  }
}

module.exports = { TelemetryAdapter };

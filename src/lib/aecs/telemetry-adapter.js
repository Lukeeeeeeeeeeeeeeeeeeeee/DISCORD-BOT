const DEFAULT_TIMEOUT_MS = 5000;
const DEFAULT_IMPACT_THRESHOLD = 70;

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

class TelemetryAdapter {
  constructor(options = {}) {
    this.defaultWebhookUrl = options.defaultWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL || '';
    this.secondaryWebhookUrl = options.secondaryWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_SECONDARY || '';
    this.fatalWebhookUrl = options.fatalWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL || '';
    this.fatalWebhookUrlSecondary = options.fatalWebhookUrlSecondary || process.env.AECS_TELEMETRY_WEBHOOK_URL_FATAL_SECONDARY || '';
    this.highImpactWebhookUrl = options.highImpactWebhookUrl || process.env.AECS_TELEMETRY_WEBHOOK_URL_HIGH || '';
    this.channelId = options.channelId || process.env.AECS_TELEMETRY_CHANNEL_ID || '';
    this.supportLookupTemplate = options.supportLookupTemplate || process.env.AECS_SUPPORT_LOOKUP_TEMPLATE || '';

    this.impactThreshold = asInt(
      options.impactThreshold || process.env.AECS_WEBHOOK_IMPACT_THRESHOLD,
      DEFAULT_IMPACT_THRESHOLD
    );
    this.timeoutMs = asInt(options.timeoutMs || process.env.AECS_TELEMETRY_TIMEOUT_MS, DEFAULT_TIMEOUT_MS);
    this.fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  }

  hasAnyWebhook() {
    return Boolean(
      this.defaultWebhookUrl || 
      this.secondaryWebhookUrl || 
      this.fatalWebhookUrl || 
      this.fatalWebhookUrlSecondary || 
      this.highImpactWebhookUrl
    );
  }

  shouldSend(record) {
    if (!record) return false;
    const severity = toSeverity(record.severity);
    if (severity === 'FATAL') return true;
    return Number(record.impact || 0) >= this.impactThreshold;
  }

  resolveWebhooks(record) {
    if (!record) return [];
    const severity = toSeverity(record.severity);
    const impact = Number(record.impact || 0);

    const targets = [];

    // FATAL DISPATCH: Send to both primary and secondary if available
    if (severity === 'FATAL') {
      if (this.fatalWebhookUrl) targets.push(this.fatalWebhookUrl);
      if (this.fatalWebhookUrlSecondary) targets.push(this.fatalWebhookUrlSecondary);
      
      // If no fatal webhooks exist, fallback to default/secondary
      if (targets.length === 0) {
        if (this.defaultWebhookUrl) targets.push(this.defaultWebhookUrl);
        if (this.secondaryWebhookUrl) targets.push(this.secondaryWebhookUrl);
      }
      return targets;
    }

    // HIGH IMPACT DISPATCH
    if (impact >= this.impactThreshold && this.highImpactWebhookUrl) {
      return [this.highImpactWebhookUrl];
    }

    // DEFAULT DISPATCH + SECONDARY FALLBACK (handled in send() for non-fatal)
    return [this.defaultWebhookUrl, this.secondaryWebhookUrl].filter(Boolean);
  }

  buildPayload(record) {
    const severity = toSeverity(record.severity);
    const supportId = record.supportId || 'N/A';
    const supportLookup = formatSupportLookup(this.supportLookupTemplate, record.supportId, this.channelId);
    const metaPreview = truncateText(JSON.stringify(record.meta || {}), 950);
    const stackPreview = truncateText(record.stack || '', 950);

    const fields = [
      { name: 'Support ID', value: supportId, inline: true },
      { name: 'Trace ID', value: record.traceId || 'N/A', inline: true },
      { name: 'Severity', value: severity, inline: true },
      { name: 'Impact', value: String(record.impact || 0), inline: true },
      { name: 'Domain', value: record.domain || 'SYS', inline: true },
      { name: 'Scope', value: record.scope || 'runtime', inline: true },
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

  async sendToWebhook(url, payload) {
    if (!url || typeof this.fetchImpl !== 'function') return false;

    const supportsAbort = typeof AbortController !== 'undefined';
    const controller = supportsAbort ? new AbortController() : null;
    const timer = controller
      ? setTimeout(() => controller.abort(), Math.max(250, this.timeoutMs))
      : null;

    try {
      const response = await this.fetchImpl(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller ? controller.signal : undefined
      });

      if (!response || response.ok === false) {
        const status = response && response.status ? response.status : 0;
        // 404/403/410 means the channel/webhook is gone or restricted. 
        // We report false to trigger fallback.
        if (status === 404 || status === 403 || status === 410) {
          return false;
        }
        throw new Error(`AECS telemetry webhook failed with status ${status}`);
      }
      return true;
    } catch (e) {
      // If it's an abort or network error, we treat it as failure to trigger fallback
      return false;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  async send(record) {
    if (!this.hasAnyWebhook()) {
      return { sent: false, reason: 'disabled' };
    }
    if (!this.shouldSend(record)) {
      return { sent: false, reason: 'policy' };
    }

    const targets = this.resolveWebhooks(record);
    if (targets.length === 0) {
      return { sent: false, reason: 'no_route' };
    }

    const payload = this.buildPayload(record);
    const severity = toSeverity(record.severity);

    // FATAL/HIGH IMPACT DUAL DISPATCH (TRY ALL)
    if (severity === 'FATAL') {
      const results = await Promise.all(targets.map(url => this.sendToWebhook(url, payload)));
      const anyOk = results.some(r => r === true);
      return { sent: anyOk, reason: anyOk ? 'ok' : 'failed_all' };
    }

    // STANDARD DISPATCH WITH FALLBACK
    for (const url of targets) {
      const ok = await this.sendToWebhook(url, payload);
      if (ok) {
        return { sent: true, reason: 'ok' };
      }
      // If primary failed (404/403 etc), loop continues to secondary...
    }

    return { sent: false, reason: 'failed_all' };
  }
}

module.exports = { TelemetryAdapter };

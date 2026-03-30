const SECRET_RE = /[a-zA-Z0-9_-]{24,32}\.[a-zA-Z0-9_-]{6,12}\.[a-zA-Z0-9_-]{27,45}|[a-zA-Z0-9_-]{70,}/g;
const BLACKLISTED_KEYS = new Set(['token', 'secret', 'password', 'key', 'auth', 'authorization', 'api_key', 'apikey']);

function isPlainObject(value) {
  if (!value || typeof value !== 'object') return false;
  return Object.getPrototypeOf(value) === Object.prototype;
}

function sanitizeString(value, maxLength = 4000) {
  let text = String(value);
  // Mask potential tokens/secrets
  text = text.replace(SECRET_RE, '[SCRUBBED]');
  
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}...[truncated]`;
}

function sanitizePrimitive(value) {
  if (value === null || value === undefined) return null;
  const type = typeof value;
  if (type === 'string') return sanitizeString(value);
  if (type === 'number') return Number.isFinite(value) ? value : null;
  if (type === 'boolean') return value;
  if (type === 'bigint') {
    const asNumber = Number(value);
    if (Number.isSafeInteger(asNumber)) return asNumber;
    return sanitizeString(value);
  }
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) return sanitizeString(value.message || value.name || 'Error');
  if (Array.isArray(value)) {
    const output = [];
    const max = Math.min(value.length, 25);
    for (let i = 0; i < max; i += 1) {
      output.push(sanitizePrimitive(value[i]));
    }
    return output;
  }
  return '[Object]';
}

function shouldSkipKey(key) {
  if (!key) return true;
  const lower = key.toLowerCase();
  for (const black of BLACKLISTED_KEYS) {
    if (lower.includes(black)) return true;
  }
  return false;
}

function sanitizeBySchema(meta, schema) {
  if (!isPlainObject(schema)) return {};
  const input = isPlainObject(meta) ? meta : {};
  const output = {};
  for (const key of Object.keys(schema)) {
    if (shouldSkipKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    const fieldType = schema[key];
    const value = input[key];
    if (fieldType === 'string') {
      if (value === null || value === undefined) {
        output[key] = null;
      } else {
        output[key] = sanitizeString(value);
      }
      continue;
    }
    if (fieldType === 'number') {
      const n = Number(value);
      output[key] = Number.isFinite(n) ? n : null;
      continue;
    }
    if (fieldType === 'boolean') {
      output[key] = Boolean(value);
      continue;
    }
    if (fieldType === 'pruned_string') {
      if (value === null || value === undefined) {
        output[key] = null;
      } else if (typeof value === 'object') {
        output[key] = '[Object Rejected By Schema]';
      } else {
        output[key] = sanitizeString(value);
      }
      continue;
    }
    output[key] = sanitizePrimitive(value);
  }
  return output;
}

function sanitizeBySafeKeys(meta, safeMetaKeys) {
  const input = isPlainObject(meta) ? meta : {};
  const output = {};
  const keys = Array.isArray(safeMetaKeys) ? safeMetaKeys : [];
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(input, key)) continue;
    if (shouldSkipKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = sanitizePrimitive(input[key]);
  }
  return output;
}

function sanitizeMeta(meta, definition) {
  if (definition && isPlainObject(definition.schema)) {
    return sanitizeBySchema(meta, definition.schema);
  }
  if (definition && Array.isArray(definition.safeMetaKeys)) {
    return sanitizeBySafeKeys(meta, definition.safeMetaKeys);
  }
  if (!isPlainObject(meta)) return {};
  const output = {};
  const keys = Object.keys(meta).slice(0, 20);
  for (const key of keys) {
    if (shouldSkipKey(key)) {
      output[key] = '[REDACTED]';
      continue;
    }
    output[key] = sanitizePrimitive(meta[key]);
  }
  return output;
}

function normalizeSeverity(value) {
  const normalized = String(value || 'ERROR').toUpperCase();
  if (normalized === 'INFO' || normalized === 'WARN' || normalized === 'ERROR' || normalized === 'FATAL') {
    return normalized;
  }
  return 'ERROR';
}

function clampImpact(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 50;
  if (n < 0) return 0;
  if (n > 100) return 100;
  return Math.round(n);
}

module.exports = {
  sanitizeMeta,
  sanitizePrimitive,
  normalizeSeverity,
  clampImpact,
  isPlainObject
};

module.exports = {
  sanitizeMeta,
  sanitizePrimitive,
  normalizeSeverity,
  clampImpact,
  isPlainObject
};

/**
 * Environmental Variable Utilities [v1.0.0]
 */
'use strict';

/**
 * Parse an environment variable as a positive integer with safety bounds.
 */
function envInt(key, fallback, min = 0, max = Number.MAX_SAFE_INTEGER) {
    const raw = process.env[key];
    if (raw === undefined || raw === null || raw.trim() === '') return fallback;
    const v = Number.parseInt(raw, 10);
    if (!Number.isFinite(v)) return fallback;
    return Math.min(max, Math.max(min, v));
}

/**
 * Parse an environment variable as a boolean.
 */
function envBool(key, fallback = false) {
    const raw = process.env[key];
    if (raw === undefined || raw === null || raw.trim() === '') return fallback;
    return raw.toLowerCase() === 'true' || raw === '1';
}

module.exports = { envInt, envBool };

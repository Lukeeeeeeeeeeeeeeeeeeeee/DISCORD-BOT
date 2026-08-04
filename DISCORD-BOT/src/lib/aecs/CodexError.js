const dictionaries = require('./dictionaries');

function normalizeCode(code) {
  if (!code) return 'SYS-001';
  return String(code).trim().toUpperCase();
}

class CodexError extends Error {
  constructor(code, meta = {}, options = {}) {
    const requestedCode = normalizeCode(code);
    let definition = dictionaries.getDefinition(requestedCode);
    const fallbackMeta = {};

    if (!definition) {
      fallbackMeta.invalidCode = requestedCode;
      definition = dictionaries.getDefinition('SYS-001');
    }

    const finalCode = definition && definition === dictionaries.getDefinition(requestedCode)
      ? requestedCode
      : 'SYS-001';

    const message = options.message || (definition && definition.title) || 'Codex error';
    super(message);

    this.name = 'CodexError';
    this.code = finalCode;
    this.version = definition && definition.version ? definition.version : 'unknown';
    this.definition = definition || null;
    this.meta = { ...fallbackMeta, ...(meta || {}) };
    this.timestamp = Date.now();
    this.originalError = options.originalError || this.meta.originalError || null;
    this.isCodexError = true;

    if (this.originalError instanceof Error) {
      this.originalName = this.originalError.name;
      this.originalMessage = this.originalError.message;
    }

    Error.captureStackTrace(this, CodexError);
    // Freeze stack snapshot to avoid accidental mutation downstream.
    if (typeof this.stack === 'string') {
      Object.defineProperty(this, 'frozenStack', {
        value: this.stack,
        enumerable: false,
        writable: false,
        configurable: false
      });
    }
  }

  static fromUnknown(error, code = 'SYS-500', meta = {}) {
    if (error instanceof CodexError) return error;

    const errorMeta = { ...meta };
    if (error instanceof Error) {
      errorMeta.name = error.name;
      errorMeta.message = error.message;
      if (error.code !== undefined) errorMeta.errorCode = error.code;
      return new CodexError(code, errorMeta, {
        message: error.message || undefined,
        originalError: error
      });
    }

    errorMeta.message = String(error);
    return new CodexError(code, errorMeta, { message: String(error) });
  }
}

module.exports = CodexError;

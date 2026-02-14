class AppError extends Error {
  constructor(message, opts = {}) {
    super(message);
    this.name = 'AppError';
    this.code = opts.code || 'APP_ERROR';
    this.userMessage = opts.userMessage || message || 'Error';
    this.title = opts.title || 'Error';
    this.details = opts.details || null;
    this.expose = opts.expose !== false;
  }
}

function isAppError(err) {
  return !!(err && (err instanceof AppError || err.name === 'AppError'));
}

module.exports = { AppError, isAppError };

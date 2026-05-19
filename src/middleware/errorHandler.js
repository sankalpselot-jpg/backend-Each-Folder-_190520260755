/**
 * middleware/errorHandler.js
 * 
 * Centralized error handling for the entire Express app.
 * 
 * All unhandled errors flow here via next(err).
 * Returns structured JSON — never leaks stack traces in production.
 */

const logger = require('../utils/logger');

// ─── 404 Handler ─────────────────────────────────────────────────────────────
/**
 * Catch-all for routes that don't exist.
 * Must be placed AFTER all valid routes.
 */
const notFound = (req, res, next) => {
  const err = new Error(`Route not found: ${req.method} ${req.originalUrl}`);
  err.statusCode = 404;
  next(err);
};

// ─── Global Error Handler ─────────────────────────────────────────────────────
/**
 * Express error handler (4 arguments = error handler).
 * Handles all errors passed via next(err).
 */
const errorHandler = (err, req, res, next) => {
  // Default to 500 if no status code set on the error
  const statusCode = err.statusCode || err.status || 500;

  // Log error with context (but not for 404s — those are noisy)
  if (statusCode >= 500) {
    logger.error('Unhandled server error:', {
      message: err.message,
      stack: err.stack,
      path: req.originalUrl,
      method: req.method,
      userId: req.user?.id,
    });
  } else if (statusCode !== 404) {
    logger.warn('Client error:', {
      message: err.message,
      statusCode,
      path: req.originalUrl,
    });
  }

  // Build response — never expose stack traces in production
  const response = {
    success: false,
    message: statusCode >= 500 && process.env.NODE_ENV === 'production'
      ? 'An internal server error occurred. Please try again later.'
      : err.message,
  };

  // Include validation errors if present (from express-validator)
  if (err.errors) {
    response.errors = err.errors;
  }

  res.status(statusCode).json(response);
};

module.exports = { notFound, errorHandler };
